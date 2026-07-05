// Chống bịa đơn giá: khi LLM (edit path) tự chế đơn giá KÈM nguồn nghe-chính-thống
// (ĐM 12/2021, Giá TT Qx/2024, công bố giá…) mà hệ thống CHƯA import price_set khớp
// → hạ cấp nguồn thành "AI ước lượng", sinh finding warn, trần điểm 40.
// Pure (không Mongo) — verify script gọi trực tiếp từ dist.
import { Action, EstimateState, ValidationFinding } from './estimate.types';
import { parseExcelCell } from './reducer';

/** Cụm từ nghe như nguồn chính thống — dùng để phát hiện nguồn giả do AI sinh. */
export const OFFICIAL_SOURCE_RE =
  /ĐM|định mức|TT ?\d|thông tư|\d{4}\/\d{4}|công bố giá|giá TT|Q[1-4]\/\d{4}/i;

/** Nguồn thay thế khi hạ cấp. */
export const AI_ESTIMATE_SOURCE =
  'AI ước lượng — CHƯA có nguồn chính thống (cần import giá tỉnh)';

/** Trần điểm khi có bất kỳ đơn giá AI-ước-lượng nào (thấp hơn "thiếu mã" 55). */
export const AI_PRICE_SCORE_CAP = 40;

const COL_UNIT_PRICE = 5; // F = Đơn giá
const COL_SOURCE = 7; // H = Nguồn
const COL_NOTE = 8; // I = Diễn giải
const AI_PRICE_MARK = ' ⚠ giá AI ước lượng — chưa có nguồn chính thống';

export interface PriceGuardCtx {
  prices: { refCode?: string; name: string; price: number }[];
}

export interface PriceGuardResult {
  actions: Action[];
  findings: ValidationFinding[];
  /** Số dòng có đơn giá bị hạ cấp thành AI ước lượng. */
  downgraded: number;
  /** Trần điểm cần áp (AI_PRICE_SCORE_CAP) khi downgraded > 0; null nếu không. */
  scoreCap: number | null;
}

function cellVal(c: unknown): string {
  if (c == null || typeof c !== 'object') return String(c ?? '');
  const o = c as { v?: unknown; f?: unknown };
  if (o.f != null && String(o.f) !== '') return `=${o.f}`;
  return String(o.v ?? '');
}

/** Số tiền từ chuỗi ("106.500", "106500 đ") → 106500; null nếu không có chữ số. */
function parsePriceNumber(v: string): number | null {
  const digits = String(v ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

/** Sheet khối lượng: header A1=STT + H1 chứa "Nguồn" (trong state HOẶC trong chính actions). */
function isQuantitySheet(
  sheetId: string,
  state: EstimateState,
  rowsByR: Map<number, Record<number, string>>,
): boolean {
  const st = (state.sheets ?? []).find((s) => s.id === sheetId);
  const cd = (st?.data?.cellData ?? {}) as Record<string, Record<string, unknown>>;
  if (cellVal(cd['0']?.['0']) === 'STT' && /Nguồn/i.test(cellVal(cd['0']?.['7']))) return true;
  for (const m of rowsByR.values()) {
    if (m[0] === 'STT' && /Nguồn/i.test(String(m[COL_SOURCE] ?? ''))) return true;
  }
  return false;
}

/**
 * Quét các update_cells ghi Đơn giá (F) / Nguồn (H) trên sheet khối lượng.
 * H mang cụm nghe-chính-thống NHƯNG không truy được price_set import → hạ cấp.
 * traceable = có priceCtx VÀ đơn giá F khớp một price_item (refCode/tên → giá).
 * Chỉ tác động lên actions (do AI sinh trong proposal này) — không đụng số user tự gõ.
 */
export function guardFabricatedPricing(
  actions: Action[],
  state: EstimateState,
  priceCtx: PriceGuardCtx | null,
): PriceGuardResult {
  const noChange: PriceGuardResult = { actions, findings: [], downgraded: 0, scoreCap: null };

  // Gom update_cells theo sheet → theo dòng → {col: newValue}
  const bySheet = new Map<string, Map<number, Record<number, string>>>();
  for (const a of actions) {
    if (a.type !== 'update_cells') continue;
    const { row, col } = parseExcelCell(a.cell);
    let rows = bySheet.get(a.sheetId);
    if (!rows) bySheet.set(a.sheetId, (rows = new Map()));
    const m = rows.get(row) ?? {};
    m[col] = a.newValue;
    rows.set(row, m);
  }
  if (bySheet.size === 0) return noChange;

  const priceMatches = (fVal: number | null): boolean => {
    if (!priceCtx || fVal == null) return false;
    return priceCtx.prices.some((p) => Math.round(p.price) === fVal);
  };

  // {sheetId, row} có nguồn giả cần hạ cấp
  const downgradeRows = new Set<string>();
  for (const [sheetId, rows] of bySheet) {
    if (!isQuantitySheet(sheetId, state, rows)) continue;
    for (const [row, m] of rows) {
      const src = m[COL_SOURCE];
      if (src == null || !OFFICIAL_SOURCE_RE.test(src)) continue;
      if (priceMatches(parsePriceNumber(m[COL_UNIT_PRICE] ?? ''))) continue; // nguồn thật, giữ
      downgradeRows.add(`${sheetId}:${row}`);
    }
  }
  if (downgradeRows.size === 0) return noChange;

  const nextActions = actions.map((a) => {
    if (a.type !== 'update_cells') return a;
    const { row, col } = parseExcelCell(a.cell);
    if (!downgradeRows.has(`${a.sheetId}:${row}`)) return a;
    if (col === COL_SOURCE) return { ...a, newValue: AI_ESTIMATE_SOURCE };
    if (col === COL_NOTE && !a.newValue.includes(AI_PRICE_MARK)) {
      return { ...a, newValue: a.newValue + AI_PRICE_MARK };
    }
    return a;
  });

  const n = downgradeRows.size;
  const findings: ValidationFinding[] = [
    {
      id: 'price-guard-ai-estimate',
      severity: 'warn',
      area: 'unitPrice',
      title: `${n} đơn giá do AI ước lượng`,
      detail: `${n} đơn giá do AI ước lượng — chưa có công bố giá tỉnh; KHÔNG dùng để thầu/thẩm định khi chưa import.`,
    },
  ];

  return { actions: nextActions, findings, downgraded: n, scoreCap: AI_PRICE_SCORE_CAP };
}

/**
 * Cắt câu hỏi xin phép ở CUỐI message khi đang thực thi (có actions) — chống
 * "ông muốn tôi… không?" dù Edit đã bật. Không cắt nếu message chỉ là 1 câu hỏi.
 */
export function stripTrailingQuestion(message: string): string {
  const trimmed = (message ?? '').replace(/\s+$/, '');
  if (!trimmed.endsWith('?')) return message;
  const cut = trimmed.replace(/([.!?\n])\s*[^.!?\n]*\?\s*$/, '$1').trim();
  return cut && cut !== trimmed ? cut : message;
}
