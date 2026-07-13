/**
 * Knowledge Graph — liên kết Vật tư → Nguồn → Giá → Lịch sử.
 *
 * PURE. Biến các price-point rời (material_prices, nhiều sourceId/ngày) thành tri
 * thức truy vấn được:
 *   - materialKnowledge : 1 vật tư có bao nhiêu nguồn giá, giá mới nhất, lịch sử
 *   - swapImpact        : "Đổi Holcim → Hà Tiên thì chênh bao nhiêu?" (× khối lượng)
 *
 * KHÔNG bịa: chỉ tổng hợp giá ĐÃ có nguồn (sourceId + effectiveDate + trust).
 * Không có dữ liệu → matched=false, không sinh số.
 */

export interface PricePoint {
  name: string;
  price: number;
  sourceId: string;
  trust: number;
  effectiveDate: Date | string;
  province?: string | null;
  documentNumber?: string;
  category?: string;
  unit?: string;
}

export interface PriceSourceRef {
  sourceId: string;
  price: number;
  trust: number;
  effectiveDate: string; // yyyy-mm-dd
  documentNumber?: string;
  province?: string | null;
}

export interface MaterialKnowledge {
  query: string;
  matched: boolean;
  name?: string;
  unit?: string;
  /** Giá tin nhất/mới nhất (trust desc → date desc). */
  latest?: PriceSourceRef;
  /** Mọi nguồn giá (mỗi sourceId 1 điểm mới nhất), tin/mới trước. */
  sources: PriceSourceRef[];
  /** Lịch sử giá theo thời gian (mọi điểm), cũ → mới. */
  history: { effectiveDate: string; price: number; sourceId: string }[];
}

export interface SwapImpact {
  from: { query: string; name?: string; price?: number };
  to: { query: string; name?: string; price?: number };
  matched: boolean;
  unit?: string;
  quantity: number;
  /** Chênh lệch đơn giá (to − from). */
  deltaUnit?: number;
  deltaPercent?: number;
  /** Chênh lệch thành tiền = deltaUnit × quantity. */
  totalDelta?: number;
}

function normalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function iso(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return isNaN(dt.getTime()) ? String(d) : dt.toISOString().slice(0, 10);
}

/** Điểm giá khớp tên (fuzzy 2 chiều — chứa/được chứa). */
function matchByName(points: PricePoint[], query: string): PricePoint[] {
  const q = normalize(query);
  if (!q) return [];
  return points.filter((p) => {
    const n = normalize(p.name);
    return n === q || n.includes(q) || q.includes(n);
  });
}

/** Bản tin nhất: trust desc → effectiveDate desc. */
function bestOf(points: PricePoint[]): PricePoint | undefined {
  return [...points].sort((a, b) => {
    if (b.trust !== a.trust) return b.trust - a.trust;
    return new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime();
  })[0];
}

function toRef(p: PricePoint): PriceSourceRef {
  return { sourceId: p.sourceId, price: p.price, trust: p.trust, effectiveDate: iso(p.effectiveDate), documentNumber: p.documentNumber, province: p.province ?? null };
}

/** Tri thức 1 vật tư: nguồn + giá mới nhất + lịch sử. PURE. */
export function materialKnowledge(points: PricePoint[], query: string): MaterialKnowledge {
  const matched = matchByName(points, query);
  if (matched.length === 0) return { query, matched: false, sources: [], history: [] };

  // Mỗi sourceId giữ 1 điểm mới nhất
  const bySource = new Map<string, PricePoint>();
  for (const p of matched) {
    const cur = bySource.get(p.sourceId);
    if (!cur || new Date(p.effectiveDate).getTime() > new Date(cur.effectiveDate).getTime()) bySource.set(p.sourceId, p);
  }
  const sources = [...bySource.values()].map(toRef).sort((a, b) => (b.trust - a.trust) || (b.effectiveDate.localeCompare(a.effectiveDate)));
  const best = bestOf(matched)!;
  const history = matched
    .map((p) => ({ effectiveDate: iso(p.effectiveDate), price: p.price, sourceId: p.sourceId }))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  return { query, matched: true, name: best.name, unit: best.unit, latest: toRef(best), sources, history };
}

/** "Đổi A → B chênh bao nhiêu?" trên 1 đơn vị + × khối lượng. PURE. */
export function swapImpact(points: PricePoint[], fromQuery: string, toQuery: string, quantity = 1): SwapImpact {
  const from = bestOf(matchByName(points, fromQuery));
  const to = bestOf(matchByName(points, toQuery));
  if (!from || !to) {
    return {
      from: { query: fromQuery, name: from?.name, price: from?.price },
      to: { query: toQuery, name: to?.name, price: to?.price },
      matched: false, quantity,
    };
  }
  const deltaUnit = to.price - from.price;
  return {
    from: { query: fromQuery, name: from.name, price: from.price },
    to: { query: toQuery, name: to.name, price: to.price },
    matched: true,
    unit: to.unit ?? from.unit,
    quantity,
    deltaUnit,
    deltaPercent: from.price > 0 ? Math.round((deltaUnit / from.price) * 1000) / 10 : 0,
    totalDelta: Math.round(deltaUnit * quantity),
  };
}
