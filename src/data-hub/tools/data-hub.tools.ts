import { CatalogDbService } from '../catalog/catalog-db.service';
import { PriceService } from '../prices/price.service';
import { DocumentService } from '../documents/document.service';

/**
 * Module 9 — Tool API
 * AI agent calls these functions ONLY. Never queries MongoDB directly.
 */
export function buildDataHubTools(
  catalog: CatalogDbService,
  price: PriceService,
  documents: DocumentService,
) {
  return {
    // ── Catalog Tools ────────────────────────────────────────────────────
    'catalog.searchCode': async (args: { q: string; limit?: number }) => {
      const items = await catalog.suggest(args.q, args.limit ?? 10);
      return items.map((c: any) => ({
        code: c.code, name: c.name, unit: c.unit, group: c.group,
        material: c.material, labor: c.labor, machine: c.machine,
        trust: c.trust, sourceId: c.sourceId,
      }));
    },

    'catalog.searchKeyword': async (args: { keyword: string; limit?: number }) => {
      const items = await catalog.searchKeyword(args.keyword, args.limit ?? 20);
      return items.map((c: any) => ({
        code: c.code, name: c.name, unit: c.unit, group: c.group,
        material: c.material, labor: c.labor, machine: c.machine,
      }));
    },

    'catalog.findByCode': async (args: { code: string }) => {
      const c = await catalog.findByCode(args.code) as any;
      if (!c) return null;
      return {
        code: c.code, name: c.name, unit: c.unit, group: c.group,
        material: c.material, labor: c.labor, machine: c.machine,
        trust: c.trust, sourceId: c.sourceId, effectiveDate: c.effectiveDate,
      };
    },

    // ── Price Tools ──────────────────────────────────────────────────────
    'price.latest': async (args: { materialId: string; province?: string }) => {
      return price.latest(args.materialId, args.province);
    },

    'price.compare': async (args: {
      items: Array<{ materialId: string; name: string; unit: string; currentPrice: number }>;
      province?: string;
    }) => {
      return price.compare(args.items, args.province);
    },

    'price.searchByName': async (args: { name: string; province?: string; limit?: number }) => {
      return price.searchByName(args.name, args.province, args.limit ?? 10);
    },

    // ── Document Tools ───────────────────────────────────────────────────
    'document.find': async (args: { q: string; docType?: string; province?: string; limit?: number }) => {
      return documents.find(args.q, args.docType as any, args.province, args.limit ?? 5);
    },

    'document.findByNumber': async (args: { number: string }) => {
      return documents.findByNumber(args.number);
    },

    // ── Review Tools ─────────────────────────────────────────────────────
    'review.checkFormula': async (args: { formula: string; expectedUnit: string }) => {
      // Basic formula integrity: check units are consistent
      const hasVL = /VL|vật liệu|material/i.test(args.formula);
      const hasNC = /NC|nhân công|labor/i.test(args.formula);
      const hasMTC = /MTC|máy|machine/i.test(args.formula);
      return {
        formula: args.formula,
        hasVL, hasNC, hasMTC,
        isComplete: hasVL && hasNC && hasMTC,
        note: !hasVL ? 'Thiếu chi phí vật liệu (VL)'
          : !hasNC ? 'Thiếu chi phí nhân công (NC)'
          : !hasMTC ? 'Thiếu chi phí máy thi công (MTC)'
          : 'Công thức đầy đủ',
      };
    },

    'review.detectDuplicate': async (args: { codes: string[] }) => {
      const seen = new Map<string, number[]>();
      args.codes.forEach((c, i) => {
        if (!seen.has(c)) seen.set(c, []);
        seen.get(c)!.push(i);
      });
      const duplicates = Array.from(seen.entries())
        .filter(([, idxs]) => idxs.length > 1)
        .map(([code, indices]) => ({ code, indices }));
      return { hasDuplicates: duplicates.length > 0, duplicates };
    },

    'review.detectMissing': async (args: { codes: string[] }) => {
      const missing: Array<{ code: string; reason: string }> = [];
      for (const code of args.codes) {
        const found = await catalog.findByCode(code);
        if (!found) missing.push({ code, reason: 'Không tìm thấy trong catalog' });
      }
      return { hasMissing: missing.length > 0, missing };
    },
  } as const;
}

export type DataHubToolName = keyof ReturnType<typeof buildDataHubTools>;
