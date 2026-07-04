// Rescue layer: khi model trả bảng markdown khối lượng thay vì JSON actions,
// chuyển bảng thành update_cells để đề xuất vẫn ghi được vào sheet.
import { Action, EstimateState, Sheet } from './estimate.types';
import { parseExcelCell } from './reducer';

const COLUMN_ORDER = ['stt', 'code', 'name', 'unit', 'quantity', 'note'] as const;
type ColumnKey = (typeof COLUMN_ORDER)[number];

const HEADER_LABELS: Record<ColumnKey, string> = {
  stt: 'STT',
  code: 'Mã hiệu định mức',
  name: 'Tên công tác',
  unit: 'Đơn vị',
  quantity: 'Khối lượng',
  note: 'Ghi chú',
};

/** Bỏ dấu tiếng Việt + lowercase để so khớp fuzzy. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim();
}

function detectColumn(header: string): ColumnKey | null {
  const h = normalize(header);
  if (!h) return null;
  if (h === 'stt' || h === 'tt' || h.includes('stt')) return 'stt';
  if (h.includes('ma hieu') || h.includes('ma dinh muc') || h === 'ma') return 'code';
  if (h.includes('ten cong tac') || h.includes('noi dung') || h.includes('cong tac') || h.includes('ten')) return 'name';
  if (h.includes('don vi') || h === 'dvt' || h === 'dv') return 'unit';
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
  endRow: number;
}

/**
 * Parse bảng markdown khối lượng trong message → update_cells ghi vào dòng trống
 * đầu tiên của sheet khối lượng. Trả [] nếu không có bảng hợp lệ / không có sheet.
 */
export function tableToUpdateCells(
  message: string,
  state: EstimateState,
  sheetNameHint?: string,
): Action[] {
  return tableToUpdateCellsDetailed(message, state, sheetNameHint)?.actions ?? [];
}

export function tableToUpdateCellsDetailed(
  message: string,
  state: EstimateState,
  sheetNameHint?: string,
): TableRescueResult | null {
  const table = extractTable(message);
  if (!table) return null;
  const sheet = pickTargetSheet(state.sheets ?? [], sheetNameHint);
  if (!sheet) return null;

  const colLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
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

  if (last === 0) {
    COLUMN_ORDER.forEach((key, i) => push(`${colLetters[i]}${row}`, HEADER_LABELS[key]));
    row++;
  }

  for (const cells of table.rows) {
    COLUMN_ORDER.forEach((key, i) => {
      const idx = table.columnMap[key];
      const value = idx !== undefined ? (cells[idx] ?? '') : '';
      push(`${colLetters[i]}${row}`, value);
    });
    row++;
  }

  return { actions, sheetName: sheet.name, startRow, endRow: row - 1 };
}
