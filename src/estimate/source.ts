import { PriceSource, SourceType } from './estimate.types';

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

/**
 * Normalise a price source: resolve its type (explicit → inferred) and set
 * confidence from the ranking table. If no type can be determined we leave the
 * existing confidence untouched rather than fabricate one.
 */
export function rankSource(s?: PriceSource): PriceSource | undefined {
  if (!s) return s;
  const type = s.type ?? inferSourceType(s);
  const ranked = reliabilityOf(type);
  return {
    ...s,
    type: type ?? s.type,
    confidence: ranked ?? s.confidence,
  };
}
