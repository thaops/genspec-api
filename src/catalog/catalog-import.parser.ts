/**
 * Pure Excel-mapping logic cho import định mức / công bố giá tỉnh.
 * KHÔNG phụ thuộc Mongo/Nest — test được trực tiếp từ dist/.
 *
 * Heuristics:
 * - Dò header row trong 30 dòng đầu: dòng nào match >= 2 cột đã biết.
 * - Tên cột match gần đúng (bỏ dấu, lowercase): "Mã hiệu|Mã ĐM", "Tên công tác|Danh mục",
 *   "Đơn vị|ĐVT", "Vật liệu|VL", "Nhân công|NC", "Máy|M", "Thành phần hao phí",
 *   "Hao phí|Định mức|Mức hao phí", "Đơn giá|Giá", "Loại"...
 * - Norm file hỗ trợ 2 layout:
 *   A (flat): mỗi dòng 1 mã + cột VL/NC/Máy → 3 components tổng hợp.
 *   B (hierarchical): dòng có mã = công tác mới; dòng dưới = hao phí thành phần,
 *     kind suy từ section header ("Vật liệu"/"Nhân công"/"Máy thi công") hoặc tên hao phí.
 */

export type ComponentKind = 'material' | 'labor' | 'machine';

export interface ParsedNormComponent {
  kind: ComponentKind;
  refCode?: string;
  name: string;
  unit: string;
  norm: number;
}

export interface ParsedNormItem {
  code: string;
  name: string;
  unit: string;
  group: string;
  components: ParsedNormComponent[];
}

export interface ParsedPriceItem {
  refCode?: string;
  name: string;
  unit: string;
  price: number;
  kind: ComponentKind;
}

export interface HeaderDetection {
  headerRowIndex: number; // 0-based trong mảng rows
  columns: Record<string, number>; // key logic → column index
}

export interface NormParseResult {
  header: HeaderDetection | null;
  items: ParsedNormItem[];
  errors: string[];
}

export interface PriceParseResult {
  header: HeaderDetection | null;
  items: ParsedPriceItem[];
  errors: string[];
}

export function normalizeText(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse số hỗ trợ định dạng VN ("1.234,56") lẫn EN ("1,234.56"). */
export function parseNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).trim().replace(/\s/g, '');
  if (!s) return null;
  if (/^[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.'); // VN: 1.234,56
  } else if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, ''); // EN: 1,234.56
  } else if (/^\d+,\d+$/.test(s)) {
    s = s.replace(',', '.'); // "0,342"
  } else {
    s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

const CODE_RE = /^[A-Za-z]{1,3}[.\-]?\d{2,}[\w.]*$/;

export function looksLikeCode(s: string): boolean {
  return CODE_RE.test((s || '').trim());
}

type ColumnPatterns = Record<string, RegExp>;

const NORM_COLUMNS: ColumnPatterns = {
  code: /^ma( hieu| dm| so| cong tac)?$|ma hieu|ma dm/,
  name: /ten cong tac|danh muc|noi dung|ten cong viec|^ten$/,
  unit: /^don vi( tinh)?$|^dvt$/,
  compName: /thanh phan hao phi|ten hao phi|vat tu|ten vat tu/,
  compUnit: /don vi hao phi/,
  norm: /^(hao phi|dinh muc|muc hao phi|khoi luong)$/,
  material: /^(vat lieu|vl)$/,
  labor: /^(nhan cong|nc)$/,
  machine: /^(may( thi cong)?|m|ca may)$/,
  refCode: /ma (vat tu|hao phi|tai nguyen)/,
  group: /^(nhom|chuong|loai cong tac)$/,
};

const PRICE_COLUMNS: ColumnPatterns = {
  refCode: /^ma( hieu| vat tu| so)?$|ma vat tu|ma hieu/,
  name: /ten (vat lieu|vat tu|hang hoa|nhien lieu)|danh muc|^ten$|ten cong tac/,
  unit: /^don vi( tinh)?$|^dvt$/,
  price: /don gia|^gia( .*)?$|gia cong bo|gia ban/,
  kind: /^loai$|^phan loai$/,
};

function detectHeader(rows: string[][], patterns: ColumnPatterns): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  let bestScore = 0;
  const scan = Math.min(rows.length, 30);
  for (let r = 0; r < scan; r++) {
    const cols: Record<string, number> = {};
    let score = 0;
    for (let c = 0; c < rows[r].length; c++) {
      const cell = normalizeText(rows[r][c]);
      if (!cell) continue;
      for (const [key, re] of Object.entries(patterns)) {
        if (cols[key] === undefined && re.test(cell)) {
          cols[key] = c;
          score++;
          break;
        }
      }
    }
    if (score > bestScore && score >= 2) {
      bestScore = score;
      best = { headerRowIndex: r, columns: cols };
    }
  }
  return best;
}

function kindFromText(s: string): ComponentKind | null {
  const t = normalizeText(s);
  if (/^vat lieu\b|^vl\b/.test(t)) return 'material';
  if (/^nhan cong\b|^nc\b|tho\b|cong nhan/.test(t)) return 'labor';
  if (/^may\b|thi cong|ca may/.test(t)) return 'machine';
  return null;
}

function inferKindFromName(name: string): ComponentKind {
  const t = normalizeText(name);
  if (/nhan cong|tho |cong nhan|bac tho/.test(t)) return 'labor';
  if (/may |can cau|van thang|may tron|dam dui|o to|ca may/.test(t)) return 'machine';
  return 'material';
}

function groupFromCode(code: string): string {
  const m = /^([A-Za-z]+)/.exec(code);
  return m ? m[1].toUpperCase() : '';
}

const cell = (row: string[], idx: number | undefined): string =>
  idx === undefined ? '' : (row[idx] ?? '').toString().trim();

export function parseNormRows(rows: string[][]): NormParseResult {
  const errors: string[] = [];
  const header = detectHeader(rows, NORM_COLUMNS);
  if (!header) return { header: null, items: [], errors: ['Không nhận diện được header (cần cột Mã hiệu/Tên công tác...)'] };

  const c = header.columns;
  const flat = c.material !== undefined || c.labor !== undefined || c.machine !== undefined;
  const items: ParsedNormItem[] = [];
  let current: ParsedNormItem | null = null;
  let sectionKind: ComponentKind | null = null;

  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((v) => !String(v ?? '').trim())) continue;
    const code = cell(row, c.code);
    const name = cell(row, c.name);

    if (looksLikeCode(code)) {
      current = {
        code,
        name: name || cell(row, c.compName),
        unit: cell(row, c.unit),
        group: cell(row, c.group) || groupFromCode(code),
        components: [],
      };
      items.push(current);
      sectionKind = null;
      if (flat) {
        const defs: [ComponentKind, number | undefined, string][] = [
          ['material', c.material, 'Vật liệu'],
          ['labor', c.labor, 'Nhân công'],
          ['machine', c.machine, 'Máy thi công'],
        ];
        for (const [kind, idx, label] of defs) {
          const n = parseNumber(cell(row, idx));
          if (n != null && n > 0) current.components.push({ kind, name: label, unit: '', norm: n });
        }
      }
      continue;
    }

    if (flat) continue;

    // hierarchical: dòng không có mã → section header hoặc component
    const compName = cell(row, c.compName) || name;
    if (!compName) continue;
    const normVal = parseNumber(cell(row, c.norm));
    const asSection = kindFromText(compName);
    if (asSection && normVal == null) {
      sectionKind = asSection;
      continue;
    }
    if (!current) continue;
    if (normVal == null) {
      errors.push(`Dòng ${r + 1}: hao phí "${compName}" không có giá trị định mức — bỏ qua`);
      continue;
    }
    const refCode = cell(row, c.refCode) || (looksLikeCode(compName) ? compName : undefined);
    current.components.push({
      kind: sectionKind ?? inferKindFromName(compName),
      refCode: refCode || undefined,
      name: compName,
      unit: cell(row, c.compUnit) || cell(row, c.unit),
      norm: normVal,
    });
  }

  const valid = items.filter((it) => it.name);
  return { header, items: valid, errors };
}

export function parsePriceRows(rows: string[][]): PriceParseResult {
  const errors: string[] = [];
  const header = detectHeader(rows, PRICE_COLUMNS);
  if (!header) return { header: null, items: [], errors: ['Không nhận diện được header (cần cột Tên vật liệu/Đơn giá...)'] };

  const c = header.columns;
  const items: ParsedPriceItem[] = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((v) => !String(v ?? '').trim())) continue;
    const name = cell(row, c.name);
    const price = parseNumber(cell(row, c.price));
    if (!name) continue;
    if (price == null) {
      errors.push(`Dòng ${r + 1}: "${name}" không có đơn giá — bỏ qua`);
      continue;
    }
    const kindRaw = cell(row, c.kind);
    const refCode = cell(row, c.refCode);
    items.push({
      refCode: looksLikeCode(refCode) ? refCode : refCode || undefined,
      name,
      unit: cell(row, c.unit),
      price,
      kind: (kindRaw && kindFromText(kindRaw)) || inferKindFromName(name),
    });
  }
  return { header, items, errors };
}

/** Chuyển buffer xlsx → string[][] (sheet đầu tiên có dữ liệu) bằng ExcelJS. */
export async function workbookToRows(buffer: Buffer): Promise<string[][]> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const rows: string[][] = [];
  const ws = wb.worksheets.find((w) => w.rowCount > 0) ?? wb.worksheets[0];
  if (!ws) return rows;
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const out: string[] = [];
    row.eachCell({ includeEmpty: true }, (cellObj, col) => {
      out[col - 1] = cellValueText(cellObj.value);
    });
    rows[n - 1] = out;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function cellValueText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (typeof v.text === 'string') return v.text;
    if (v.result != null) return String(v.result);
    if (value instanceof Date) return value.toISOString();
    return '';
  }
  return String(value);
}

export async function parseNormWorkbook(buffer: Buffer): Promise<NormParseResult> {
  return parseNormRows(await workbookToRows(buffer));
}

export async function parsePriceWorkbook(buffer: Buffer): Promise<PriceParseResult> {
  return parsePriceRows(await workbookToRows(buffer));
}
