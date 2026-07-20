/**
 * Semantic Layer — các "composer" thuần sinh derived sheet từ EstimateState + dữ liệu tính.
 *
 * NGUYÊN TẮC (theo GENSPEC-VISION):
 *  - Derived sheet = pure view. KHÔNG bịa số: mã trống để trống, giá thiếu ghi "cần QS".
 *  - Mỗi hàm nhận dữ liệu thô (không đụng DB) ⇒ test mutation-check được.
 *  - Thêm composer mới (Steel/Window/MEP…) = thêm hàm, KHÔNG sửa engine bóc tách.
 *
 * PHASE A — CÔNG THỨC SỐNG:
 *  Ô suy ra (thành tiền, tổng nhóm, bậc A→F, KPI dashboard, thống kê cửa) phát ra CÔNG THỨC
 *  Univer (`f`) + kèm `v` = giá trị precompute (cache hiển thị ngay). Univer có sẵn formula
 *  engine ⇒ sửa ô nguồn → tự recalc cả workbook trong session, KHÔNG cần regenerate.
 *  Ô cơ sở (khối lượng, đơn giá) giữ là GIÁ TRỊ. Không tự viết calc engine.
 */
import {
  CostSummary,
  Markups,
  ProjectInfo,
  Sheet,
  TakeoffItem,
  ValidationReport,
} from '../estimate.types';
import { buildSheet, Cell, Row, WARN_STYLE } from './sheet-builder';

export interface DrawingLite {
  id: string;
  name: string;
  discipline: string; // KT | KC | DIEN | NUOC | KHAC
}
export interface EntityLite {
  drawingId: string;
  type: string;
  layer: string;
  w: number; // boundingBox width
  h: number; // boundingBox height
}
export interface EntityTypeCount {
  drawingId: string;
  type: string;
  n: number;
}

export interface ComposeInput {
  name: string;
  projectInfo: ProjectInfo;
  takeoff: TakeoffItem[];
  costSummary: CostSummary;
  markups: Markups;
  validation: ValidationReport;
  drawings: DrawingLite[];
  typeCounts: EntityTypeCount[];
  doors: EntityLite[]; // door/window entities (đã cap ở service)
}

// ---- tên sheet (dùng trong cross-sheet reference) ----
export const BOQ_SHEET = '01. Tổng hợp BOQ (đầy đủ)';
export const COST_SHEET = '06. Tổng hợp chi phí';
const qn = (n: string) => `'${n.replace(/'/g, "''")}'`; // quote sheet name cho formula

/** Ô công thức: giữ `v` (precompute, cache) + `f` (công thức Univer tự recalc). */
const fc = (formula: string, cache: number): Cell => ({ v: cache, f: formula });

// ---- helpers (thuần) ----

const lineTotal = (t: TakeoffItem): number => Math.round((t.unitPrice ?? 0) * (t.quantity ?? 0));

function priceTier(t: TakeoffItem): string {
  if (t.familyRep) return 'Đại diện họ mã';
  if (t.estimated) return 'Ước lượng';
  if (t.unitPrice != null && t.unitPrice > 0) return 'Chính thống';
  return '—';
}

/** drawingId nhúng trong id convention `tk_engine_<24hex>_...` (takeoff không có field drawingId). */
export function drawingIdOfTakeoff(id: string): string | null {
  const m = /^tk_engine_([0-9a-fA-F]{24})_/.exec(id ?? '');
  return m ? m[1] : null;
}

/** Chi phí theo nhóm công tác (group), giữ thứ tự chèn. */
function costByGroup(takeoff: TakeoffItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of takeoff) {
    const g = t.group || 'Khác';
    m.set(g, (m.get(g) ?? 0) + lineTotal(t));
  }
  return m;
}
/** Nhóm đã sắp theo chi phí giảm dần — DÙNG CHUNG cho Dashboard & Cost Summary để địa chỉ khớp. */
function sortedGroups(takeoff: TakeoffItem[]): [string, number][] {
  return [...costByGroup(takeoff).entries()].sort((a, b) => b[1] - a[1]);
}

// ---- BOQ layout (không title → header ở cellData row0 = A1 row1, data từ A1 row2) ----
const BOQ_FIRST = 2;
const boqLast = (n: number) => Math.max(BOQ_FIRST, n + 1); // A1 row cuối vùng data

// ---- Cost layout (có title → base=2; A1 row = rowIndex + 3) ----
// rows: [header, ...G groups, TỔNG TRỰC TIẾP, blank, "BẬC", A,B,C,D,E,F]
const costGroupRow = (g: number) => 4 + g; // A1 row của group thứ g (0-based)
const costDirectTotalRow = (G: number) => 4 + G; // TỔNG TRỰC TIẾP
const costLadderRow = (G: number) => ({
  A: G + 7, B: G + 8, C: G + 9, D: G + 10, E: G + 11, F: G + 12,
});

// ---- 00. Dashboard ----
export function composeDashboard(input: ComposeInput): Sheet {
  const { name, projectInfo, takeoff, costSummary, validation, drawings, typeCounts } = input;
  const entTotal = typeCounts.reduce((s, c) => s + c.n, 0);
  const distinct = new Set(takeoff.map((t) => t.name.split(' (')[0])).size;
  const groups = sortedGroups(takeoff);
  const G = groups.length;
  const n = takeoff.length;
  const bLast = boqLast(n);
  const B = qn(BOQ_SHEET);
  const hasData = n > 0;

  // Số công tác (đếm STT cột A vùng data).
  const cntRows = hasData ? fc(`=COUNT(${B}!A${BOQ_FIRST}:A${bLast})`, n) : 0;
  // KPI đếm theo loại giá (cột L = "Loại giá").
  const cntFamily = takeoff.filter((t) => t.familyRep).length;
  const cntEst = takeoff.filter((t) => t.estimated).length;

  const rows: Row[] = [
    ['Chỉ tiêu', 'Giá trị'],
    ['Dự án', name || '—'],
    ['Tỉnh / Vùng giá', projectInfo.location || '—'],
    ['Số bản vẽ', drawings.length],
    ['Tổng đối tượng nhận diện', entTotal],
    ['Số công tác (dòng BOQ)', cntRows],
    ['Số công tác khác nhau', distinct],
  ];
  // Chi phí từng phần = SUMIF theo Nhóm (cột D) trên cột Thành tiền (cột M) của BOQ — tự recalc.
  for (const [g, v] of groups) {
    rows.push([
      `— ${g}`,
      hasData ? fc(`=SUMIF(${B}!D${BOQ_FIRST}:D${bLast},"${g}",${B}!M${BOQ_FIRST}:M${bLast})`, v) : 0,
    ]);
  }
  // TỔNG CHI PHÍ (gồm hệ số) = ô F tổng dự toán bên Cost Summary.
  rows.push([
    'TỔNG CHI PHÍ (gồm hệ số)',
    hasData ? fc(`=${qn(COST_SHEET)}!C${costLadderRow(G).F}`, costSummary.total) : 0,
  ]);
  rows.push([
    'Đơn giá đại diện họ mã',
    hasData ? fc(`=COUNTIF(${B}!L${BOQ_FIRST}:L${bLast},"Đại diện họ mã")`, cntFamily) : 0,
  ]);
  rows.push([
    'Đơn giá ước lượng (cần kiểm chứng)',
    hasData ? fc(`=COUNTIF(${B}!L${BOQ_FIRST}:L${bLast},"Ước lượng")`, cntEst) : 0,
  ]);
  rows.push([
    'Điểm tin cậy (AI self-check)',
    `${validation.score}/100 — ${validation.status}`,
  ]);

  return buildSheet({
    id: 'dashboard',
    name: '00. Dashboard',
    composerKey: 'dashboard',
    title: 'BẢNG ĐIỀU KHIỂN DỰ ÁN',
    rows,
    widths: [300, 260],
  });
}

// ---- 01. BOQ Summary (đầy đủ, làm giàu từng dòng) ----
export function composeBoqSummary(input: ComposeInput): Sheet {
  const { takeoff, drawings } = input;
  const discOf = new Map(drawings.map((d) => [d.id, d]));
  const header: Row = [
    'STT', 'Mã hiệu', 'Tên công tác', 'Nhóm', 'Đơn vị', 'Khối lượng',
    'Công thức / Diễn giải', 'Bản vẽ', 'Khu vực', 'Đơn giá', 'Nguồn giá',
    'Loại giá', 'Thành tiền', 'Trạng thái',
  ];
  const rows: Row[] = [header];
  takeoff.forEach((t, i) => {
    const did = drawingIdOfTakeoff(t.id);
    const drw = did ? discOf.get(did) : undefined;
    const hasPrice = t.unitPrice != null && t.unitPrice > 0;
    const status = !hasPrice ? 'Thiếu giá — cần QS' : t.estimated ? 'Cần kiểm chứng' : 'OK';
    const warn = !hasPrice || t.estimated ? WARN_STYLE : undefined;
    const a1 = i + BOQ_FIRST; // dòng A1 của dòng data này (header ở row1)
    rows.push([
      i + 1,
      t.code || '', // mã trống → để trống, KHÔNG bịa
      t.name,
      t.group || '',
      t.unit,
      Math.round((t.quantity ?? 0) * 1000) / 1000, // KL (cột F) — ô CƠ SỞ
      (t.note || '').slice(0, 90),
      drw ? `${drw.discipline} · ${drw.name}`.slice(0, 40) : '',
      t.regionLabel || '',
      hasPrice ? t.unitPrice! : { v: '', s: WARN_STYLE }, // Đơn giá (cột J) — ô CƠ SỞ
      (t.source || '').slice(0, 40),
      priceTier(t),
      // Thành tiền (cột M) = KL × Đơn giá — CÔNG THỨC, sửa KL/đơn giá là tự cập nhật.
      hasPrice ? fc(`=F${a1}*J${a1}`, lineTotal(t)) : { v: '', s: WARN_STYLE },
      warn ? { v: status, s: warn } : status,
    ]);
  });
  return buildSheet({
    id: 'boq-summary',
    name: BOQ_SHEET,
    composerKey: 'boq-summary',
    rows,
    widths: [40, 90, 240, 150, 55, 80, 300, 150, 70, 90, 200, 130, 110, 130],
  });
}

// ---- 02. Validation (AI self-check) — BE compute, không formula ----
export function composeValidation(input: ComposeInput): Sheet {
  const { validation } = input;
  const sev: Record<string, string> = { error: 'Lỗi', warn: 'Cảnh báo', info: 'Thông tin' };
  const rows: Row[] = [['Mức', 'Khu vực', 'Nội dung', 'Chi tiết']];
  for (const f of validation.findings) {
    rows.push([sev[f.severity] ?? f.severity, f.area, f.title, (f.detail || '').slice(0, 160)]);
  }
  for (const c of validation.consistency) {
    rows.push([sev[c.severity] ?? c.severity, c.kind, c.message, '']);
  }
  if (rows.length === 1) rows.push(['Thông tin', '—', 'Không có cảnh báo', '']);
  return buildSheet({
    id: 'validation',
    name: '02. Kiểm tra AI',
    composerKey: 'validation',
    title: `AI SELF-CHECK — ${validation.score}/100 (${validation.status})`,
    rows,
    widths: [90, 130, 320, 430],
  });
}

// ---- 03. AI Findings (thiếu sót DERIVED từ dữ liệu, không hardcode) ----
export function composeAiFindings(input: ComposeInput): Sheet {
  const { takeoff, validation } = input;
  const rows: Row[] = [['Hạng mục', 'Số dòng', 'Vấn đề', 'Đề xuất']];

  const noCode = takeoff.filter((t) => !(t.code || '').trim());
  const noPrice = takeoff.filter((t) => !(t.unitPrice != null && t.unitPrice > 0));
  const estimated = takeoff.filter((t) => t.estimated);
  if (noCode.length)
    rows.push(['Chưa chốt mã hiệu', noCode.length, 'Công tác chưa gán mã định mức', 'QS chốt biến thể mã theo mác/tiết diện']);
  if (noPrice.length)
    rows.push(['Chưa có đơn giá', noPrice.length, 'Không có nguồn giá → để trống, không bịa', 'Nạp đơn giá tỉnh / định mức hoặc QS nhập']);
  if (estimated.length)
    rows.push(['Đơn giá ước lượng', estimated.length, 'Giá do AI ước lượng, chưa có nguồn', 'QS kiểm chứng trước khi chốt']);
  const orphan = validation.consistency.filter((c) => c.kind === 'orphan_takeoff');
  if (orphan.length)
    rows.push(['Thiếu phân tích đơn giá', orphan.length, 'Công tác có KL nhưng chưa có phân tích VL/NC/M', 'Bổ sung phân tích đơn giá chi tiết']);

  if (rows.length === 1) rows.push(['—', 0, 'Không phát hiện thiếu sót', '']);
  return buildSheet({
    id: 'ai-findings',
    name: '03. Thiếu sót & cần QS',
    composerKey: 'ai-findings',
    title: 'HẠNG MỤC CẦN NGƯỜI QS XÁC NHẬN',
    rows,
    widths: [220, 80, 380, 340],
  });
}

// ---- 04. Drawing Index ----
export function composeDrawingIndex(input: ComposeInput): Sheet {
  const { drawings, typeCounts } = input;
  const byDrw = new Map<string, EntityTypeCount[]>();
  for (const c of typeCounts) {
    if (!byDrw.has(c.drawingId)) byDrw.set(c.drawingId, []);
    byDrw.get(c.drawingId)!.push(c);
  }
  const rows: Row[] = [['STT', 'Bản vẽ', 'Bộ môn', 'Đối tượng', 'Phân bố loại (top)']];
  drawings.forEach((d, i) => {
    const counts = (byDrw.get(d.id) ?? []).sort((a, b) => b.n - a.n);
    const total = counts.reduce((s, c) => s + c.n, 0);
    const top = counts.slice(0, 6).map((c) => `${c.type}:${c.n}`).join(', ');
    rows.push([i + 1, d.name.slice(0, 40), d.discipline, total, top]);
  });
  return buildSheet({
    id: 'drawing-index',
    name: '04. Chỉ mục bản vẽ',
    composerKey: 'drawing-index',
    title: 'DANH MỤC BẢN VẼ ĐÃ XỬ LÝ',
    rows,
    widths: [40, 320, 70, 90, 480],
  });
}

// ---- 05. Door Schedule (data THẬT từ entity + thống kê tự tham chiếu) ----
export function composeDoorSchedule(input: ComposeInput): Sheet {
  const { doors, drawings } = input;
  const discOf = new Map(drawings.map((d) => [d.id, d.discipline]));
  const rows: Row[] = [
    ['STT', 'Bản vẽ', 'Loại', 'Layer', 'Rộng (mm)', 'Cao/Sâu (mm)', 'Ghi chú'],
  ];
  doors.forEach((o, i) => {
    rows.push([
      i + 1,
      discOf.get(o.drawingId) || '—',
      o.type === 'door' ? 'Cửa đi' : 'Cửa sổ/lỗ mở',
      (o.layer || '').slice(0, 24),
      Math.round(o.w || 0),
      Math.round(o.h || 0),
      'đếm CÁI (m² cần mặt đứng)',
    ]);
  });
  if (rows.length === 1) {
    rows.push(['—', '—', 'Chưa nhận diện cửa/lỗ mở', '', '', '', '']);
  } else {
    // Thống kê tự tham chiếu cột Loại (cột C) của chính sheet này — data A1 row 4..(3+N).
    const N = doors.length;
    const first = 4;
    const last = 3 + N;
    const nDoor = doors.filter((o) => o.type === 'door').length;
    const nWin = N - nDoor;
    rows.push(['', '', '', '', '', '', '']);
    rows.push([{ v: 'THỐNG KÊ', s: { bl: 1 } }, '', '', '', '', '', '']);
    rows.push(['', '', 'Tổng cửa đi', '', fc(`=COUNTIF(C${first}:C${last},"Cửa đi")`, nDoor), '', '']);
    rows.push(['', '', 'Tổng cửa sổ/lỗ mở', '', fc(`=COUNTIF(C${first}:C${last},"Cửa sổ/lỗ mở")`, nWin), '', '']);
  }
  return buildSheet({
    id: 'door-schedule',
    name: '05. Thống kê cửa',
    composerKey: 'door-schedule',
    title: `DOOR SCHEDULE — ${doors.length} cửa/lỗ mở nhận diện`,
    rows,
    widths: [40, 60, 100, 200, 90, 100, 210],
  });
}

// ---- 06. Cost Summary (nhóm + bậc chi phí A→F) — TOÀN CÔNG THỨC ----
export function composeCostSummary(input: ComposeInput): Sheet {
  const { takeoff, costSummary: cs, markups: mk } = input;
  const groups = sortedGroups(takeoff);
  const G = groups.length;
  const totAll = groups.reduce((s, [, v]) => s + v, 0);
  const n = takeoff.length;
  const bLast = boqLast(n);
  const B = qn(BOQ_SHEET);
  const hasData = n > 0;
  const dtRow = costDirectTotalRow(G);
  const L = costLadderRow(G);

  const rows: Row[] = [['Nhóm công tác', 'Số công tác', 'Thành tiền (đ)', '% chi phí']];
  groups.forEach(([g, v], i) => {
    const r = costGroupRow(i);
    const cnt = takeoff.filter((t) => (t.group || 'Khác') === g).length;
    rows.push([
      g,
      cnt,
      // Thành tiền nhóm = SUMIF trên BOQ theo nhóm (cột A của sheet này giữ tên nhóm).
      hasData ? fc(`=SUMIF(${B}!D${BOQ_FIRST}:D${bLast},A${r},${B}!M${BOQ_FIRST}:M${bLast})`, v) : 0,
      // % = tỷ trọng trên tổng trực tiếp.
      hasData ? fc(`=IFERROR(C${r}/C${dtRow},0)`, totAll ? v / totAll : 0) : 0,
    ]);
  });
  // TỔNG TRỰC TIẾP = tổng các nhóm.
  rows.push([
    'TỔNG TRỰC TIẾP (chưa hệ số)',
    n,
    G > 0 ? fc(`=SUM(C${costGroupRow(0)}:C${costGroupRow(G - 1)})`, totAll) : 0,
    G > 0 ? fc(`=IFERROR(C${dtRow}/C${dtRow},0)`, totAll ? 1 : 0) : 0,
  ]);
  // Bậc chi phí A→F — công thức nối nhau, đổi 1 giá dưới BOQ là chạy hết chuỗi.
  rows.push(['', '', '', '']);
  rows.push([{ v: 'BẬC CHI PHÍ (A→F)', s: { bl: 1 } }, '', '', '']);
  const oh = mk.overheadPct / 100;
  const pr = mk.profitPct / 100;
  const vat = mk.vatPct / 100;
  const cont = mk.contingencyPct / 100;
  const preTax = cs.directTotal + cs.overhead + cs.profit;
  const ladder: [string, Cell | number][] = [
    ['A. Chi phí trực tiếp', fc(`=C${dtRow}`, cs.directTotal)],
    ['B. Chi phí chung', fc(`=ROUND(C${L.A}*${oh},0)`, cs.overhead)],
    ['C. Thu nhập chịu thuế tính trước', fc(`=ROUND((C${L.A}+C${L.B})*${pr},0)`, cs.profit)],
    ['D. Thuế VAT', fc(`=ROUND((C${L.A}+C${L.B}+C${L.C})*${vat},0)`, cs.vat)],
    ['E. Dự phòng', fc(`=ROUND((C${L.A}+C${L.B}+C${L.C}+C${L.D})*${cont},0)`, cs.contingency)],
    ['F. TỔNG DỰ TOÁN', fc(`=C${L.A}+C${L.B}+C${L.C}+C${L.D}+C${L.E}`, cs.total)],
  ];
  void preTax;
  for (const [k, v] of ladder) rows.push([k, '', v, '']);

  return buildSheet({
    id: 'cost-summary',
    name: COST_SHEET,
    composerKey: 'cost-summary',
    title: 'TỔNG HỢP CHI PHÍ',
    rows,
    widths: [280, 110, 170, 90],
  });
}

/** Sinh toàn bộ derived sheet theo đúng thứ tự hiển thị. */
export function composeAll(input: ComposeInput): Sheet[] {
  return [
    composeDashboard(input),
    composeBoqSummary(input),
    composeValidation(input),
    composeAiFindings(input),
    composeDrawingIndex(input),
    composeDoorSchedule(input),
    composeCostSummary(input),
  ];
}
