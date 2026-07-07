import { PriceSource, SourceType } from './estimate.types';
import { freshnessScore, recencyDelta } from './recency';

/**
 * Source Ranking Engine — reliability is DERIVED from the source type, not
 * trusted from an AI-supplied number. A government price list is always more
 * reliable than a forum post, regardless of what the model "felt".
 */
export const SOURCE_RELIABILITY: Record<SourceType, number> = {
  government: 95,
  supplier: 85,
  market: 75,
  forum: 60,
  ai_estimate: 40,
  manual: 50,
};

export const SOURCE_LABEL: Record<SourceType, string> = {
  government: 'Cơ quan nhà nước',
  supplier: 'Nhà cung cấp',
  market: 'Thị trường',
  forum: 'Diễn đàn',
  ai_estimate: 'AI ước lượng',
  manual: 'Nhập tay',
};

export function reliabilityOf(type?: SourceType): number | undefined {
  return type ? SOURCE_RELIABILITY[type] : undefined;
}

/** Best-effort: infer the source type from its URL / name when AI didn't tag one. */
export function inferSourceType(s?: PriceSource): SourceType | undefined {
  if (!s) return undefined;
  const hay = `${s.url ?? ''} ${s.name ?? ''}`.toLowerCase();
  if (!hay.trim()) return undefined;
  if (/\.gov\.vn|sở xây dựng|bộ xây dựng|liên sở|định mức|\bbxd\b|thông báo giá/.test(hay)) return 'government';
  if (/báo giá|nhà cung cấp|đại lý|cung cấp|supplier|catalog|\bgiá sỉ\b/.test(hay)) return 'supplier';
  if (/diễn đàn|forum|diendan|hỏi đáp|webtretho|reddit/.test(hay)) return 'forum';
  if (/shopee|lazada|tiki|sàn|thị trường|market/.test(hay)) return 'market';
  if (/ai|ước lượng|suy luận|giả định|estimate/.test(hay)) return 'ai_estimate';
  return s.url ? 'market' : undefined;
}

/** Kẹp về [0,100]. */
function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Normalise a price source: resolve its type (explicit → inferred), set
 * confidence từ bảng reliability theo LOẠI rồi ĐIỀU CHỈNH theo tuổi nguồn
 * (recencyDelta) — nguồn mới hơn được cộng, nguồn cũ bị trừ. Không xác định
 * được loại → giữ nguyên confidence cũ thay vì bịa.
 */
export function rankSource(s?: PriceSource): PriceSource | undefined {
  if (!s) return s;
  const type = s.type ?? inferSourceType(s);
  const ranked = reliabilityOf(type);
  const confidence = ranked != null ? clamp(ranked + recencyDelta(s.date)) : s.confidence;
  return {
    ...s,
    type: type ?? s.type,
    confidence,
  };
}

/**
 * Chọn nguồn "tốt hơn" giữa hai nguồn cho cùng một giá trị: reliability đã điều
 * chỉnh theo tuổi thắng; hoà thì nguồn TƯƠI hơn thắng. Dùng khi hợp nhất giá từ
 * nhiều nguồn (senior QS: ưu tiên mới hơn).
 */
export function pickBetterSource(a?: PriceSource, b?: PriceSource): PriceSource | undefined {
  if (!a) return b;
  if (!b) return a;
  const ra = rankSource(a)?.confidence ?? 0;
  const rb = rankSource(b)?.confidence ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  const fa = freshnessScore(a.date) ?? -1;
  const fb = freshnessScore(b.date) ?? -1;
  return fb > fa ? b : a;
}
