// Rescue layer: khi model trả bảng markdown khối lượng thay vì JSON actions,
// chuyển bảng thành update_cells để đề xuất vẫn ghi được vào sheet.
// Đồng thời là nơi định nghĩa layout 9 cột chuẩn của sheet Khối lượng + format_sheet.
import { Action, EstimateState, Sheet } from './estimate.types';
import { parseExcelCell } from './reducer';

// Layout chuẩn 9 cột: A=STT B=Mã hiệu C=Tên công tác D=Đơn vị E=Khối lượng
// F=Đơn giá G=Thành tiền H=Nguồn I=Diễn giải. Ô thiếu giá trị → "".
const COLUMN_ORDER = [
  'stt',
  'code',
  'name',
  'unit',
  'quantity',
  'unitPrice',
  'total',
  'source',
  'note',
] as const;
type ColumnKey = (typeof COLUMN_ORDER)[number];

const HEADER_LABELS: Record<ColumnKey, string> = {
  stt: 'STT',
  code: 'Mã hiệu',
  name: 'Tên công tác',
  unit: 'Đơn vị',
  quantity: 'Khối lượng',
  unitPrice: 'Đơn giá',
  total: 'Thành tiền',
  source: 'Nguồn',
  note: 'Diễn giải',
};

const COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;

/** Độ rộng cột (px) theo thứ tự A→I. */
export const TAKEOFF_COL_WIDTHS_PX = [40, 110, 320, 60, 90, 110, 130, 170, 420] as const;

/** Chỉ số cột số (E/F/G) — căn phải. */
const NUMERIC_COL_INDEXES = [4, 5, 6];

const THIN_BORDER = { s: 1, cl: { rgb: '#d0d0d0' } };
const CELL_BORDER = { t: THIN_BORDER, b: THIN_BORDER, l: THIN_BORDER, r: THIN_BORDER };

/** Header: đậm, nền xanh đậm, chữ trắng, căn giữa, khung mảnh. */
export const TAKEOFF_HEADER_STYLE = {
  bl: 1,
  bg: { rgb: '#1e3a5f' },
  cl: { rgb: '#ffffff' },
  ht: 2,
  vt: 2,
  bd: CELL_BORDER,
};

/** Dòng chú thích giả định: italic, xám. */
export const TAKEOFF_FOOTNOTE_STYLE = { it: 1, cl: { rgb: '#8a8f98' } };

const REQUIRED_KEYS = ['stt', 'code', 'name', 'unit', 'quantity', 'note'] as const;

/** Dòng chuẩn — 6 cột lõi + 3 cột optional (giá/nguồn). */
export type RescueRow = Record<(typeof REQUIRED_KEYS)[number], string> &
  Partial<Record<'unitPrice' | 'total' | 'source', string>>;

/** Bỏ dấu tiếng Việt + lowercase để so khớp fuzzy. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim();
}

function detectColumn(header: string): ColumnKey | null {
  const h = normalize(header);
  if (!h) return null;
  if (h === 'stt' || h === 'tt' || h.includes('stt')) return 'stt';
  if (h.includes('ma hieu') || h.includes('ma dinh muc') || h === 'ma') return 'code';
  if (h.includes('don vi') || h === 'dvt' || h === 'dv') return 'unit';
  if (h.includes('don gia')) return 'unitPrice';
  if (h.includes('thanh tien')) return 'total';
  if (h.includes('nguon')) return 'source';
  if (h.includes('ten cong tac') || h.includes('noi dung') || h.includes('cong tac') || h.includes('ten')) return 'name';
  if (h.includes('khoi luong') || h === 'kl' || h.includes('so luong')) return 'quantity';
  if (h.includes('ghi chu') || h.includes('dien giai')) return 'note';
  return null;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');
}

interface ParsedTable {
  columnMap: Partial<Record<ColumnKey, number>>; // key → index cột trong bảng markdown
  rows: string[][];
}

/** Tìm bảng markdown đầu tiên có header khớp ≥3 cột nhận diện được. */
function extractTable(message: string): ParsedTable | null {
  const lines = message.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    const headerCells = splitRow(lines[i]);
    if (headerCells.length < 3 || isSeparatorRow(headerCells)) continue;
    const columnMap: Partial<Record<ColumnKey, number>> = {};
    headerCells.forEach((cell, idx) => {
      const key = detectColumn(cell);
      if (key && columnMap[key] === undefined) columnMap[key] = idx;
    });
    if (Object.keys(columnMap).length < 3) continue;

    const rows: string[][] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.includes('|')) {
        if (rows.length > 0) break;
        continue;
      }
      const cells = splitRow(line);
      if (isSeparatorRow(cells)) continue;
      if (cells.every((c) => c === '')) continue;
      rows.push(cells);
    }
    if (rows.length === 0) return null;
    return { columnMap, rows };
  }
  return null;
}

/** Tìm sheet đích: hint → tên chứa "khối lượng" → sheet đầu tiên. */
function pickTargetSheet(sheets: Sheet[], sheetNameHint?: string): Sheet | null {
  if (sheets.length === 0) return null;
  if (sheetNameHint) {
    const hint = normalize(sheetNameHint);
    const byHint = sheets.find((s) => normalize(s.name).includes(hint));
    if (byHint) return byHint;
  }
  const byName = sheets.find((s) => normalize(s.name).includes('khoi luong'));
  return byName ?? sheets[0];
}

function cellValueText(cell: unknown): string {
  if (cell == null || typeof cell !== 'object') return '';
  const c = cell as { v?: unknown; f?: unknown };
  if (c.f != null && String(c.f) !== '') return `=${c.f}`;
  if (c.v == null) return '';
  return String(c.v);
}

/** Dòng occupied cuối cùng (1-based); 0 nếu sheet trống. */
function lastOccupiedRow(sheet: Sheet): number {
  const cellData = (sheet.data?.cellData ?? {}) as Record<string, Record<string, unknown>>;
  let last = 0;
  for (const [rKey, rowData] of Object.entries(cellData)) {
    if (!rowData) continue;
    const occupied = Object.values(rowData).some((c) => cellValueText(c) !== '');
    if (occupied) last = Math.max(last, Number(rKey) + 1); // cellData 0-based
  }
  return last;
}

function currentValueAt(sheet: Sheet, cell: string): string {
  const { row, col } = parseExcelCell(cell);
  const cellData = (sheet.data?.cellData ?? {}) as Record<string, Record<string, unknown>>;
  return cellValueText(cellData[String(row)]?.[String(col)]);
}

export interface TableRescueResult {
  actions: Action[];
  sheetName: string;
  startRow: number;
  endRow: number; // dòng dữ liệu cuối (không tính chú thích)
  /** format_sheet cho vùng vừa ghi (widths + header + border + căn số). */
  formatAction: Action;
  /** Dòng chú thích giả định (nếu có). */
  footnoteRow?: number;
}

/**
 * format_sheet cho layout 9 cột chuẩn: widths A→I, header style (nếu có header),
 * border mảnh 4 cạnh mọi ô dữ liệu, cột E/F/G căn phải, chú thích italic xám.
 * Không zebra — nền sáng cứng chói trên dark mode (FE remap zinc).
 */
export function buildTakeoffFormatAction(
  sheetId: string,
  headerRow: number | null,
  dataStartRow: number,
  dataEndRow: number,
  footnoteRow?: number,
): Action {
  const columnWidths: Record<string, number> = {};
  TAKEOFF_COL_WIDTHS_PX.forEach((w, i) => (columnWidths[String(i)] = w));

  const cells: { cell: string; s: Record<string, any> }[] = [];
  if (headerRow != null) {
    COL_LETTERS.forEach((letter) => cells.push({ cell: `${letter}${headerRow}`, s: TAKEOFF_HEADER_STYLE }));
  }
  for (let r = dataStartRow; r <= dataEndRow; r++) {
    COL_LETTERS.forEach((letter, i) => {
      const s: Record<string, any> = { bd: CELL_BORDER, vt: 2 };
      if (NUMERIC_COL_INDEXES.includes(i)) s.ht = 3; // số căn phải
      cells.push({ cell: `${letter}${r}`, s });
    });
  }
  if (footnoteRow != null) cells.push({ cell: `B${footnoteRow}`, s: TAKEOFF_FOOTNOTE_STYLE });

  return { type: 'format_sheet', sheetId, columnWidths, cells };
}

/**
 * Parse bảng markdown khối lượng trong message → update_cells ghi vào dòng trống
 * đầu tiên của sheet khối lượng (kèm format_sheet cuối). Trả [] nếu không có
 * bảng hợp lệ / không có sheet.
 */
export function tableToUpdateCells(
  message: string,
  state: EstimateState,
  sheetNameHint?: string,
): Action[] {
  const r = tableToUpdateCellsDetailed(message, state, sheetNameHint);
  return r ? [...r.actions, r.formatAction] : [];
}

export function tableToUpdateCellsDetailed(
  message: string,
  state: EstimateState,
  sheetNameHint?: string,
): TableRescueResult | null {
  const table = extractTable(message);
  if (!table) return null;
  const rows = table.rows.map((cells) => {
    const record: Partial<Record<ColumnKey, string>> = {};
    COLUMN_ORDER.forEach((key) => {
      const idx = table.columnMap[key];
      record[key] = idx !== undefined ? (cells[idx] ?? '') : '';
    });
    return record as RescueRow;
  });
  return rowsToUpdateCells(rows, state, sheetNameHint);
}

/**
 * Ghi một dãy dòng (đã map theo layout 9 cột chuẩn) vào dòng trống đầu tiên
 * của sheet khối lượng. opts.footnote → 1 dòng chú thích giả định (cột B,
 * cách dòng dữ liệu cuối 1 dòng trống).
 */
export function rowsToUpdateCells(
  rows: RescueRow[],
  state: EstimateState,
  sheetNameHint?: string,
  opts?: { footnote?: string },
): TableRescueResult | null {
  if (rows.length === 0) return null;
  const sheet = pickTargetSheet(state.sheets ?? [], sheetNameHint);
  if (!sheet) return null;

  const actions: Action[] = [];
  const last = lastOccupiedRow(sheet);
  let row = last === 0 ? 1 : last + 2; // sheet trống → dòng 1; ngược lại sau dòng occupied cuối + 1
  const startRow = row;

  const push = (cell: string, newValue: string) => {
    actions.push({
      type: 'update_cells',
      sheetId: sheet.id,
      cell,
      oldValue: currentValueAt(sheet, cell),
      newValue,
    });
  };

  let headerRow: number | null = null;
  if (last === 0) {
    headerRow = row;
    COLUMN_ORDER.forEach((key, i) => push(`${COL_LETTERS[i]}${row}`, HEADER_LABELS[key]));
    row++;
  }

  const dataStartRow = row;
  for (const record of rows) {
    COLUMN_ORDER.forEach((key, i) => push(`${COL_LETTERS[i]}${row}`, record[key] ?? ''));
    row++;
  }
  const endRow = row - 1;

  let footnoteRow: number | undefined;
  if (opts?.footnote) {
    footnoteRow = endRow + 2; // cách 1 dòng trống
    push(`B${footnoteRow}`, opts.footnote);
  }

  const formatAction = buildTakeoffFormatAction(sheet.id, headerRow, dataStartRow, endRow, footnoteRow);
  return { actions, sheetName: sheet.name, startRow, endRow, formatAction, footnoteRow };
}

/**
 * upsert_takeoff ghi vào kho takeoff có cấu trúc (nguồn cho F1 export) nhưng
 * KHÔNG hiển thị trên sheet Univer — mirror mỗi item thành các ô nhìn thấy
 * được trong sheet "Khối lượng" để người dùng thấy ngay kết quả.
 */
export function takeoffActionsToUpdateCells(
  actions: Action[],
  state: EstimateState,
): TableRescueResult | null {
  const takeoffs = actions.filter((a: any) => a.type === 'upsert_takeoff') as any[];
  if (takeoffs.length === 0) return null;
  // Đã có update_cells đi kèm (model tự ghi sheet) → không mirror để tránh ghi đôi
  if (actions.some((a: any) => a.type === 'update_cells')) return null;
  const rows = takeoffs.map((t, i) => ({
    stt: String(i + 1),
    code: String(t.code ?? ''),
    name: String(t.name ?? ''),
    unit: String(t.unit ?? ''),
    quantity: t.quantity != null ? String(t.quantity) : '',
    note: String(t.note ?? ''),
  }));
  return rowsToUpdateCells(rows, state);
}
