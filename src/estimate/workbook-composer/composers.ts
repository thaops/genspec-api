/**
 * Semantic Layer — các "composer" thuần sinh derived sheet từ EstimateState + dữ liệu tính.
 *
 * NGUYÊN TẮC (theo GENSPEC-VISION):
 *  - Derived sheet = pure view. KHÔNG bịa số: mã trống để trống, giá thiếu ghi "cần QS".
 *  - Mỗi hàm nhận dữ liệu thô (không đụng DB) ⇒ test mutation-check được.
 *  - Thêm composer mới (Steel/Window/MEP…) = thêm hàm, KHÔNG sửa engine bóc tách.
 */
import {
  CostSummary,
  ProjectInfo,
  Sheet,
  TakeoffItem,
  ValidationReport,
} from '../estimate.types';
import { buildSheet, Row, vnd, WARN_STYLE } from './sheet-builder';

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
  validation: ValidationReport;
  drawings: DrawingLite[];
  typeCounts: EntityTypeCount[];
  doors: EntityLite[]; // door/window entities (đã cap ở service)
}

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

/** Chi phí theo nhóm công tác (group). */
function costByGroup(takeoff: TakeoffItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of takeoff) {
    const g = t.group || 'Khác';
    m.set(g, (m.get(g) ?? 0) + lineTotal(t));
  }
  return m;
}

// ---- 00. Dashboard ----
export function composeDashboard(input: ComposeInput): Sheet {
  const { name, projectInfo, takeoff, costSummary, validation, drawings, typeCounts } = input;
  const entTotal = typeCounts.reduce((s, c) => s + c.n, 0);
  const distinct = new Set(takeoff.map((t) => t.name.split(' (')[0])).size;
  const grp = costByGroup(takeoff);

  const rows: Row[] = [
    ['Chỉ tiêu', 'Giá trị'],
    ['Dự án', name || '—'],
    ['Tỉnh / Vùng giá', projectInfo.location || '—'],
    ['Số bản vẽ', drawings.length],
    ['Tổng đối tượng nhận diện', entTotal],
    ['Số công tác (dòng BOQ)', takeoff.length],
    ['Số công tác khác nhau', distinct],
  ];
  for (const [g, v] of [...grp.entries()].sort((a, b) => b[1] - a[1])) {
    rows.push([`— ${g}`, `${vnd(v)} đ`]);
  }
  rows.push(['TỔNG CHI PHÍ (gồm hệ số)', `${vnd(costSummary.total)} đ`]);
  rows.push(['Đơn giá đại diện họ mã', takeoff.filter((t) => t.familyRep).length]);
  rows.push([
    'Đơn giá ước lượng (cần kiểm chứng)',
    takeoff.filter((t) => t.estimated).length,
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
    rows.push([
      i + 1,
      t.code || '', // mã trống → để trống, KHÔNG bịa
      t.name,
      t.group || '',
      t.unit,
      Math.round((t.quantity ?? 0) * 1000) / 1000,
      (t.note || '').slice(0, 90),
      drw ? `${drw.discipline} · ${drw.name}`.slice(0, 40) : '',
      t.regionLabel || '',
      hasPrice ? t.unitPrice! : { v: '', s: WARN_STYLE }, // thiếu giá → ô trống tô cảnh báo
      (t.source || '').slice(0, 40),
      priceTier(t),
      hasPrice ? lineTotal(t) : { v: '', s: WARN_STYLE },
      warn ? { v: status, s: warn } : status,
    ]);
  });
  return buildSheet({
    id: 'boq-summary',
    name: '01. Tổng hợp BOQ (đầy đủ)',
    composerKey: 'boq-summary',
    rows,
    widths: [40, 90, 240, 150, 55, 80, 300, 150, 70, 90, 200, 130, 110, 130],
  });
}

// ---- 02. Validation (AI self-check) ----
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

// ---- 05. Door Schedule (data THẬT từ entity) ----
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
  if (rows.length === 1) rows.push(['—', '—', 'Chưa nhận diện cửa/lỗ mở', '', '', '', '']);
  return buildSheet({
    id: 'door-schedule',
    name: '05. Thống kê cửa',
    composerKey: 'door-schedule',
    title: `DOOR SCHEDULE — ${doors.length} cửa/lỗ mở nhận diện`,
    rows,
    widths: [40, 60, 100, 200, 90, 100, 210],
  });
}

// ---- 06. Cost Summary (nhóm + bậc chi phí A→F) ----
export function composeCostSummary(input: ComposeInput): Sheet {
  const { takeoff, costSummary: cs } = input;
  const grp = costByGroup(takeoff);
  const totAll = [...grp.values()].reduce((s, v) => s + v, 0) || 1;

  const rows: Row[] = [['Nhóm công tác', 'Số công tác', 'Thành tiền (đ)', '% chi phí']];
  for (const [g, v] of [...grp.entries()].sort((a, b) => b[1] - a[1])) {
    const n = takeoff.filter((t) => (t.group || 'Khác') === g).length;
    rows.push([g, n, vnd(v), `${((v / totAll) * 100).toFixed(1)}%`]);
  }
  rows.push(['TỔNG TRỰC TIẾP (chưa hệ số)', takeoff.length, vnd(totAll), '100%']);
  // Bậc chi phí A→F
  rows.push(['', '', '', '']);
  rows.push([{ v: 'BẬC CHI PHÍ (A→F)', s: { bl: 1 } }, '', '', '']);
  const ladder: [string, number][] = [
    ['A. Chi phí trực tiếp', cs.directTotal],
    ['B. Chi phí chung', cs.overhead],
    ['C. Thu nhập chịu thuế tính trước', cs.profit],
    ['D. Thuế VAT', cs.vat],
    ['E. Dự phòng', cs.contingency],
    ['F. TỔNG DỰ TOÁN', cs.total],
  ];
  for (const [k, v] of ladder) rows.push([k, '', vnd(v), '']);

  return buildSheet({
    id: 'cost-summary',
    name: '06. Tổng hợp chi phí',
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
