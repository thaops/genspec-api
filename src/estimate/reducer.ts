import { v4 as uuid } from 'uuid';
import { Action, EstimateState } from './estimate.types';
import { rankSource } from './source';

export interface ApplyResult {
  state: EstimateState;
  applied: number;
  warnings: string[];
}

function num(v: unknown, fb = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fb;
}

export function applyActions(initial: EstimateState, actions: Action[]): ApplyResult {
  let state: EstimateState = clone(initial);
  const warnings: string[] = [];
  let applied = 0;
  for (const action of actions ?? []) {
    try {
      state = applyOne(state, action);
      applied++;
    } catch (err) {
      warnings.push(`${action?.type}: ${(err as Error).message}`);
    }
  }
  return { state, applied, warnings };
}

function clone(s: EstimateState): EstimateState {
  return {
    projectInfo: { ...s.projectInfo },
    takeoff: [...s.takeoff],
    analyses: [...s.analyses],
    materials: [...s.materials],
    labor: [...s.labor],
    equipment: [...s.equipment],
    markups: { ...s.markups },
    sheets: s.sheets ? [...s.sheets] : [],
  };
}

/** Bỏ dấu tiếng Việt + lowercase để so khớp tên sheet. */
function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Resolve sheet đích cho update_cells/format_sheet khi sheetId có thể stale:
 * (1) đúng id → (2) sheet tên chứa "khối lượng" → (3) sheet đầu tiên → (4) -1 (không có sheet).
 */
function resolveSheetIndex(sheets: { id: string; name: string }[], sheetId: string): number {
  const byId = sheets.findIndex((s) => s.id === sheetId);
  if (byId >= 0) return byId;
  const byName = sheets.findIndex((s) => normalizeName(s.name).includes('khoi luong'));
  if (byName >= 0) return byName;
  return sheets.length > 0 ? 0 : -1;
}

function makeTakeoffSheet(id: string) {
  return { id, name: 'Khối lượng', data: { cellData: {}, rowCount: 100, columnCount: 20 } };
}

function upsert<T extends { id: string }>(list: T[], match: (x: T) => boolean, build: (existing?: T) => T): T[] {
  const idx = list.findIndex(match);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = build(list[idx]);
    return next;
  }
  return [...list, build()];
}

function applyOne(state: EstimateState, a: Action): EstimateState {
  switch (a.type) {
    case 'set_project_info':
      return { ...state, projectInfo: { ...state.projectInfo, ...a.patch } };

    case 'set_markups':
      return { ...state, markups: { ...state.markups, ...numericPatch(a.patch) } };

    case 'upsert_material':
      return {
        ...state,
        materials: upsert(
          state.materials,
          (m) => (a.id ? m.id === a.id : m.code.toLowerCase() === a.code.toLowerCase()),
          (ex) => ({ id: ex?.id ?? a.id ?? uuid(), code: a.code, name: a.name, unit: a.unit, price: num(a.price), source: rankSource(a.source ?? ex?.source) }),
        ),
      };
    case 'delete_material':
      return { ...state, materials: state.materials.filter((m) => m.id !== a.id) };

    case 'upsert_labor':
      return {
        ...state,
        labor: upsert(
          state.labor,
          (l) => (a.id ? l.id === a.id : l.grade.toLowerCase() === a.grade.toLowerCase()),
          (ex) => ({ id: ex?.id ?? a.id ?? uuid(), grade: a.grade, name: a.name, dayRate: num(a.dayRate), source: rankSource(a.source ?? ex?.source) }),
        ),
      };
    case 'delete_labor':
      return { ...state, labor: state.labor.filter((l) => l.id !== a.id) };

    case 'upsert_equipment':
      return {
        ...state,
        equipment: upsert(
          state.equipment,
          (e) => (a.id ? e.id === a.id : e.code.toLowerCase() === a.code.toLowerCase()),
          (ex) => ({ id: ex?.id ?? a.id ?? uuid(), code: a.code, name: a.name, unit: a.unit, shiftRate: num(a.shiftRate), source: rankSource(a.source ?? ex?.source) }),
        ),
      };
    case 'delete_equipment':
      return { ...state, equipment: state.equipment.filter((e) => e.id !== a.id) };

    case 'upsert_analysis':
      return {
        ...state,
        analyses: upsert(
          state.analyses,
          (x) => (a.id ? x.id === a.id : x.code.toLowerCase() === a.code.toLowerCase()),
          (ex) => ({
            id: ex?.id ?? a.id ?? uuid(),
            code: a.code,
            name: a.name,
            unit: a.unit,
            components: (a.components ?? []).map((c) => ({
              kind: c.kind === 'labor' || c.kind === 'equipment' ? c.kind : 'material',
              ref: String(c.ref ?? ''),
              name: c.name,
              unit: c.unit,
              norm: num(c.norm),
            })),
          }),
        ),
      };
    case 'delete_analysis':
      return { ...state, analyses: state.analyses.filter((x) => x.id !== a.id) };

    case 'upsert_takeoff':
      return {
        ...state,
        takeoff: upsert(
          state.takeoff,
          (t) => !!a.id && t.id === a.id,
          (ex) => {
            const length = a.length ?? ex?.length;
            const width = a.width ?? ex?.width;
            const height = a.height ?? ex?.height;
            const count = a.count ?? ex?.count;
            const computed = deriveQty({ length, width, height, count });
            return {
              id: ex?.id ?? a.id ?? uuid(),
              group: a.group ?? ex?.group,
              code: a.code,
              name: a.name,
              unit: a.unit,
              length,
              width,
              height,
              count,
              formula: a.formula ?? ex?.formula,
              note: a.note ?? ex?.note,
              quantity: a.quantity != null ? num(a.quantity) : computed != null ? computed : num(ex?.quantity),
            };
          },
        ),
      };
    case 'delete_takeoff':
      return { ...state, takeoff: state.takeoff.filter((t) => t.id !== a.id) };

    case 'set_sheets':
      return { ...state, sheets: a.sheets };

    case 'update_cells': {
      // sheetId có thể stale (sheet bị tái tạo trước khi Apply) — resolve fallback
      // theo tên "Khối lượng" → sheet đầu → tạo mới, thay vì âm thầm no-op.
      const baseSheets = state.sheets ? [...state.sheets] : [];
      let idx = resolveSheetIndex(baseSheets, a.sheetId);
      if (idx < 0) {
        baseSheets.push(makeTakeoffSheet(a.sheetId));
        idx = baseSheets.length - 1;
      }
      const nextSheets = baseSheets.map((s, i) => {
        if (i !== idx) return s;
        const cellData = { ...s.data?.cellData };
        const { row, col } = parseExcelCell(a.cell);
        const rKey = String(row);
        const cKey = String(col);
        const rowData = { ...cellData[rKey] };
        const isFormula = typeof a.newValue === 'string' && String(a.newValue).startsWith('=');
        if (isFormula) {
          // Store formula in `f` field; Univer will compute `v` at render time
          rowData[cKey] = { ...rowData[cKey], f: String(a.newValue).slice(1), v: null };
        } else if (a.newValue == null || a.newValue === '') {
          // Xoá ô: '' KHÔNG được ép thành Number('')=0 — clear hẳn giá trị/formula.
          rowData[cKey] = { ...rowData[cKey], v: null, f: undefined };
        } else {
          rowData[cKey] = { ...rowData[cKey], v: isFinite(Number(a.newValue)) ? Number(a.newValue) : a.newValue, f: undefined };
        }
        cellData[rKey] = rowData;
        return {
          ...s,
          data: {
            ...s.data,
            cellData,
          },
        };
      });

      let nextMaterials = [...state.materials];
      if (a.entityId && a.entityId.startsWith('mat_')) {
        nextMaterials = state.materials.map((m) =>
          m.id === a.entityId ? { ...m, price: Number(a.newValue) || 0 } : m
        );
      }

      return {
        ...state,
        sheets: nextSheets,
        materials: nextMaterials,
      };
    }

    case 'format_sheet': {
      const baseSheets = state.sheets ? [...state.sheets] : [];
      let idx = resolveSheetIndex(baseSheets, a.sheetId);
      if (idx < 0) {
        baseSheets.push(makeTakeoffSheet(a.sheetId));
        idx = baseSheets.length - 1;
      }
      const nextSheets = baseSheets.map((s, i) => {
        if (i !== idx) return s;
        const data = { ...s.data };
        if (a.columnWidths && Object.keys(a.columnWidths).length) {
          const columnData = { ...data.columnData };
          for (const [idx, w] of Object.entries(a.columnWidths)) {
            columnData[idx] = { ...columnData[idx], w: num(w) };
          }
          data.columnData = columnData;
        }
        if (a.cells?.length) {
          const cellData = { ...data.cellData };
          for (const { cell, s: style } of a.cells) {
            const { row, col } = parseExcelCell(cell);
            const rKey = String(row);
            const cKey = String(col);
            const rowData = { ...cellData[rKey] };
            // Style object inline trong cell.s (Univer chấp nhận) — giữ nguyên v/f hiện có.
            rowData[cKey] = { ...rowData[cKey], s: style };
            cellData[rKey] = rowData;
          }
          data.cellData = cellData;
        }
        return { ...s, data };
      });
      return { ...state, sheets: nextSheets };
    }

    case 'clear':
      return {
        projectInfo: state.projectInfo,
        takeoff: [],
        analyses: [],
        materials: [],
        labor: [],
        equipment: [],
        markups: state.markups,
      };

    default:
      return state;
  }
}

/** quantity from dimensions when not given explicitly: L×W×H×count (skipping absent dims). */
function deriveQty(d: { length?: number; width?: number; height?: number; count?: number }): number | null {
  const dims = [d.length, d.width, d.height].filter((x) => x != null) as number[];
  if (dims.length === 0 && d.count == null) return null;
  const base = dims.reduce((p, x) => p * x, 1);
  const c = d.count ?? 1;
  return Math.round(base * c * 1000) / 1000;
}

function numericPatch(patch: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(patch ?? {})) if (v != null) out[k] = num(v);
  return out;
}

export function parseExcelCell(cell: string): { row: number; col: number } {
  const match = cell.match(/^([A-Z]+)([0-9]+)$/i);
  if (!match) return { row: 0, col: 0 };
  const colStr = match[1].toUpperCase();
  const rowStr = match[2];
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 65 + 1);
  }
  col = col - 1;
  const row = Number(rowStr) - 1;
  return { row, col };
}
