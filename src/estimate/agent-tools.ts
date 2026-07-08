// Tool layer cho AGENTIC LOOP (Phase 3) — "workbook là môi trường, agent đọc
// trước khi ghi" (read-before-write, SheetCopilot/SheetAgent). Các hàm THUẦN trên
// EstimateState: agent gọi để ĐỊNH VỊ đúng sheet/dòng bằng dữ liệu thật thay vì
// đoán sheetId/row → map chuẩn. Không side-effect, dễ test.
import { EstimateState, Sheet } from './estimate.types';
import { detectSheetType } from './rule-detector';

type CellData = Record<string, Record<string, { v?: unknown } | undefined>>;

function cellsOf(sheet: Sheet): CellData {
  return ((sheet.data as any)?.cellData ?? {}) as CellData;
}

function val(cell?: { v?: unknown }): string {
  return cell?.v == null ? '' : String(cell.v).trim();
}

/** Dòng đầu (row 0) làm header. */
function headersOf(sheet: Sheet): string[] {
  const row = cellsOf(sheet)['0'] ?? {};
  const maxCol = Math.max(-1, ...Object.keys(row).map((c) => Number(c)));
  const out: string[] = [];
  for (let c = 0; c <= maxCol; c++) out.push(val(row[String(c)]));
  return out;
}

function rowCount(sheet: Sheet): number {
  const keys = Object.keys(cellsOf(sheet)).map((r) => Number(r));
  return keys.length ? Math.max(...keys) + 1 : 0;
}

/** Tên sheet bóc tách/BOQ phổ biến (đã bỏ dấu) — fallback khi detect chưa chắc. */
const TAKEOFF_NAME_RE = /khoi luong|boc tach|boq|tien luong|du toan|khoi tich/;
function normName(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

// ===== Tool: locate_sheet =====
export function locateSheet(
  state: EstimateState,
  type: string,
): { found: boolean; sheetId?: string; name?: string; detectedType?: string; rowCount?: number } {
  const want = (type ?? '').toLowerCase();
  const sheets = state.sheets ?? [];
  const wantTakeoffish = want === 'takeoff' || want === 'boq';
  const hit =
    sheets.find((s) => detectSheetType(s).sheetType === want) ??
    (wantTakeoffish
      ? sheets.find((s) => {
          const t = detectSheetType(s).sheetType;
          return t === 'takeoff' || t === 'boq';
        })
      : undefined) ??
    // Fallback theo TÊN (sheet "Bóc tách" nội dung mỏng vẫn định vị được).
    (wantTakeoffish ? sheets.find((s) => TAKEOFF_NAME_RE.test(normName(s.name))) : undefined);
  if (!hit) return { found: false };
  return {
    found: true,
    sheetId: hit.id,
    name: hit.name,
    detectedType: detectSheetType(hit).sheetType,
    rowCount: rowCount(hit),
  };
}

// ===== Tool: get_sheet_state =====
export function getSheetState(
  state: EstimateState,
  sheetId: string,
  maxRows = 8,
): { found: boolean; sheetId?: string; name?: string; headers?: string[]; rowCount?: number; sampleRows?: { row: number; cells: string[] }[] } {
  const sheet = (state.sheets ?? []).find((s) => s.id === sheetId);
  if (!sheet) return { found: false };
  const cd = cellsOf(sheet);
  const headers = headersOf(sheet);
  const total = rowCount(sheet);
  const sampleRows: { row: number; cells: string[] }[] = [];
  for (let r = 1; r < total && sampleRows.length < maxRows; r++) {
    const row = cd[String(r)];
    if (!row) continue;
    const maxCol = Math.max(-1, ...Object.keys(row).map((c) => Number(c)));
    const cells: string[] = [];
    for (let c = 0; c <= maxCol; c++) cells.push(val(row[String(c)]));
    if (cells.some((x) => x)) sampleRows.push({ row: r, cells });
  }
  return { found: true, sheetId, name: sheet.name, headers, rowCount: total, sampleRows };
}

// ===== Tool: find_row (định vị dòng theo MÃ HIỆU / từ khoá — read-before-write) =====
export function findRow(
  state: EstimateState,
  sheetId: string,
  query: string,
): { found: boolean; sheetId?: string; row?: number; col?: number; cells?: string[] } {
  const sheet = (state.sheets ?? []).find((s) => s.id === sheetId);
  const q = (query ?? '').trim().toLowerCase();
  if (!sheet || !q) return { found: false };
  const cd = cellsOf(sheet);
  const rows = Object.keys(cd).map((r) => Number(r)).sort((a, b) => a - b);
  for (const r of rows) {
    const row = cd[String(r)] ?? {};
    let hitCol = -1;
    for (const [c, cell] of Object.entries(row)) {
      const v = val(cell).toLowerCase();
      if (v && (v === q || v.includes(q))) { hitCol = Number(c); break; }
    }
    if (hitCol >= 0) {
      const maxCol = Math.max(-1, ...Object.keys(row).map((c) => Number(c)));
      const cells: string[] = [];
      for (let c = 0; c <= maxCol; c++) cells.push(val(row[String(c)]));
      return { found: true, sheetId, row: r, col: hitCol, cells };
    }
  }
  return { found: false, sheetId };
}

// ===== Reconcile (MERGE by key): các mã → đã có row nào / chưa có =====
export function reconcileByCode(
  state: EstimateState,
  sheetId: string,
  codes: string[],
): { code: string; matchedRow: number | null }[] {
  const seen = new Set<string>();
  const out: { code: string; matchedRow: number | null }[] = [];
  for (const raw of codes) {
    const code = (raw ?? '').trim();
    if (!code) continue;
    const k = code.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = findRow(state, sheetId, code);
    out.push({ code, matchedRow: hit.found ? (hit.row as number) : null });
  }
  return out;
}

// ===== Gemini functionDeclarations (schema tool cho agent loop) =====
export const AGENT_TOOL_DECLARATIONS = [
  {
    name: 'locate_sheet',
    description:
      'Tìm sheet theo loại (takeoff=bóc tách, boq, material, labor, equipment, analysis, summary). Trả sheetId để ghi ĐÚNG sheet, tránh tạo mới.',
    parameters: {
      type: 'OBJECT',
      properties: { type: { type: 'STRING', description: 'loại sheet cần tìm' } },
      required: ['type'],
    },
  },
  {
    name: 'get_sheet_state',
    description: 'Đọc trạng thái 1 sheet: header + số dòng + vài dòng mẫu. Gọi TRƯỚC khi sửa để biết cấu trúc thật.',
    parameters: {
      type: 'OBJECT',
      properties: { sheetId: { type: 'STRING' } },
      required: ['sheetId'],
    },
  },
  {
    name: 'find_row',
    description: 'Định vị dòng trong sheet theo mã hiệu / từ khoá (khớp giá trị ô). Trả row index + nội dung dòng để sửa đúng chỗ, không đoán.',
    parameters: {
      type: 'OBJECT',
      properties: { sheetId: { type: 'STRING' }, query: { type: 'STRING', description: 'mã hiệu hoặc từ khoá cần tìm' } },
      required: ['sheetId', 'query'],
    },
  },
] as const;

/** Dispatcher: thực thi 1 tool-call trên state (PURE). Trả object JSON-able cho functionResponse. */
export function executeAgentTool(state: EstimateState, name: string, args: Record<string, any>): unknown {
  switch (name) {
    case 'locate_sheet':
      return locateSheet(state, String(args?.type ?? ''));
    case 'get_sheet_state':
      return getSheetState(state, String(args?.sheetId ?? ''));
    case 'find_row':
      return findRow(state, String(args?.sheetId ?? ''), String(args?.query ?? ''));
    default:
      return { error: `unknown tool: ${name}` };
  }
}
