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
      if (!state.sheets) return state;
      const nextSheets = state.sheets.map((s) => {
        if (s.id !== a.sheetId) return s;
        const cellData = { ...s.data?.cellData };
        const { row, col } = parseExcelCell(a.cell);
        const rKey = String(row);
        const cKey = String(col);
        const rowData = { ...cellData[rKey] };
        rowData[cKey] = { ...rowData[cKey], v: isFinite(Number(a.newValue)) ? Number(a.newValue) : a.newValue };
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
