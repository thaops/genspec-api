// Tầng fallback tra mã định mức từ WEB khi norm_items trống — thiết kế CHỐNG BỊA:
//   Rào 1: chỉ tin text có grounding sources (sources.length > 0), text không grounding bị vứt.
//   Rào 2: mã phải khớp regex ^[A-Z]{2}\.\d{4,5}[a-z]?$ — sai format → null.
//   Rào 3: mã phải xuất hiện NGUYÊN VĂN trong text grounded (text.includes(code)) — model
//          trích ngoài văn bản → null.
//   Extract bằng generateJson (temperature 0.2 + thinkingBudget 0 — thấp nhất pipeline cho phép)
//   với prompt cấm dùng kiến thức riêng. Cache Mongo web_norm_cache (hit 7 ngày, miss 1 ngày).
// Kill-switch: env NORM_WEB_LOOKUP=off → tắt hoàn toàn.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';

// ===== Pure guardrails (không Mongo/AI — verify script gọi trực tiếp từ dist) =====

/** Format mã định mức VN: 2 chữ hoa + '.' + 4-5 số + hậu tố thường tuỳ chọn (AF.61522, AB.1141a). */
export const WEB_NORM_CODE_RE = /^[A-Z]{2}\.\d{4,5}[a-z]?$/;

/**
 * Rào 2 + Rào 3: mã đúng format VÀ xuất hiện literal trong text grounded → trả code sạch;
 * mọi trường hợp khác → null. PURE — không side effect.
 */
export function validateWebHit(code: string | null | undefined, groundedText: string): string | null {
  if (!code) return null;
  const c = String(code).trim();
  if (!WEB_NORM_CODE_RE.test(c)) return null;
  if (!groundedText || !groundedText.includes(c)) return null;
  return c;
}

// ===== Types =====

export interface WebNormHit {
  code: string;
  name: string;
  sourceTitle?: string;
  sourceUri?: string;
}

export interface WebNormQuery {
  key: string;
  workName: string;
}

// ===== Mongo cache: web_norm_cache — TTL qua expireAt (hit 7d, miss 1d) =====

@Schema({ collection: 'web_norm_cache' })
export class WebNormCache {
  @Prop({ required: true, unique: true })
  key!: string; // workName normalize (lowercase, trim, collapse space)

  @Prop({ type: Object, default: null })
  hit!: WebNormHit | null;

  @Prop({ type: [Object], default: [] })
  sources!: { title?: string; uri?: string }[];

  @Prop({ default: () => new Date() })
  createdAt!: Date;

  @Prop({ required: true, index: { expireAfterSeconds: 0 } })
  expireAt!: Date;
}
export const WebNormCacheSchema = SchemaFactory.createForClass(WebNormCache);

const HIT_TTL_MS = 7 * 24 * 3600 * 1000; // hit: 7 ngày
const MISS_TTL_MS = 24 * 3600 * 1000; // miss: 1 ngày — cho phép thử lại sớm
// research() đã tự giới hạn 20s; cộng thêm budget cho bước extract JSON (retry tối đa) → 35s trần cứng/query.
const QUERY_TIMEOUT_MS = 35000;

const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    code: { type: 'STRING' },
    name: { type: 'STRING' },
  },
  required: ['found'],
};

export const normalizeCacheKey = (workName: string) => workName.trim().toLowerCase().replace(/\s+/g, ' ');

@Injectable()
export class NormWebLookupService {
  private readonly logger = new Logger(NormWebLookupService.name);

  constructor(
    private readonly ai: AiService,
    private readonly config: ConfigService,
    @InjectModel(WebNormCache.name) private readonly cacheModel: Model<WebNormCache>,
  ) {}

  /** Mặc định ON khi có AI; env NORM_WEB_LOOKUP=off tắt hoàn toàn. */
  get enabled(): boolean {
    return this.config.get<string>('NORM_WEB_LOOKUP') !== 'off' && this.ai.available;
  }

  /** Tra song song, mỗi query timeout 20s, lỗi → null (không bao giờ throw). */
  async lookupCodes(queries: WebNormQuery[]): Promise<Map<string, WebNormHit | null>> {
    const out = new Map<string, WebNormHit | null>();
    if (!this.enabled || queries.length === 0) {
      queries.forEach((q) => out.set(q.key, null));
      return out;
    }
    const settled = await Promise.allSettled(
      queries.map((q) =>
        Promise.race([
          this.lookupOne(q.workName),
          new Promise<WebNormHit | null>((r) => setTimeout(() => r(null), QUERY_TIMEOUT_MS)),
        ]),
      ),
    );
    settled.forEach((s, i) => out.set(queries[i].key, s.status === 'fulfilled' ? s.value : null));
    return out;
  }

  private async lookupOne(workName: string): Promise<WebNormHit | null> {
    const cacheKey = normalizeCacheKey(workName);
    // Cache trước — tránh đốt quota lặp lại (cache cả miss).
    const cached = await this.cacheModel.findOne({ key: cacheKey }).lean().catch(() => null);
    if (cached && cached.expireAt > new Date()) {
      return (cached.hit as WebNormHit | null) ?? null;
    }

    let hit: WebNormHit | null = null;
    let sources: { title?: string; uri?: string }[] = [];
    try {
      // Bước 1 — GROUNDED SEARCH (Gemini + googleSearch).
      const research = await this.ai.research(
        `mã hiệu định mức "${workName}" theo Thông tư 12/2021/TT-BXD (định mức xây dựng). Ghi rõ mã hiệu dạng XX.NNNNN và tên công tác.`,
      );
      // Rào 1: không có grounding source → KHÔNG TÌM THẤY, vứt text.
      if (research.sources.length > 0 && research.text) {
        sources = research.sources;
        // Bước 2 — EXTRACT có kiểm soát (JSON schema, thinking off, temp thấp nhất pipeline).
        const raw = await this.ai.generateJson(
          [
            {
              text:
                `CHỈ trích xuất mã hiệu định mức xuất hiện NGUYÊN VĂN trong đoạn văn sau (kết quả tra cứu web) cho công tác "${workName}". ` +
                `Mã hiệu có dạng XX.NNNNN (2 chữ hoa, dấu chấm, 4-5 chữ số). Không thấy mã dạng đó trong đoạn văn → found=false. ` +
                `TUYỆT ĐỐI không dùng kiến thức riêng, không suy đoán, không tự tạo mã.\n\n--- ĐOẠN VĂN ---\n${research.text}`,
            },
          ],
          EXTRACT_SCHEMA,
        );
        const parsed = JSON.parse(raw) as { found?: boolean; code?: string; name?: string };
        if (parsed.found) {
          // Rào 2 + Rào 3.
          const code = validateWebHit(parsed.code, research.text);
          if (code) {
            hit = {
              code,
              name: (parsed.name || workName).replace(/\s+/g, ' ').trim(),
              sourceTitle: research.sources[0]?.title,
              sourceUri: research.sources[0]?.uri,
            };
          }
        }
      }
    } catch (err) {
      this.logger.warn(`web norm lookup "${workName}" failed: ${(err as Error).message}`);
    }

    const expireAt = new Date(Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS));
    await this.cacheModel
      .updateOne(
        { key: cacheKey },
        { $set: { hit, sources, expireAt }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      )
      .catch((e) => this.logger.warn(`web_norm_cache write failed: ${(e as Error).message}`));
    return hit;
  }
}
