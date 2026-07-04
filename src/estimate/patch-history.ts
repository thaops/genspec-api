import { Action, EstimateState, Patch, PatchChange } from './estimate.types';
import { parseExcelCell } from './reducer';

export function generatePatch(before: EstimateState, actions: Action[], actor: 'ai' | 'manual'): Patch {
  const changes: PatchChange[] = [];
  const timestamp = new Date().toISOString();
  const id = `patch_${Math.random().toString(36).substr(2, 9)}`;

  for (const a of actions) {
    switch (a.type) {
      case 'set_project_info':
        changes.push({
          op: 'update',
          path: 'projectInfo',
          oldValue: { ...before.projectInfo },
          newValue: { ...before.projectInfo, ...a.patch },
        });
        break;
      case 'set_markups':
        changes.push({
          op: 'update',
          path: 'markups',
          oldValue: { ...before.markups },
          newValue: { ...before.markups, ...a.patch },
        });
        break;
      case 'upsert_material': {
        const ex = a.id
          ? before.materials.find((m) => m.id === a.id)
          : before.materials.find((m) => m.code.toLowerCase() === a.code.toLowerCase());
        if (ex) {
          changes.push({
            op: 'update',
            path: 'materials',
            entityId: ex.id,
            oldValue: { ...ex },
            newValue: { ...ex, code: a.code, name: a.name, unit: a.unit, price: a.price, source: a.source },
          });
        } else {
          const newId = a.id || `mat_manual_${Math.random().toString(36).substr(2, 9)}`;
          changes.push({
            op: 'insert',
            path: 'materials',
            entityId: newId,
            newValue: { id: newId, code: a.code, name: a.name, unit: a.unit, price: a.price, source: a.source },
            oldValue: null,
          });
        }
        break;
      }
      case 'delete_material': {
        const ex = before.materials.find((m) => m.id === a.id);
        if (ex) {
          changes.push({
            op: 'delete',
            path: 'materials',
            entityId: a.id,
            oldValue: { ...ex },
            newValue: null,
          });
        }
        break;
      }
      case 'upsert_labor': {
        const ex = a.id
          ? before.labor.find((l) => l.id === a.id)
          : before.labor.find((l) => l.grade.toLowerCase() === a.grade.toLowerCase());
        if (ex) {
          changes.push({
            op: 'update',
            path: 'labor',
            entityId: ex.id,
            oldValue: { ...ex },
            newValue: { ...ex, grade: a.grade, name: a.name, dayRate: a.dayRate, source: a.source },
          });
        } else {
          const newId = a.id || `lab_manual_${Math.random().toString(36).substr(2, 9)}`;
          changes.push({
            op: 'insert',
            path: 'labor',
            entityId: newId,
            newValue: { id: newId, grade: a.grade, name: a.name, dayRate: a.dayRate, source: a.source },
            oldValue: null,
          });
        }
        break;
      }
      case 'delete_labor': {
        const ex = before.labor.find((l) => l.id === a.id);
        if (ex) {
          changes.push({
            op: 'delete',
            path: 'labor',
            entityId: a.id,
            oldValue: { ...ex },
            newValue: null,
          });
        }
        break;
      }
      case 'upsert_equipment': {
        const ex = a.id
          ? before.equipment.find((e) => e.id === a.id)
          : before.equipment.find((e) => e.code.toLowerCase() === a.code.toLowerCase());
        if (ex) {
          changes.push({
            op: 'update',
            path: 'equipment',
            entityId: ex.id,
            oldValue: { ...ex },
            newValue: { ...ex, code: a.code, name: a.name, unit: a.unit, shiftRate: a.shiftRate, source: a.source },
          });
        } else {
          const newId = a.id || `eq_manual_${Math.random().toString(36).substr(2, 9)}`;
          changes.push({
            op: 'insert',
            path: 'equipment',
            entityId: newId,
            newValue: { id: newId, code: a.code, name: a.name, unit: a.unit, shiftRate: a.shiftRate, source: a.source },
            oldValue: null,
          });
        }
        break;
      }
      case 'delete_equipment': {
        const ex = before.equipment.find((e) => e.id === a.id);
        if (ex) {
          changes.push({
            op: 'delete',
            path: 'equipment',
            entityId: a.id,
            oldValue: { ...ex },
            newValue: null,
          });
        }
        break;
      }
      case 'upsert_takeoff': {
        const ex = a.id ? before.takeoff.find((t) => t.id === a.id) : null;
        if (ex) {
          changes.push({
            op: 'update',
            path: 'takeoff',
            entityId: ex.id,
            oldValue: { ...ex },
            newValue: { ...ex, ...a },
          });
        } else {
          const newId = a.id || `tk_manual_${Math.random().toString(36).substr(2, 9)}`;
          changes.push({
            op: 'insert',
            path: 'takeoff',
            entityId: newId,
            newValue: { ...a, id: newId },
            oldValue: null,
          });
        }
        break;
      }
      case 'delete_takeoff': {
        const ex = before.takeoff.find((t) => t.id === a.id);
        if (ex) {
          changes.push({
            op: 'delete',
            path: 'takeoff',
            entityId: a.id,
            oldValue: { ...ex },
            newValue: null,
          });
        }
        break;
      }
      case 'update_cells':
        changes.push({
          op: 'update',
          sheetId: a.sheetId,
          cell: a.cell,
          oldValue: a.oldValue,
          newValue: a.newValue,
        });
        break;
      default:
        break;
    }
  }

  const description = actions
    .map((act) => {
      if (act.type === 'update_cells') return `Sửa ô ${act.cell} thành ${act.newValue}`;
      if (act.type === 'format_sheet') return 'Định dạng sheet';
      if (act.type === 'upsert_material') return `Sửa vật tư ${act.name || act.code}`;
      return act.type;
    })
    .join(', ');

  return {
    id,
    actor,
    timestamp,
    description,
    changes,
  };
}

export function applyRollback(state: EstimateState, patch: Patch): EstimateState {
  const nextState: EstimateState = {
    projectInfo: { ...state.projectInfo },
    takeoff: [...state.takeoff],
    analyses: [...state.analyses],
    materials: [...state.materials],
    labor: [...state.labor],
    equipment: [...state.equipment],
    markups: { ...state.markups },
    sheets: state.sheets ? [...state.sheets] : [],
    entityMaps: state.entityMaps ? [...state.entityMaps] : [],
    patchHistory: state.patchHistory ? [...state.patchHistory] : [],
  };

  for (let i = patch.changes.length - 1; i >= 0; i--) {
    const c = patch.changes[i];
    if (c.sheetId && c.cell) {
      if (!nextState.sheets) continue;
      nextState.sheets = nextState.sheets.map((s) => {
        if (s.id !== c.sheetId) return s;
        const cellData = { ...s.data?.cellData };
        const { row, col } = parseExcelCell(c.cell!);
        const rKey = String(row);
        const cKey = String(col);
        const rowData = { ...cellData[rKey] };
        rowData[cKey] = {
          ...rowData[cKey],
          v: isFinite(Number(c.oldValue)) ? Number(c.oldValue) : c.oldValue,
        };
        cellData[rKey] = rowData;
        return {
          ...s,
          data: { ...s.data, cellData },
        };
      });
    } else if (c.path) {
      const path = c.path;
      if (path === 'projectInfo') {
        nextState.projectInfo = c.oldValue;
      } else if (path === 'markups') {
        nextState.markups = c.oldValue;
      } else {
        const key = path as 'materials' | 'labor' | 'equipment' | 'takeoff' | 'analyses';
        const arr = nextState[key] as any[];
        if (!arr) continue;

        if (c.op === 'update') {
          nextState[key] = arr.map((item) => (item.id === c.entityId ? c.oldValue : item));
        } else if (c.op === 'insert') {
          nextState[key] = arr.filter((item) => item.id !== c.entityId);
        } else if (c.op === 'delete') {
          nextState[key] = [...arr, c.oldValue];
        }
      }
    }
  }

  return nextState;
}
