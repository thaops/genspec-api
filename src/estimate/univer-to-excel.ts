import * as ExcelJS from 'exceljs';

// Pure Univer snapshot → ExcelJS conversion. Nghịch đảo của excel-to-univer.ts.
// Mục tiêu: export ra đúng Workbook người dùng đang thấy (giá trị + formula +
// style + merge + width/height + hidden + freeze), KHÔNG ép về template GenSpec.

type AnyRec = Record<string, any>;

export interface UniverSheetLike {
  id?: string;
  name?: string;
  data?: AnyRec;
}

// Univer border style number → ExcelJS border style name (inverse of BORDER_STYLE)
const BORDER_NAME: Record<number, ExcelJS.BorderStyle> = {
  1: 'thin',
  3: 'dotted',
  4: 'dashed',
  8: 'medium',
  10: 'double',
  13: 'thick',
};

/** '#RRGGBB' → { argb: 'FFRRGGBB' } */
function toArgb(rgb: any): { argb: string } | undefined {
  if (typeof rgb !== 'string') return undefined;
  const hex = rgb.replace('#', '').toUpperCase();
  if (hex.length === 6) return { argb: 'FF' + hex };
  if (hex.length === 8) return { argb: hex };
  return undefined;
}

function styleToFont(s: AnyRec): Partial<ExcelJS.Font> | undefined {
  const f: AnyRec = {};
  if (s.bl) f.bold = true;
  if (s.it) f.italic = true;
  if (s.ul?.s) f.underline = s.ul.s === 2 ? 'double' : true;
  if (s.st?.s) f.strike = true;
  if (typeof s.fs === 'number') f.size = s.fs;
  if (typeof s.ff === 'string') f.name = s.ff;
  const cl = toArgb(s.cl?.rgb);
  if (cl) f.color = cl;
  if (s.va === 2) f.vertAlign = 'superscript';
  else if (s.va === 1) f.vertAlign = 'subscript';
  return Object.keys(f).length ? (f as Partial<ExcelJS.Font>) : undefined;
}

function styleToAlignment(s: AnyRec): Partial<ExcelJS.Alignment> | undefined {
  const a: AnyRec = {};
  const HT: Record<number, string> = { 1: 'left', 2: 'center', 3: 'right' };
  const VT: Record<number, string> = { 1: 'top', 2: 'middle', 3: 'bottom' };
  if (HT[s.ht]) a.horizontal = HT[s.ht];
  if (VT[s.vt]) a.vertical = VT[s.vt];
  if (s.tb === 3) a.wrapText = true;
  if (typeof s.tr?.a === 'number' && s.tr.a !== 0) {
    // inverse của excel-to-univer: góc âm ⇒ Excel 90..180
    a.textRotation = s.tr.a < 0 ? 90 - s.tr.a : s.tr.a;
  }
  return Object.keys(a).length ? (a as Partial<ExcelJS.Alignment>) : undefined;
}

function styleToBorder(bd: AnyRec | undefined): Partial<ExcelJS.Borders> | undefined {
  if (!bd) return undefined;
  const out: AnyRec = {};
  const map: Record<string, string> = { t: 'top', b: 'bottom', l: 'left', r: 'right' };
  for (const [key, side] of Object.entries(map)) {
    const line = bd[key];
    if (!line) continue;
    out[side] = {
      style: BORDER_NAME[line.s] ?? 'thin',
      ...(toArgb(line.cl?.rgb) ? { color: toArgb(line.cl?.rgb) } : {}),
    };
  }
  const down = bd.tl_br;
  const up = bd.bl_tr;
  if (down || up) {
    const line = down ?? up;
    out.diagonal = {
      style: BORDER_NAME[line.s] ?? 'thin',
      ...(toArgb(line.cl?.rgb) ? { color: toArgb(line.cl?.rgb) } : {}),
      ...(down ? { down: true } : {}),
      ...(up ? { up: true } : {}),
    };
  }
  return Object.keys(out).length ? (out as Partial<ExcelJS.Borders>) : undefined;
}

/** Univer rich-text doc (p) → ExcelJS richText runs. Trả undefined nếu không dựng được. */
function docToRichText(p: AnyRec | undefined): ExcelJS.RichText[] | undefined {
  const stream: string = p?.body?.dataStream;
  if (typeof stream !== 'string') return undefined;
  const text = stream.replace(/\r\n$/, '');
  if (!text) return undefined;
  const runs: Array<{ st: number; ed: number; ts?: AnyRec }> = Array.isArray(p?.body?.textRuns) ? p!.body.textRuns : [];
  if (!runs.length) return undefined;
  const sorted = [...runs].sort((a, b) => a.st - b.st);
  const out: ExcelJS.RichText[] = [];
  let cursor = 0;
  for (const run of sorted) {
    const st = Math.max(0, Math.min(run.st, text.length));
    const ed = Math.max(st, Math.min(run.ed, text.length));
    if (st > cursor) out.push({ text: text.slice(cursor, st) });
    if (ed > st) {
      const font = styleToFont(run.ts ?? {});
      out.push({ text: text.slice(st, ed), ...(font ? { font: font as ExcelJS.Font } : {}) });
    }
    cursor = Math.max(cursor, ed);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out.length ? out : undefined;
}

/** Lấy style registry (được importExcel gắn vào data._styles của sheet đầu). */
function extractStyles(sheets: UniverSheetLike[]): AnyRec {
  for (const sheet of sheets) {
    const s = (sheet.data as AnyRec)?._styles;
    if (s && typeof s === 'object') return s;
  }
  return {};
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  let base = (name || 'Sheet').replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || 'Sheet';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${i++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Dựng ExcelJS.Workbook từ danh sách sheet Univer trong EstimateState.
 * Không tạo sheet mới, không đổi thứ tự, không chuẩn hoá layout.
 */
export function univerSheetsToExcel(sheets: UniverSheetLike[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const styles = extractStyles(sheets ?? []);
  const usedNames = new Set<string>();

  for (const sheet of sheets ?? []) {
    const data: AnyRec = sheet.data ?? {};
    const ws = wb.addWorksheet(sanitizeSheetName(String(sheet.name ?? ''), usedNames));

    // Column width (px → char units) + hidden
    const columnData: AnyRec = data.columnData ?? {};
    for (const [ci, col] of Object.entries(columnData)) {
      const idx = Number(ci);
      if (!Number.isFinite(idx)) continue;
      const target = ws.getColumn(idx + 1) as AnyRec;
      if (typeof (col as AnyRec).w === 'number' && (col as AnyRec).w > 0) {
        target.width = Math.round(((col as AnyRec).w / 8) * 100) / 100;
      }
      if ((col as AnyRec).hd) target.hidden = true;
    }

    // Row height (px → pt) + hidden
    const rowData: AnyRec = data.rowData ?? {};
    for (const [ri, row] of Object.entries(rowData)) {
      const idx = Number(ri);
      if (!Number.isFinite(idx)) continue;
      const target = ws.getRow(idx + 1) as AnyRec;
      if (typeof (row as AnyRec).h === 'number' && (row as AnyRec).h > 0) {
        target.height = Math.round(((row as AnyRec).h / 1.333) * 100) / 100;
      }
      if ((row as AnyRec).hd) target.hidden = true;
    }

    // Cells
    const cellData: AnyRec = data.cellData ?? {};
    for (const [ri, rowCells] of Object.entries(cellData)) {
      const r = Number(ri);
      if (!Number.isFinite(r) || !rowCells || typeof rowCells !== 'object') continue;
      for (const [ci, raw] of Object.entries(rowCells as AnyRec)) {
        const c = Number(ci);
        if (!Number.isFinite(c) || !raw || typeof raw !== 'object') continue;
        const entry = raw as AnyRec;
        const cell = ws.getCell(r + 1, c + 1);

        const rich = docToRichText(entry.p);
        if (entry.f) {
          const formula = String(entry.f).replace(/^=/, '');
          cell.value = { formula, result: entry.v ?? undefined } as ExcelJS.CellFormulaValue;
        } else if (rich) {
          cell.value = { richText: rich };
        } else if (entry.v !== undefined && entry.v !== null && entry.v !== '') {
          cell.value = entry.v;
        }

        const s: AnyRec | undefined = entry.s ? (typeof entry.s === 'string' ? styles[entry.s] : entry.s) : undefined;
        if (!s) continue;

        const bg = toArgb(s.bg?.rgb);
        if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: bg };
        const font = styleToFont(s);
        if (font) cell.font = font as ExcelJS.Font;
        const alignment = styleToAlignment(s);
        if (alignment) cell.alignment = alignment as ExcelJS.Alignment;
        const border = styleToBorder(s.bd);
        if (border) cell.border = border as ExcelJS.Borders;
        if (s.n?.pattern) cell.numFmt = String(s.n.pattern);
      }
    }

    // Merges
    for (const m of (data.mergeData ?? []) as AnyRec[]) {
      if (!m) continue;
      try {
        ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
      } catch {
        /* vùng chồng lấn / không hợp lệ → bỏ qua, không làm hỏng cả file */
      }
    }

    // Freeze panes
    const freeze = data.freeze as AnyRec | undefined;
    if (freeze && ((freeze.xSplit ?? 0) > 0 || (freeze.ySplit ?? 0) > 0)) {
      ws.views = [
        { state: 'frozen', xSplit: freeze.xSplit ?? 0, ySplit: freeze.ySplit ?? 0 },
      ];
    }

    if (typeof data.defaultColumnWidth === 'number' && data.defaultColumnWidth > 0) {
      (ws.properties as AnyRec).defaultColWidth = Math.round((data.defaultColumnWidth / 8) * 100) / 100;
    }
    if (typeof data.defaultRowHeight === 'number' && data.defaultRowHeight > 0) {
      (ws.properties as AnyRec).defaultRowHeight = Math.round((data.defaultRowHeight / 1.333) * 100) / 100;
    }
  }

  if (wb.worksheets.length === 0) wb.addWorksheet('Sheet1');
  return wb;
}

/** Univer sheets → .xlsx buffer. */
export async function univerSheetsToXlsxBuffer(sheets: UniverSheetLike[]): Promise<Buffer> {
  const wb = univerSheetsToExcel(sheets);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
