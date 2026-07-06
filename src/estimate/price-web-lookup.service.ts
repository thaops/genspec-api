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

  /** Tra song song đơn giá cho nhiều công tác. Lỗi → null (không throw). */
  async lookupPrices(
    queries: WebPriceQuery[],
    province?: string,
  ): Promise<Map<string, WebPriceHit | null>> {
    const out = new Map<string, WebPriceHit | null>();
    if (!this.enabled || queries.length === 0) {
      queries.forEach((q) => out.set(q.key, null));
      return out;
    }
    const settled = await Promise.allSettled(
      queries.map((q) =>
        Promise.race([
          this.lookupOne(q, province),
          new Promise<WebPriceHit | null>((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS)),
        ]),
      ),
    );
    settled.forEach((s, i) => out.set(queries[i].key, s.status === 'fulfilled' ? s.value : null));
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

    const expireAt = new Date(Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS));
    await this.cacheModel
      .updateOne(
        { key: cacheKey },
        { $set: { hit, sources, expireAt }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      )
      .catch((e) => this.logger.warn(`web_price_cache write failed: ${(e as Error).message}`));
    return hit;
  }
}
