// Tầng fallback tra mã định mức từ WEB khi norm_items trống — thiết kế CHỐNG BỊA:
//   Rào 1: chỉ tin text có grounding sources (sources.length > 0), text không grounding bị vứt.
//   Rào 2: mã phải khớp regex ^[A-Z]{2}\.\d{4,5}[a-z]?$ — sai format → null.
//   Rào 3: mã phải xuất hiện NGUYÊN VĂN trong text grounded — model trích ngoài văn bản → null.
//          (literal cho phép biến thể hoa/thường + khoảng trắng quanh dấu chấm "AE. 62210" —
//          vẫn là chuỗi trong text, KHÔNG phải kiến thức model.)
//   Extract bằng generateJson (temperature 0.2 + thinkingBudget 0 — thấp nhất pipeline cho phép)
//   với prompt cấm dùng kiến thức riêng, liệt kê TỐI ĐA 5 ứng viên; BE tự lọc qua rào.
//   Query: chuẩn hoá workName + bảng QUERY_HINTS theo hintKey, thử tuần tự tối đa 2 query/key.
//   Cache Mongo web_norm_cache (hit 7 ngày, miss 1 ngày) — key (hintKey|workName chuẩn hoá), ghi failReason.
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

export type WebNormFailReason = 'none' | 'grounding' | 'format' | 'literal';

/**
 * Rào 3 nới đúng mức: mã xuất hiện literal trong text, chấp nhận biến thể hoa/thường
 * và khoảng trắng quanh dấu chấm ("AE. 62210", "ae .62210"). Vẫn là chuỗi nguyên văn
 * trong text grounded — không phải kiến thức model. PURE.
 */
export function literalCodeInText(code: string, text: string): boolean {
  if (!code || !text) return false;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\.\\s*');
  return new RegExp(escaped, 'i').test(text);
}

/**
 * Rào 2 + Rào 3: mã đúng format VÀ xuất hiện literal trong text grounded → trả code sạch;
 * mọi trường hợp khác → null. PURE — không side effect.
 */
export function validateWebHit(code: string | null | undefined, groundedText: string): string | null {
  if (!code) return null;
  const c = String(code).trim();
  if (!WEB_NORM_CODE_RE.test(c)) return null;
  if (!groundedText || !literalCodeInText(c, groundedText)) return null;
  return c;
}

/**
 * Lặp qua danh sách ứng viên từ extract, trả ứng viên ĐẦU TIÊN qua đủ rào format + literal.
 * Không ứng viên nào qua → hit=null + failReason ('format' nếu tất cả sai format,
 * 'literal' nếu có ít nhất 1 mã đúng format nhưng không nguyên văn trong text). PURE.
 */
export function pickValidCandidate(
  candidates: { code?: string; name?: string }[] | undefined,
  groundedText: string,
): { code: string | null; name?: string; failReason: 'format' | 'literal' | 'none' } {
  if (!candidates?.length) return { code: null, failReason: 'none' };
  let sawFormatOk = false;
  for (const cand of candidates) {
    const c = String(cand?.code ?? '').trim();
    if (!WEB_NORM_CODE_RE.test(c)) continue;
    sawFormatOk = true;
    if (literalCodeInText(c, groundedText)) {
      return { code: c, name: String(cand?.name ?? '').replace(/\s+/g, ' ').trim(), failReason: 'none' };
    }
  }
  return { code: null, failReason: sawFormatOk ? 'literal' : 'format' };
}

/**
 * Chuẩn hoá workName cho search: lowercase, "xây/trát tường" → giữ khái niệm chính
 * ("xây tường"), bỏ phần đơn vị/chú thích trong ngoặc, gộp khoảng trắng. PURE.
 */
export function normalizeWorkName(workName: string): string {
  return workName
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // bỏ "(diện tích)", "(m2)"...
    .replace(/(\p{L}+)\s*\/\s*\p{L}+/gu, '$1') // "xây/trát tường" → "xây tường"
    .replace(/\b(m2|m3|m²|m³|md|100m2|100m3)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bảng query đã tối ưu cho search VN theo nhóm chuẩn của takeoff engine.
 * Mỗi key 2-3 query; runtime thử tuần tự tối đa MAX_QUERIES_PER_KEY.
 */
export const QUERY_HINTS: Record<string, string[]> = {
  wall_area: [
    'mã hiệu định mức AK.2 trát tường thông tư 12/2021/TT-BXD',
    'định mức 12/2021 công tác trát tường xây tường mã hiệu',
  ],
  wall_volume: [
    'mã hiệu định mức AE.2 xây tường gạch thông tư 12/2021/TT-BXD',
    'định mức 12/2021 công tác xây tường gạch mã hiệu',
  ],
  column_concrete: [
    'mã hiệu định mức AF.1 bê tông cột thông tư 12/2021',
    'định mức 12/2021 công tác bê tông cột mã hiệu',
  ],
  column_formwork: [
    'mã hiệu định mức AF.8 ván khuôn cột thông tư 12/2021',
    'định mức 12/2021 công tác ván khuôn cột mã hiệu',
  ],
  beam_concrete: [
    'mã hiệu định mức AF.1 bê tông dầm thông tư 12/2021',
    'định mức 12/2021 công tác bê tông dầm mã hiệu',
  ],
  beam_formwork: [
    'mã hiệu định mức AF.8 ván khuôn dầm thông tư 12/2021',
    'định mức 12/2021 công tác ván khuôn dầm mã hiệu',
  ],
  door: [
    'mã hiệu định mức AH lắp dựng cửa đi thông tư 12/2021',
    'định mức 12/2021 công tác lắp dựng cửa mã hiệu',
  ],
  window: [
    'mã hiệu định mức AH lắp dựng cửa sổ thông tư 12/2021',
    'định mức 12/2021 công tác lắp dựng cửa sổ mã hiệu',
  ],
  slab: [
    'mã hiệu định mức AF.1 bê tông sàn thông tư 12/2021',
    'định mức 12/2021 công tác bê tông sàn mái mã hiệu',
  ],
};

/** Thử tuần tự tối đa 2 query/key — query 1 miss → query 2, dừng ngay khi hit. */
export const MAX_QUERIES_PER_KEY = 2;

/** Dựng danh sách query (tối đa MAX_QUERIES_PER_KEY): ưu tiên QUERY_HINTS[hintKey], fallback generic. PURE. */
export function buildQueries(hintKey: string | undefined, workName: string): string[] {
  const wn = normalizeWorkName(workName);
  const hinted = hintKey ? QUERY_HINTS[hintKey] : undefined;
  const generic = [
    `mã hiệu định mức "${wn}" theo Thông tư 12/2021/TT-BXD (định mức xây dựng). Ghi rõ mã hiệu dạng XX.NNNNN và tên công tác.`,
    `định mức xây dựng 12/2021 công tác ${wn} mã hiệu`,
  ];
  return [...(hinted ?? []), ...generic].slice(0, MAX_QUERIES_PER_KEY);
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
  /** Nhóm chuẩn của takeoff engine (wall_area, column_concrete...) → chọn QUERY_HINTS. */
  hintKey?: string;
}

// ===== Mongo cache: web_norm_cache — TTL qua expireAt (hit 7d, miss 1d) =====

@Schema({ collection: 'web_norm_cache' })
export class WebNormCache {
  @Prop({ required: true, unique: true })
  key!: string; // `${hintKey|-}|${workName chuẩn hoá}`

  @Prop({ type: Object, default: null })
  hit!: WebNormHit | null;

  @Prop({ type: [Object], default: [] })
  sources!: { title?: string; uri?: string }[];

  /** Vì sao miss (đọc được từ production): grounding | format | literal | none. */
  @Prop({ type: String, default: null })
  failReason!: WebNormFailReason | null;

  @Prop({ default: () => new Date() })
  createdAt!: Date;

  @Prop({ required: true, index: { expireAfterSeconds: 0 } })
  expireAt!: Date;
}
export const WebNormCacheSchema = SchemaFactory.createForClass(WebNormCache);

const HIT_TTL_MS = 7 * 24 * 3600 * 1000; // hit: 7 ngày
const MISS_TTL_MS = 24 * 3600 * 1000; // miss: 1 ngày — cho phép thử lại sớm
// research() đã tự giới hạn 20s; cộng extract JSON → 35s/query; tối đa 2 query + đệm.
const QUERY_TIMEOUT_MS = 35000;
const LOOKUP_TIMEOUT_MS = QUERY_TIMEOUT_MS * MAX_QUERIES_PER_KEY + 5000;

// Extract nhiều ứng viên: model liệt kê MỌI mã xuất hiện nguyên văn (tối đa 5),
// BE lặp qua candidates và tự áp rào — 1 code duy nhất dễ chọn nhầm cái không literal.
const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' },
    codes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { code: { type: 'STRING' }, name: { type: 'STRING' } },
        required: ['code'],
      },
    },
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

  /** Tra song song, mỗi lookup timeout cứng, lỗi → null (không bao giờ throw). */
  async lookupCodes(queries: WebNormQuery[]): Promise<Map<string, WebNormHit | null>> {
    const out = new Map<string, WebNormHit | null>();
    if (!this.enabled || queries.length === 0) {
      queries.forEach((q) => out.set(q.key, null));
      return out;
    }
    const settled = await Promise.allSettled(
      queries.map((q) =>
        Promise.race([
          this.lookupOne(q),
          new Promise<WebNormHit | null>((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS)),
        ]),
      ),
    );
    settled.forEach((s, i) => out.set(queries[i].key, s.status === 'fulfilled' ? s.value : null));
    return out;
  }

  private async lookupOne(q: WebNormQuery): Promise<WebNormHit | null> {
    const { workName, hintKey } = q;
    const cacheKey = `${hintKey ?? '-'}|${normalizeCacheKey(normalizeWorkName(workName))}`;
    // Cache trước — tránh đốt quota lặp lại (cache cả miss).
    const cached = await this.cacheModel.findOne({ key: cacheKey }).lean().catch(() => null);
    if (cached && cached.expireAt > new Date()) {
      return (cached.hit as WebNormHit | null) ?? null;
    }

    let hit: WebNormHit | null = null;
    let sources: { title?: string; uri?: string }[] = [];
    let failReason: WebNormFailReason = 'none';

    for (const query of buildQueries(hintKey, workName)) {
      let srcCount = 0;
      let extractFound = false;
      failReason = 'none';
      try {
        // Bước 1 — GROUNDED SEARCH (Gemini + googleSearch).
        const research = await this.ai.research(query);
        srcCount = research.sources.length;
        // Rào 1: không có grounding source → KHÔNG TÌM THẤY, vứt text.
        if (srcCount === 0 || !research.text) {
          failReason = 'grounding';
        } else {
          sources = research.sources;
          // Bước 2 — EXTRACT có kiểm soát (JSON schema, thinking off, temp thấp nhất pipeline).
          const raw = await this.ai.generateJson(
            [
              {
                text:
                  `Liệt kê TẤT CẢ mã hiệu định mức xuất hiện NGUYÊN VĂN trong đoạn văn sau (kết quả tra cứu web) liên quan công tác "${normalizeWorkName(workName)}", tối đa 5 mã, ưu tiên mã khớp công tác nhất trước. ` +
                  `Mã hiệu có dạng XX.NNNNN (2 chữ hoa, dấu chấm, 4-5 chữ số). Không thấy mã dạng đó trong đoạn văn → found=false, codes=[]. ` +
                  `TUYỆT ĐỐI không dùng kiến thức riêng, không suy đoán, không tự tạo mã.\n\n--- ĐOẠN VĂN ---\n${research.text}`,
              },
            ],
            EXTRACT_SCHEMA,
          );
          const parsed = JSON.parse(raw) as { found?: boolean; codes?: { code?: string; name?: string }[] };
          extractFound = !!parsed.found && (parsed.codes?.length ?? 0) > 0;
          if (extractFound) {
            // Rào 2 + Rào 3 trên từng ứng viên — lấy ứng viên đầu tiên qua đủ rào.
            const picked = pickValidCandidate(parsed.codes, research.text);
            if (picked.code) {
              hit = {
                code: picked.code,
                name: picked.name || workName,
                sourceTitle: research.sources[0]?.title,
                sourceUri: research.sources[0]?.uri,
              };
            } else {
              failReason = picked.failReason;
            }
          }
        }
      } catch (err) {
        this.logger.warn(`web norm lookup "${workName}" failed: ${(err as Error).message}`);
      }
      // Log chẩn đoán 1 dòng/query — production đọc được vì sao miss.
      this.logger.log(
        `[WebNorm] "${workName}" → sources=${srcCount}, extractFound=${extractFound}, code=${hit?.code ?? '-'}, rào_fail=${hit ? 'none' : failReason}`,
      );
      if (hit) break; // dừng ngay khi hit — không đốt thêm quota
    }

    const expireAt = new Date(Date.now() + (hit ? HIT_TTL_MS : MISS_TTL_MS));
    await this.cacheModel
      .updateOne(
        { key: cacheKey },
        {
          $set: { hit, sources, failReason: hit ? null : failReason, expireAt },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      )
      .catch((e) => this.logger.warn(`web_norm_cache write failed: ${(e as Error).message}`));
    return hit;
  }
}
