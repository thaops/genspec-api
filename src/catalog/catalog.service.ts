import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NormComponent, NormItem, PriceItem, PriceSet } from './catalog-db.schemas';
import { CATALOG } from './catalog.seed';
import { CatalogItem, CatalogSearchResult } from './catalog.types';
import { extractProvinceFromText } from './province-aliases';

export interface ReferenceBlockResult {
  text: string;
  /** Nguồn giá tỉnh chính thống đã khớp — để cưỡng chế vào proposal sources (type: government). */
  priceSources: { title: string; type: 'government' }[];
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly items: CatalogItem[] = CATALOG;

  constructor(
    @InjectModel(NormItem.name) private readonly norms: Model<NormItem>,
    @InjectModel(PriceSet.name) private readonly priceSets: Model<PriceSet>,
    @InjectModel(PriceItem.name) private readonly priceItems: Model<PriceItem>,
  ) {}

  all(): CatalogItem[] {
    return this.items;
  }

  /** norm_items (code prefix + text) TRƯỚC → fallback seed. Kèm giá tỉnh nếu có. */
  async search(q?: string, limit = 20, province?: string): Promise<CatalogSearchResult[]> {
    if (!q || !q.trim()) return this.searchSeed(q, limit);

    let normHits: NormItem[] = [];
    try {
      const esc = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const byPrefix = await this.norms.find({ code: new RegExp(`^${esc}`, 'i') }).limit(limit).lean<NormItem[]>();
      const remain = limit - byPrefix.length;
      const byText =
        remain > 0
          ? await this.norms
              .find({ $text: { $search: q }, _id: { $nin: byPrefix.map((n) => n._id) } })
              .limit(remain)
              .lean<NormItem[]>()
          : [];
      normHits = [...byPrefix, ...byText];
    } catch (err) {
      this.logger.warn(`norm search failed, fallback seed: ${(err as Error).message}`);
    }

    if (normHits.length === 0) return this.searchSeed(q, limit);

    const priceCtx = await this.loadPriceContext(province);
    const mapped = normHits.map((n) => this.toResult(n, priceCtx));
    if (mapped.length < limit) {
      const seedExtra = this.searchSeed(q, limit - mapped.length).filter(
        (s) => !mapped.some((m) => m.code.toLowerCase() === s.code.toLowerCase()),
      );
      mapped.push(...seedExtra);
    }
    return mapped;
  }

  findByCode(code: string): CatalogItem | undefined {
    return this.items.find((it) => it.code.toLowerCase() === code.toLowerCase());
  }

  /**
   * Khối tham chiếu định mức + đơn giá tỉnh cho prompt agent.
   * Trả '' nếu chưa có dữ liệu import khớp.
   */
  async referenceBlock(message: string, location?: string, max = 10): Promise<ReferenceBlockResult> {
    const empty: ReferenceBlockResult = { text: '', priceSources: [] };
    try {
      const codes = Array.from(new Set(message.match(/[A-Za-z]{2,3}[.\-]?\d{4,}/g) ?? []));
      const byCode = codes.length
        ? await this.norms.find({ code: { $in: codes.map((c) => new RegExp(`^${c}`, 'i')) } }).limit(max).lean<NormItem[]>()
        : [];
      const remain = max - byCode.length;
      const keywords = message.replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
      const byText =
        remain > 0 && keywords
          ? await this.norms
              .find({ $text: { $search: keywords }, _id: { $nin: byCode.map((n) => n._id) } })
              .sort({ score: { $meta: 'textScore' } })
              .limit(remain)
              .lean<NormItem[]>()
          : [];
      const hits = [...byCode, ...byText];
      if (hits.length === 0) return empty;

      // Ưu tiên: tỉnh trong message > projectInfo.location > không match
      const province = await this.matchProvince(message, location);
      const priceCtx = await this.loadPriceContext(province ?? undefined);

      const lines = hits.map((n) => {
        const comps = (n.components ?? [])
          .map((c) => {
            const price = priceCtx ? this.lookupPrice(c, priceCtx.prices) : undefined;
            const p = price != null ? ` × ${Math.round(price).toLocaleString('vi-VN')}đ` : '';
            return `${c.kind === 'material' ? 'VL' : c.kind === 'labor' ? 'NC' : 'M'} ${c.name}: ${c.norm} ${c.unit}${p}`;
          })
          .join('; ');
        return `- ${n.code} | ${n.name} | ${n.unit} | nguồn ${n.sourceDoc || 'import'}${comps ? `\n  Hao phí: ${comps}` : ''}`;
      });
      const head = priceCtx
        ? `(Đơn giá tỉnh ${priceCtx.set.province}, hiệu lực ${priceCtx.set.effectiveDate.toISOString().slice(0, 10)}, nguồn ${priceCtx.set.sourceDoc || 'import'})`
        : '(Chưa có công bố giá tỉnh khớp — chỉ có định mức hao phí)';
      const priceSources: ReferenceBlockResult['priceSources'] = priceCtx
        ? [{ title: `${priceCtx.set.sourceDoc || 'Công bố giá'} — ${priceCtx.set.province}`, type: 'government' }]
        : [];
      return { text: [head, ...lines].join('\n'), priceSources };
    } catch (err) {
      this.logger.warn(`referenceBlock skipped: ${(err as Error).message}`);
      return empty;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private searchSeed(q: string | undefined, limit: number): CatalogSearchResult[] {
    const base = !q || !q.trim()
      ? this.items.slice(0, limit)
      : this.items
          .filter((it) => {
            const needle = this.normalize(q);
            return (
              this.normalize(it.code).includes(needle) ||
              this.normalize(it.name).includes(needle) ||
              this.normalize(it.group).includes(needle)
            );
          })
          .slice(0, limit);
    return base.map((it) => ({ ...it, source: 'seed' as const }));
  }

  private async loadPriceContext(
    province?: string,
  ): Promise<{ set: PriceSet; prices: PriceItem[] } | null> {
    if (!province?.trim()) return null;
    try {
      const set = await this.priceSets
        .findOne({ province: new RegExp(`^${province.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
        .sort({ effectiveDate: -1 })
        .lean<PriceSet>();
      if (!set) return null;
      const prices = await this.priceItems.find({ priceSetId: set._id as Types.ObjectId }).lean<PriceItem[]>();
      return { set, prices };
    } catch {
      return null;
    }
  }

  private lookupPrice(comp: NormComponent, prices: PriceItem[]): number | undefined {
    if (comp.refCode) {
      const byRef = prices.find((p) => p.refCode && p.refCode.toLowerCase() === comp.refCode!.toLowerCase());
      if (byRef) return byRef.price;
    }
    const n = this.normalize(comp.name);
    const byName = prices.find((p) => {
      const pn = this.normalize(p.name);
      return pn === n || pn.includes(n) || n.includes(pn);
    });
    return byName?.price;
  }

  private toResult(n: NormItem, priceCtx: { set: PriceSet; prices: PriceItem[] } | null): CatalogSearchResult {
    let material = 0;
    let labor = 0;
    let machine = 0;
    if (priceCtx) {
      for (const c of n.components ?? []) {
        const price = this.lookupPrice(c, priceCtx.prices);
        if (price == null) continue;
        const cost = c.norm * price;
        if (c.kind === 'material') material += cost;
        else if (c.kind === 'labor') labor += cost;
        else machine += cost;
      }
    }
    return {
      code: n.code,
      name: n.name,
      unit: n.unit,
      group: n.group,
      material: Math.round(material),
      labor: Math.round(labor),
      machine: Math.round(machine),
      source: n.sourceDoc || 'import',
      province: priceCtx?.set.province,
      components: n.components,
    };
  }

  /**
   * Tìm tỉnh có price_sets trong DB. Ưu tiên tỉnh nhắc trong message,
   * rồi tới projectInfo.location; chỉ trả tỉnh THẬT SỰ có dữ liệu (distinct).
   */
  private async matchProvince(message?: string, location?: string): Promise<string | null> {
    if (!message?.trim() && !location?.trim()) return null;
    try {
      const provinces = (await this.priceSets.distinct('province')) as string[];
      if (!provinces.length) return null;

      const canonical = extractProvinceFromText(message) ?? extractProvinceFromText(location);
      if (canonical) {
        const hit = provinces.find(
          (p) => extractProvinceFromText(p) === canonical || this.normalize(p) === this.normalize(canonical),
        );
        if (hit) return hit;
      }

      // Fallback: match thô theo location (hành vi cũ)
      if (location?.trim()) {
        const loc = this.normalize(location);
        return provinces.find((p) => loc.includes(this.normalize(p))) ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  private normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd');
  }
}
