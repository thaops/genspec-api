// Tra ĐƠN GIÁ thi công/vật tư từ WEB khi chưa có công bố giá tỉnh — CHỐNG BỊA:
//   Rào 1: chỉ tin text có grounding sources (googleSearch). Không source → vứt.
//   Rào 2: đơn giá phải là số DƯƠNG trong khoảng hợp lý (1k–100 triệu / đơn vị).
//   Rào 3: con số phải xuất hiện NGUYÊN VĂN trong text grounded (kể cả dạng
//          "40.000", "40,000", "40 000") — model trích ngoài văn bản → loại.
//   Extract bằng generateJson (temp thấp, thinking off), cấm dùng kiến thức riêng.
//   Giá web LUÔN gắn cờ "cần kiểm chứng" + trả source link — KHÔNG coi là chính thống.
// Kill-switch: env PRICE_WEB_LOOKUP=off.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { normalizeWorkName } from './norm-web-lookup.service';

// ===== Pure guardrails =====

/** Khoảng đơn giá hợp lý (VNĐ/đơn vị) — chặn số rác 0/âm/quá lớn. */
export const PRICE_MIN = 1_000;
export const PRICE_MAX = 100_000_000;

export function priceInRange(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= PRICE_MIN && v <= PRICE_MAX;
}

/**
 * Con số có xuất hiện nguyên văn trong text grounded không — chấp nhận các dạng
 * phân tách nghìn phổ biến VN (40000 / 40.000 / 40,000 / 40 000). PURE.
 */
export function priceAppearsInText(vnd: number, text: string): boolean {
  if (!text) return false;
  const digits = String(Math.round(vnd));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '#');
  const variants = [
    digits,
    grouped.replace(/#/g, '.'),
    grouped.replace(/#/g, ','),
    grouped.replace(/#/g, ' '),
  ];
  const t = text.replace(/\s+/g, ' ');
  return variants.some((v) => t.includes(v));
}

/** Rút các số từ chuỗi giá (vd "50.000 - 60.000" → [50000, 60000]). PURE. */
export function parseNumbers(s: string): number[] {
  const out: number[] = [];
  for (const m of (s || '').matchAll(/\d[\d.,\s]*\d|\d/g)) {
    const n = Number(m[0].replace(/[.,\s]/g, ''));
    if (isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * Guard chống bịa cho BATCH: unitPriceVnd trong khoảng hợp lý, VÀ ít nhất 1 con
 * số trong rawPrice (chuỗi trích literal) xuất hiện nguyên văn trong text grounded
 * → đảm bảo giá bắt nguồn từ web, cho phép unitPriceVnd là mức phổ biến/midpoint
 * của một khoảng có thật (midpoint không nhất thiết literal). PURE.
 */
export function groundedBatchPrice(unitPriceVnd: unknown, rawPrice: string, text: string): boolean {
  if (!priceInRange(unitPriceVnd)) return false;
  const nums = parseNumbers(rawPrice);
  if (nums.length === 0) return priceAppearsInText(unitPriceVnd as number, text);
  return nums.some((n) => priceInRange(n) && priceAppearsInText(n, text));
}

/** Query grounded search cho đơn giá 1 công tác tại 1 tỉnh. PURE. */
export function buildPriceQuery(workName: string, unit: string, province?: string): string {
  const wn = normalizeWorkName(workName);
  const loc = province ? `tại ${province}` : 'tại Việt Nam';
  return (
    `Đơn giá thi công (bao gồm nhân công + vật liệu) công tác "${wn}" ${loc} năm 2025, ` +
    `đơn vị tính ${unit}, bằng VNĐ. Nêu CON SỐ cụ thể (vd 40.000/m2) và trích nguồn. ` +
    `Nếu là khoảng giá, lấy mức phổ biến.`
  );
}

// ===== Types =====

export interface WebPriceHit {
  unitPrice: number;
  sourceTitle?: string;
  sourceUri?: string;
}

export interface WebPriceQuery {
  key: string;
  workName: string;
  unit: string;
}

// ===== Mongo cache =====

@Schema({ collection: 'web_price_cache' })
export class WebPriceCache {
  @Prop({ required: true, unique: true })
  key!: string; // `${province|-}|${workName chuẩn hoá}|${unit}`

  @Prop({ type: Object, default: null })
  hit!: WebPriceHit | null;

  @Prop({ type: [Object], default: [] })
  sources!: { title?: string; uri?: string }[];

  @Prop({ default: () => new Date() })
  createdAt!: Date;

  @Prop({ required: true, index: { expireAfterSeconds: 0 } })
  expireAt!: Date;
}
export const WebPriceCacheSchema = SchemaFactory.createForClass(WebPriceCache);

const HIT_TTL_MS = 7 * 24 * 3600 * 1000;
const MISS_TTL_MS = 15 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 40000;

const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    unitPriceVnd: { type: 'NUMBER' },
    rawPrice: { type: 'STRING' }, // trích literal từ text để đối chiếu
  },
  required: ['found'],
};

// Batch: 1 research + 1 extract cho CẢ danh sách công tác → 2 call tổng (thay vì
// 2/công tác) → tránh 429 quota, điền được nhiều dòng.
const BATCH_EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          work: { type: 'STRING' },
          unitPriceVnd: { type: 'NUMBER' },
          rawPrice: { type: 'STRING' },
        },
        required: ['work', 'unitPriceVnd'],
      },
    },
  },
  required: ['items'],
};

@Injectable()
export class PriceWebLookupService {
  private readonly logger = new Logger(PriceWebLookupService.name);

  constructor(
    private readonly ai: AiService,
    private readonly config: ConfigService,
    @InjectModel(WebPriceCache.name) private readonly cacheModel: Model<WebPriceCache>,
  ) {}

  get enabled(): boolean {
    return this.config.get<string>('PRICE_WEB_LOOKUP') !== 'off' && this.ai.available;
  }

  /**
   * Tra đơn giá cho nhiều công tác với CONCURRENCY GIỚI HẠN (không burst) — key
   * Gemini free tier hết quota (429) nếu bắn 9 lookup×2 call cùng lúc. Chạy pool
   * nhỏ + cache: mỗi lần bóc điền được vài dòng, cache lại → lần sau đỡ tốn quota,
   * dần dần đủ. Bật billing thì tăng POOL lên cho nhanh. Lỗi → null (không throw).
   */
  async lookupPrices(
    queries: WebPriceQuery[],
    province?: string,
  ): Promise<Map<string, WebPriceHit | null>> {
    const out = new Map<string, WebPriceHit | null>();
    if (!this.enabled || queries.length === 0) {
      queries.forEach((q) => out.set(q.key, null));
      return out;
    }
    const POOL = Number(this.config.get<string>('PRICE_WEB_CONCURRENCY') ?? 2);
    let idx = 0;
    const worker = async () => {
      for (;;) {
        const i = idx++;
        if (i >= queries.length) return;
        const q = queries[i];
        const v = await Promise.race([
          this.lookupOne(q, province).catch(() => null),
          new Promise<WebPriceHit | null>((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS)),
        ]);
        out.set(q.key, v);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, POOL) }, () => worker()));
    return out;
  }

  /**
   * BATCH: 1 grounded search + 1 extract cho TẤT CẢ công tác → 2 call tổng.
   * Chống 429 quota (thay vì 2 call/công tác). Guard grounded per-item.
   */
  async lookupPricesBatch(
    queries: WebPriceQuery[],
    province?: string,
  ): Promise<Map<string, WebPriceHit | null>> {
    const out = new Map<string, WebPriceHit | null>();
    queries.forEach((q) => out.set(q.key, null));
    if (!this.enabled || queries.length === 0) return out;

    const loc = province ? `tại ${province}` : 'tại Việt Nam';
    const names = queries.map((q) => `${normalizeWorkName(q.workName)} (${q.unit})`).join(', ');
    const query =
      `Bảng đơn giá thi công (nhân công + vật liệu) các công tác xây dựng/hoàn thiện nhà ${loc} năm 2025, VNĐ. ` +
      `Danh sách: ${names}. Nêu CON SỐ cụ thể từng công tác và trích nguồn.`;
    try {
      const research = await Promise.race([
        this.ai.research(query),
        new Promise<{ text: string; sources: { title?: string; uri?: string }[] }>((r) =>
          setTimeout(() => r({ text: '', sources: [] }), LOOKUP_TIMEOUT_MS),
        ),
      ]);
      if (research.sources.length === 0 || !research.text) {
        this.logger.log(`[WebPriceBatch] ${queries.length} works → sources=0 (grounding fail/429)`);
        return out;
      }
      const raw = await this.ai.generateJson(
        [
          {
            text:
              `Từ đoạn văn (kết quả tra web), trích ĐƠN GIÁ VNĐ cho từng công tác trong danh sách: ` +
              `[${queries.map((q) => normalizeWorkName(q.workName)).join(', ')}]. ` +
              `Trả items = mảng {work, unitPriceVnd (số; khoảng thì lấy mức phổ biến), rawPrice (chuỗi giá nguyên văn)}. ` +
              `CHỈ công tác có số rõ trong đoạn văn; không có → bỏ qua. TUYỆT ĐỐI không bịa.\n\n--- ĐOẠN VĂN ---\n${research.text}`,
          },
        ],
        BATCH_EXTRACT_SCHEMA,
      );
      const parsed = JSON.parse(raw) as { items?: { work?: string; unitPriceVnd?: number; rawPrice?: string }[] };
      const items = parsed.items ?? [];
      let filled = 0;
      for (const q of queries) {
        const wn = normalizeWorkName(q.workName);
        const it = items.find((x) => {
          const xw = normalizeWorkName(String(x.work ?? ''));
          return xw && (xw.includes(wn) || wn.includes(xw));
        });
        if (it && groundedBatchPrice(it.unitPriceVnd, String(it.rawPrice ?? ''), research.text)) {
          out.set(q.key, {
            unitPrice: Math.round(it.unitPriceVnd as number),
            sourceTitle: research.sources[0]?.title,
            sourceUri: research.sources[0]?.uri,
          });
          filled++;
        }
      }
      this.logger.log(`[WebPriceBatch] ${queries.length} works → sources=${research.sources.length}, filled=${filled}`);
      // Cache các hit (7 ngày) để lần sau đỡ tốn call.
      await Promise.all(
        queries.map((q) => {
          const h = out.get(q.key);
          if (!h) return Promise.resolve();
          const cacheKey = `${province ?? '-'}|${normalizeWorkName(q.workName)}|${q.unit}`;
          return this.cacheModel
            .updateOne(
              { key: cacheKey },
              { $set: { hit: h, sources: research.sources, expireAt: new Date(Date.now() + HIT_TTL_MS) }, $setOnInsert: { createdAt: new Date() } },
              { upsert: true },
            )
            .catch(() => undefined);
        }),
      );
    } catch (err) {
      this.logger.warn(`[WebPriceBatch] failed: ${(err as Error).message}`);
    }
    return out;
  }

  private async lookupOne(q: WebPriceQuery, province?: string): Promise<WebPriceHit | null> {
    const cacheKey = `${province ?? '-'}|${normalizeWorkName(q.workName)}|${q.unit}`;
    const cached = await this.cacheModel.findOne({ key: cacheKey }).lean().catch(() => null);
    if (cached && cached.expireAt > new Date()) return (cached.hit as WebPriceHit | null) ?? null;

    let hit: WebPriceHit | null = null;
    let sources: { title?: string; uri?: string }[] = [];
    let reason = 'none';
    try {
      const research = await this.ai.research(buildPriceQuery(q.workName, q.unit, province));
      if (research.sources.length === 0 || !research.text) {
        reason = 'grounding';
      } else {
        sources = research.sources;
        const raw = await this.ai.generateJson(
          [
            {
              text:
                `Từ đoạn văn (kết quả tra web) sau, trích ĐƠN GIÁ thi công công tác "${normalizeWorkName(q.workName)}" ` +
                `đơn vị ${q.unit} bằng VNĐ. Trả unitPriceVnd = con số (nếu là khoảng, lấy mức phổ biến/trung bình), ` +
                `rawPrice = chuỗi giá NGUYÊN VĂN trong đoạn (vd "40.000/m2"). Không thấy giá rõ ràng → found=false. ` +
                `TUYỆT ĐỐI không dùng kiến thức riêng, không suy đoán.\n\n--- ĐOẠN VĂN ---\n${research.text}`,
            },
          ],
          EXTRACT_SCHEMA,
        );
        const parsed = JSON.parse(raw) as { found?: boolean; unitPriceVnd?: number; rawPrice?: string };
        const price = parsed.unitPriceVnd;
        if (parsed.found && priceInRange(price) && priceAppearsInText(price as number, research.text)) {
          hit = {
            unitPrice: Math.round(price as number),
            sourceTitle: research.sources[0]?.title,
            sourceUri: research.sources[0]?.uri,
          };
        } else {
          reason = !parsed.found ? 'not-found' : !priceInRange(price) ? 'range' : 'literal';
        }
      }
    } catch (err) {
      this.logger.warn(`web price "${q.workName}" failed: ${(err as Error).message}`);
    }
    this.logger.log(
      `[WebPrice] "${q.workName}" (${province ?? '-'}) → sources=${sources.length}, price=${hit?.unitPrice ?? '-'}, fail=${hit ? 'none' : reason}`,
    );

    // KHÔNG cache khi grounding rỗng (sources=0) — thường do 429 quota/lỗi tạm,
    // cache miss sẽ chặn retry ở lần bóc sau. Chỉ cache hit, hoặc miss THẬT
    // (có grounding nhưng web không có giá rõ → not-found/range/literal).
    const shouldCache = !!hit || sources.length > 0;
    if (shouldCache) {
      const expireAt = new Date(Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS));
      await this.cacheModel
        .updateOne(
          { key: cacheKey },
          { $set: { hit, sources, expireAt }, $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        )
        .catch((e) => this.logger.warn(`web_price_cache write failed: ${(e as Error).message}`));
    }
    return hit;
  }
}
