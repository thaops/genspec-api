/**
 * Helper dựng cellData theo shape Univer cho các derived sheet.
 * Tách riêng khỏi logic composer để test được thuần (không phụ thuộc DB).
 */
import { DerivedSheetMeta, GENSPEC_SHEET_GROUP, Sheet } from '../estimate.types';

/** Style ô header (nền xanh đậm, chữ trắng, canh giữa). */
export const HEAD_STYLE = {
  bl: 1,
  bg: { rgb: '#1e3a5f' },
  cl: { rgb: '#ffffff' },
  ht: 2,
  vt: 2,
};

/** Style ô tiêu đề lớn (dòng đầu sheet). */
export const TITLE_STYLE = { bl: 1, fs: 14, cl: { rgb: '#1e3a5f' } };

/** Style highlight cảnh báo (ô "cần QS" / giá ước lượng). */
export const WARN_STYLE = { bg: { rgb: '#fdf0d5' } };

export type CellValue = string | number | null | undefined;
export interface Cell {
  v: CellValue;
  s?: Record<string, any>;
  f?: string; // công thức Univer (vd "=F2*J2") — Univer tự recalc, `v` là cache hiển thị
}
/** Một dòng = mảng ô (giá trị thô hoặc {v,s} khi cần style riêng). */
export type Row = Array<CellValue | Cell>;

function toCell(x: CellValue | Cell): Cell {
  if (x !== null && typeof x === 'object' && 'v' in x) return x;
  return { v: x as CellValue };
}

export interface SheetSpec {
  id: string;
  name: string;
  composerKey: string;
  title?: string; // dòng tiêu đề lớn (nếu có, đẩy header xuống 2 dòng)
  rows: Row[]; // rows[0] = header (tô HEAD_STYLE)
  widths?: number[]; // độ rộng cột (px)
  header?: boolean; // rows[0] là header? mặc định true
}

/** Dựng cellData: { rowIdx: { colIdx: { v, s? } } }. */
function buildCellData(rows: Row[], title: string | undefined, header: boolean) {
  const out: Record<string, Record<string, Cell>> = {};
  let base = 0;
  if (title) {
    out['0'] = { '0': { v: title, s: TITLE_STYLE } };
    base = 2;
  }
  rows.forEach((row, i) => {
    const rr = String(i + base);
    out[rr] = {};
    row.forEach((raw, c) => {
      const cell = toCell(raw);
      if (header && i === 0) cell.s = { ...(cell.s ?? {}), ...HEAD_STYLE };
      out[rr][String(c)] = cell;
    });
  });
  return out;
}

/** Dựng một derived Sheet hoàn chỉnh (đã gắn metadata origin=genspec, read-only). */
export function buildSheet(spec: SheetSpec): Sheet {
  const header = spec.header !== false;
  const ncol = spec.rows.reduce((m, r) => Math.max(m, r.length), 12);
  const data: any = {
    cellData: buildCellData(spec.rows, spec.title, header),
    rowCount: Math.max(60, spec.rows.length + 12),
    columnCount: ncol + 2,
    // Khoá 2 dòng đầu (tiêu đề + header) khi cuộn.
    freeze: { xSplit: 0, ySplit: spec.title ? 3 : 1, startRow: -1, startColumn: -1 },
  };
  if (spec.widths) {
    data.columnData = {};
    spec.widths.forEach((w, i) => (data.columnData[String(i)] = { w }));
  }
  const meta: DerivedSheetMeta = {
    origin: 'genspec',
    group: GENSPEC_SHEET_GROUP,
    composerKey: spec.composerKey,
    generated: true,
    readOnly: true,
  };
  return { id: `genspec_${spec.composerKey}`, name: spec.name, metadata: meta, data };
}

/** Format số nguyên có phân tách nghìn kiểu VN (1234567 → "1.234.567"). */
export function vnd(n: number): string {
  return Math.round(n || 0)
    .toLocaleString('en-US')
    .replace(/,/g, '.');
}
