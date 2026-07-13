import * as ExcelJS from 'exceljs';

// Pure ExcelJS → Univer conversion. No Nest/Mongo deps.

// Standard Office theme palette (theme index 0..9)
const THEME_PALETTE = [
  'FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4',
  'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47',
];

// Classic legacy indexed palette (56 colors, indices 0..63 partially)
const INDEXED_PALETTE: Record<number, string> = {
  0: '000000', 1: 'FFFFFF', 2: 'FF0000', 3: '00FF00', 4: '0000FF',
  5: 'FFFF00', 6: 'FF00FF', 7: '00FFFF', 8: '000000', 9: 'FFFFFF',
  10: 'FF0000', 11: '00FF00', 12: '0000FF', 13: 'FFFF00', 14: 'FF00FF', 15: '00FFFF',
  16: '800000', 17: '008000', 18: '000080', 19: '808000', 20: '800080', 21: '008080',
  22: 'C0C0C0', 23: '808080', 24: '9999FF', 25: '993366', 26: 'FFFFCC', 27: 'CCFFFF',
  28: '660066', 29: 'FF8080', 30: '0066CC', 31: 'CCCCFF', 32: '000080', 33: 'FF00FF',
  34: 'FFFF00', 35: '00FFFF', 36: '800080', 37: '800000', 38: '008080', 39: '0000FF',
  40: '00CCFF', 41: 'CCFFFF', 42: 'CCFFCC', 43: 'FFFF99', 44: '99CCFF', 45: 'FF99CC',
  46: 'CC99FF', 47: 'FFCC99', 48: '3366FF', 49: '33CCCC', 50: '99CC00', 51: 'FFCC00',
  52: 'FF9900', 53: 'FF6600', 54: '666699', 55: '969696', 56: '003366', 57: '339966',
  58: '003300', 59: '333300', 60: '993300', 61: '993366', 62: '333399', 63: '333333',
};

// ExcelJS border style → Univer border style number
const BORDER_STYLE: Record<string, number> = {
  thin: 1, hair: 1,
  dotted: 3,
  dashed: 4, dashDot: 4, dashDotDot: 4,
  medium: 8, mediumDashed: 8, mediumDashDot: 8, mediumDashDotDot: 8, slantDashDot: 8,
  thick: 13,
  double: 10,
};

function applyTint(hex: string, tint: number): string {
  const parts = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((p) => {
    let c = parseInt(p, 16);
    c = tint > 0 ? Math.round(c + (255 - c) * tint) : Math.round(c * (1 + tint));
    c = Math.max(0, Math.min(255, c));
    return c.toString(16).padStart(2, '0').toUpperCase();
  });
  return parts.join('');
}

/** Resolve an ExcelJS color object ({argb} | {theme,tint} | {indexed}) to '#RRGGBB'. */
function resolveColor(color: any): string | undefined {
  if (!color) return undefined;
  if (color.argb && color.argb.length >= 6) {
    const argb = String(color.argb);
    return '#' + (argb.length === 8 ? argb.slice(2) : argb).toUpperCase();
  }
  if (typeof color.theme === 'number') {
    let hex = THEME_PALETTE[color.theme];
    if (!hex) return undefined;
    if (typeof color.tint === 'number' && color.tint !== 0) hex = applyTint(hex, color.tint);
    return '#' + hex;
  }
  if (typeof color.indexed === 'number') {
    const hex = INDEXED_PALETTE[color.indexed];
    return hex ? '#' + hex : undefined;
  }
  return undefined;
}

/** JS Date → Excel serial (days since 1899-12-30), dùng UTC components để tránh lệch timezone. */
function dateToExcelSerial(d: Date): number {
  const utc = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  );
  const serial = (utc - Date.UTC(1899, 11, 30)) / 86400000;
  return Math.round(serial * 1e6) / 1e6;
}

/** ExcelJS font → Univer text-style keys (dùng chung cho cell style và từng run rich text). */
function fontToStyle(font: any): Record<string, any> {
  const s: Record<string, any> = {};
  if (!font) return s;
  if (font.bold) s.bl = 1;
  if (font.italic) s.it = 1;
  if (font.underline) s.ul = { s: font.underline === 'double' || font.underline === 'doubleAccounting' ? 2 : 1 };
  if (font.strike) s.st = { s: 1 };
  if (font.size && font.size !== 11) s.fs = font.size;
  if (font.name && font.name !== 'Calibri') s.ff = font.name;
  if (font.color) { const rgb = resolveColor(font.color); if (rgb) s.cl = { rgb }; }
  if (font.vertAlign === 'superscript') s.va = 2;
  else if (font.vertAlign === 'subscript') s.va = 1;
  return s;
}

/**
 * ExcelJS richText → Univer cell rich-text document (IDocumentData) với textRuns per-run.
 * dataStream phải kết thúc bằng '\r\n' (paragraph + section break); textRuns không phủ 2 ký tự này.
 */
function richTextToDoc(richText: Array<{ text?: string; font?: any }>): { doc: any; plain: string } {
  const runs: any[] = [];
  let text = '';
  for (const part of richText) {
    const t = part.text ?? '';
    if (!t) continue;
    const st = text.length;
    text += t;
    const ts = fontToStyle(part.font);
    if (Object.keys(ts).length) runs.push({ st, ed: text.length, ts });
  }
  const doc = {
    id: 'd',
    documentStyle: {},
    body: { dataStream: text + '\r\n', textRuns: runs },
  };
  return { doc, plain: text };
}

function buildBorders(border: any): Record<string, any> | undefined {
  if (!border) return undefined;
  const map: Record<string, string> = { top: 't', bottom: 'b', left: 'l', right: 'r' };
  const bd: Record<string, any> = {};
  for (const [side, key] of Object.entries(map)) {
    const b = border[side];
    if (!b?.style) continue;
    bd[key] = {
      s: BORDER_STYLE[b.style] ?? 1,
      cl: { rgb: resolveColor(b.color) ?? '#000000' },
    };
  }
  // Diagonal borders: down = top-left→bottom-right (tl_br), up = bottom-left→top-right (bl_tr)
  const diag = border.diagonal;
  if (diag?.style) {
    const line = { s: BORDER_STYLE[diag.style] ?? 1, cl: { rgb: resolveColor(diag.color) ?? '#000000' } };
    if (diag.down) bd.tl_br = line;
    if (diag.up) bd.bl_tr = line;
  }
  return Object.keys(bd).length ? bd : undefined;
}

export function excelToUniverSheets(workbook: ExcelJS.Workbook): {
  sheets: Array<{ id: string; name: string; data: Record<string, any> }>;
  styles: Record<string, any>;
} {
  const stylesRegistry: Record<string, any> = {};
  const styleKeyToId: Record<string, string> = {};
  let styleCounter = 0;

  function buildStyleId(cell: ExcelJS.Cell): string | undefined {
    const s: Record<string, any> = {};
    const fill = (cell as any).fill;
    if (fill?.type === 'pattern' && fill.pattern !== 'none') {
      // solid → fgColor là màu nền; pattern khác (gray125…) fgColor là màu chấm,
      // nền lấy bgColor. Fallback lẫn nhau để không mất màu.
      const rgb = fill.pattern === 'solid'
        ? resolveColor(fill.fgColor)
        : (resolveColor(fill.bgColor) ?? resolveColor(fill.fgColor));
      if (rgb) s.bg = { rgb };
    } else if (fill?.type === 'gradient' && Array.isArray(fill.stops) && fill.stops.length) {
      // Univer chưa hỗ trợ gradient trong cell style → xấp xỉ bằng stop đầu tiên
      const rgb = resolveColor(fill.stops[0]?.color);
      if (rgb) s.bg = { rgb };
    }
    Object.assign(s, fontToStyle((cell as any).font));
    const align = (cell as any).alignment;
    const HT: Record<string, number> = { left: 1, center: 2, right: 3 };
    const VT: Record<string, number> = { top: 1, middle: 2, bottom: 3 };
    if (align?.horizontal && HT[align.horizontal]) s.ht = HT[align.horizontal];
    if (align?.vertical && VT[align.vertical]) s.vt = VT[align.vertical];
    if (align?.wrapText) s.tb = 3;
    if (typeof align?.textRotation === 'number' && align.textRotation !== 0) {
      // Excel 90..180 = xoay xuống (âm); Univer dùng góc a
      const a = align.textRotation > 90 ? 90 - align.textRotation : align.textRotation;
      s.tr = { a, v: 0 };
    }
    const bd = buildBorders((cell as any).border);
    if (bd) s.bd = bd;
    const numFmt = (cell as any).numFmt;
    if (numFmt && numFmt !== 'General') s.n = { pattern: numFmt };
    if (!Object.keys(s).length) return undefined;
    const key = JSON.stringify(s);
    if (!styleKeyToId[key]) {
      const newId = String(++styleCounter);
      styleKeyToId[key] = newId;
      stylesRegistry[newId] = s;
    }
    return styleKeyToId[key];
  }

  const sheets = workbook.worksheets.map((ws) => {
    const cellData: Record<string, Record<string, any>> = {};
    const columnData: Record<string, { w?: number; hd?: number }> = {};
    const rowData: Record<string, { h?: number; hd?: number }> = {};
    let maxRow = 0;
    let maxCol = 0;

    // Column widths: Excel char units → pixels (≈ 8px per char); hidden flag
    // columnCount only counts columns with cells; ws.columns also has defined columns (width/hidden)
    const colCount = Math.max(ws.columnCount, (ws as any).columns?.length ?? 0);
    for (let ci = 1; ci <= colCount; ci++) {
      const col = ws.getColumn(ci);
      const w = (col as any).width;
      const entry: { w?: number; hd?: number } = {};
      if (w && w > 0) entry.w = Math.round(w * 8);
      if ((col as any).hidden) entry.hd = 1;
      if (Object.keys(entry).length) columnData[String(ci - 1)] = entry;
    }

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const ri = rowNumber - 1;
      const rEntry: { h?: number; hd?: number } = {};
      // Row heights: points → pixels (1pt ≈ 1.333px at 96dpi)
      if ((row as any).height > 0) rEntry.h = Math.round((row as any).height * 1.333);
      if ((row as any).hidden) rEntry.hd = 1;
      if (Object.keys(rEntry).length) rowData[String(ri)] = rEntry;

      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const ci = colNumber - 1;
        let v: any = cell.value;
        let f: string | undefined;
        let p: any; // rich-text document (IDocumentData) khi ô có nhiều run định dạng khác nhau

        if (typeof v === 'object' && v !== null && ('formula' in v || 'sharedFormula' in v)) {
          // cell.formula resolves the master formula for shared-formula cells
          let fs = String((cell as any).formula ?? (v as any).formula ?? '').trim();
          if (!fs && (v as any).sharedFormula) fs = String((v as any).sharedFormula).trim();
          if (fs) f = fs.startsWith('=') ? fs : '=' + fs;
          v = (v as any).result ?? '';
        }
        if (typeof v === 'object' && v !== null && 'richText' in v) {
          const parts = (v as any).richText as Array<{ text?: string; font?: any }>;
          const { doc, plain } = richTextToDoc(parts);
          v = plain;
          // Chỉ dùng rich-text doc khi thực sự có ≥1 run mang định dạng riêng
          if (doc.body.textRuns.length) p = doc;
        }
        if (typeof v === 'object' && v !== null && 'text' in v) v = (v as any).text;
        if (v instanceof Date) {
          // Giữ serial number Excel để number format (dd/mm/yyyy…) render đúng;
          // không có numFmt thì fallback chuỗi locale.
          v = (cell as any).numFmt && (cell as any).numFmt !== 'General'
            ? dateToExcelSerial(v)
            : v.toLocaleDateString('vi-VN');
        }
        if (typeof v === 'object' && v !== null) v = String(v);

        const sid = buildStyleId(cell);
        const hasValue = v !== null && v !== undefined && v !== '';
        if (!hasValue && !f && !sid && !p) return;

        if (!cellData[String(ri)]) cellData[String(ri)] = {};
        const entry: any = f ? { v: v ?? '', f } : { v: v ?? '' };
        if (sid) entry.s = sid;
        if (p) entry.p = p; // Univer render rich text từ p, v là plain fallback
        cellData[String(ri)][String(ci)] = entry;

        if (ri > maxRow) maxRow = ri;
        if (ci > maxCol) maxCol = ci;
      });
    });

    // Merged cells
    const mergeData: any[] = [];
    const wsModel = (ws as any).model;
    if (Array.isArray(wsModel?.merges)) {
      for (const mergeRef of wsModel.merges) {
        const parts = String(mergeRef).split(':');
        if (parts.length !== 2) continue;
        try {
          const sc = ws.getCell(parts[0]) as any;
          const ec = ws.getCell(parts[1]) as any;
          mergeData.push({ startRow: sc.row - 1, startColumn: sc.col - 1, endRow: ec.row - 1, endColumn: ec.col - 1 });
        } catch { /* skip invalid */ }
      }
    }

    // Freeze panes
    let freeze: Record<string, number> | undefined;
    const view = (ws as any).views?.[0];
    if (view?.state === 'frozen') {
      freeze = {
        xSplit: view.xSplit ?? 0,
        ySplit: view.ySplit ?? 0,
        startRow: view.ySplit ?? 0,
        startColumn: view.xSplit ?? 0,
      };
    }

    const props = (ws as any).properties ?? {};

    return {
      id: `sheet-${ws.id}`,
      name: ws.name,
      data: {
        cellData,
        rowCount: Math.max(maxRow + 10, 100),
        columnCount: Math.max(maxCol + 5, 20),
        ...(Object.keys(columnData).length && { columnData }),
        ...(Object.keys(rowData).length && { rowData }),
        ...(mergeData.length && { mergeData }),
        ...(freeze && { freeze }),
        ...(props.defaultColWidth > 0 && { defaultColumnWidth: Math.round(props.defaultColWidth * 8) }),
        ...(props.defaultRowHeight > 0 && { defaultRowHeight: Math.round(props.defaultRowHeight * 1.333) }),
      },
    };
  });

  return { sheets, styles: stylesRegistry };
}
