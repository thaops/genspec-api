/**
 * Rebar takeoff — bóc cốt thép từ callout trên bản KẾT CẤU.
 *
 * PURE. Quy ước ghi thép chuẩn VN (AutoCAD `%%C` = Ø):
 *   - Thép chịu lực/dọc : `<số>%%C<Ø>`      vd 2%%C16 = 2 thanh Ø16
 *   - Thép đai/phân bố  : `%%C<Ø>a<b.cách>` vd %%C6a150 = Ø6 @150; 8%%C6a50 = 8 đai Ø6 @50
 *
 * NGUYÊN TẮC KHÔNG BỊA: callout chỉ cho Ø + số lượng + khoảng cách. Tổng KG cần
 * CHIỀU DÀI thanh (từ bảng thống kê thép hoặc kích thước cấu kiện) — KHÔNG suy ra
 * ở đây để tránh sai kg. Chỉ trả: đếm callout theo Ø + đơn trọng (kg/m, hằng số
 * vật lý) → QS/engine nhân với chiều dài đã biết để ra kg. Đúng human-in-the-loop.
 */

/** Đơn trọng thép tròn trơn/vằn (kg/m) theo Ø (mm) — hằng số vật lý (ρ=7850, πd²/4). */
export const REBAR_UNIT_WEIGHT: Record<number, number> = {
  6: 0.222, 8: 0.395, 10: 0.617, 12: 0.888, 14: 1.208, 16: 1.578,
  18: 1.998, 20: 2.466, 22: 2.984, 25: 3.853, 28: 4.834, 32: 6.313,
};

/** kg/m cho Ø bất kỳ (mm) — tính nếu không có trong bảng. */
export function unitWeightOf(dia: number): number {
  if (REBAR_UNIT_WEIGHT[dia]) return REBAR_UNIT_WEIGHT[dia];
  return Math.round((dia * dia * 0.00617) * 1000) / 1000; // 0.00617 = π·7850/4·1e-6
}

export type RebarKind = 'main' | 'stirrup';

export interface RebarCallout {
  raw: string;
  count?: number;   // số thanh (main) / số đai — undefined nếu callout không ghi số
  diameter: number; // Ø mm
  spacing?: number; // khoảng cách a<mm> — có = đai/phân bố
  kind: RebarKind;
}

// `%%C`/`%%c` (literal AutoCAD, chưa decode) HOẶC ký tự `Ø` thật (parser đã decode
// trước khi lưu properties.text — xác nhận thật trên file KC: "2Ø6a500", "4Ø10",
// "Ø6a150") đều = Ø. Số đứng trước = số lượng; `a<mm>` (thường LOWERCASE) = khoảng
// cách. Uppercase `A<nnn>` là MÁC thép (A500/CB500…) → KHÔNG phải spacing, bỏ qua.
const CALLOUT_RE = /(\d+)?\s*(?:%%[Cc]|Ø)\s*(\d{1,2})(?:\s*a\s*(\d{2,3}))?/g;
// Loại nhiễu: bu lông/bolt (%%C12 nhưng là bu lông, không phải cốt thép).
const BOLT_RE = /bu\s*l[oôơại]ng|bolt/i;

/** Bóc mọi callout thép trong 1 chuỗi text. PURE. */
export function parseRebarCallouts(text: string): RebarCallout[] {
  if (!text || BOLT_RE.test(text)) return [];
  const out: RebarCallout[] = [];
  for (const m of text.matchAll(CALLOUT_RE)) {
    const count = m[1] ? parseInt(m[1], 10) : undefined;
    const diameter = parseInt(m[2], 10);
    const spacing = m[3] ? parseInt(m[3], 10) : undefined;
    if (!diameter || diameter < 4 || diameter > 40) continue; // Ø hợp lệ 4..40mm
    out.push({ raw: m[0].trim(), count, diameter, spacing, kind: spacing ? 'stirrup' : 'main' });
  }
  return out;
}

export interface RebarDiameterSummary {
  diameter: number;
  unitWeightKgM: number;
  /** Tổng số thanh chịu lực ghi được (Σ count của callout main). */
  mainBarCount: number;
  /** Số callout đai/phân bố Ø này. */
  stirrupCalloutCount: number;
  /** Các khoảng cách đai xuất hiện (distinct, mm). */
  spacings: number[];
}

export interface RebarTakeoff {
  totalCallouts: number;
  diameters: RebarDiameterSummary[];
  /** Ghi chú minh bạch: chưa ra kg vì thiếu chiều dài. */
  note: string;
}

/** Tổng hợp callout theo Ø (từ danh sách text bản vẽ). PURE. */
export function aggregateRebar(texts: string[]): RebarTakeoff {
  const callouts = texts.flatMap(parseRebarCallouts);
  const byDia = new Map<number, RebarDiameterSummary>();
  const get = (d: number): RebarDiameterSummary => {
    let s = byDia.get(d);
    if (!s) { s = { diameter: d, unitWeightKgM: unitWeightOf(d), mainBarCount: 0, stirrupCalloutCount: 0, spacings: [] }; byDia.set(d, s); }
    return s;
  };
  for (const c of callouts) {
    const s = get(c.diameter);
    if (c.kind === 'main') s.mainBarCount += c.count ?? 1;
    else {
      s.stirrupCalloutCount += 1;
      if (c.spacing && !s.spacings.includes(c.spacing)) s.spacings.push(c.spacing);
    }
  }
  for (const s of byDia.values()) s.spacings.sort((a, b) => a - b);
  return {
    totalCallouts: callouts.length,
    diameters: [...byDia.values()].sort((a, b) => a.diameter - b.diameter),
    note: 'Đã bóc Ø + số lượng + khoảng cách từ callout. TỔNG KG cần CHIỀU DÀI thanh (bảng thống kê thép hoặc kích thước cấu kiện) — chưa suy ra để tránh sai khối lượng. kg = Σ(chiều dài × đơn trọng) sau khi có chiều dài.',
  };
}

// ===== Bước sau: KG khi ĐÃ CÓ chiều dài (không bịa — chiều dài do QS/bảng TK cấp) =====

export interface RebarLengthInput {
  diameter: number;
  /** Tổng chiều dài thanh Ø này (m) — từ bảng thống kê thép hoặc Σ(chiều dài × số thanh). */
  totalLengthM: number;
}

export interface RebarWeightRow {
  diameter: number;
  totalLengthM: number;
  unitWeightKgM: number;
  weightKg: number;
}

export interface RebarWeightResult {
  rows: RebarWeightRow[];
  totalKg: number;
  /** Hao hụt/nối chồng nếu áp (mặc định 1.0 = không cộng — QS tự quyết hệ số). */
  wasteFactor: number;
}

/**
 * kg = Σ(chiều dài × đơn trọng). Chiều dài do NGƯỜI DÙNG/bảng thống kê cấp — hàm
 * này KHÔNG bịa chiều dài. `wasteFactor` (nối chồng+hao hụt, vd 1.05) mặc định 1.0
 * để không tự cộng khống; QS chủ động áp. PURE.
 */
export function computeRebarWeight(inputs: RebarLengthInput[], wasteFactor = 1.0): RebarWeightResult {
  const rows: RebarWeightRow[] = inputs
    .filter((i) => i.totalLengthM > 0 && i.diameter > 0)
    .map((i) => {
      const uw = unitWeightOf(i.diameter);
      return { diameter: i.diameter, totalLengthM: i.totalLengthM, unitWeightKgM: uw, weightKg: Math.round(i.totalLengthM * uw * wasteFactor * 100) / 100 };
    })
    .sort((a, b) => a.diameter - b.diameter);
  const totalKg = Math.round(rows.reduce((s, r) => s + r.weightKg, 0) * 100) / 100;
  return { rows, totalKg, wasteFactor };
}

/**
 * Số đai trên 1 cấu kiện = floor(L/a) + 1 (công thức chuẩn). Deterministic khi ĐÃ
 * biết chiều dài cấu kiện L (mm) và khoảng cách a (mm). Không có L → không suy.
 */
export function stirrupCount(memberLengthMm: number, spacingMm: number): number {
  if (memberLengthMm <= 0 || spacingMm <= 0) return 0;
  return Math.floor(memberLengthMm / spacingMm) + 1;
}
