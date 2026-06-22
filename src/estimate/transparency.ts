import { compute } from './boq.engine';
import { Action, ActivityEntry, EstimateState, ProposalPreview } from './estimate.types';
import { applyActions } from './reducer';

const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN');

function findMaterial(s: EstimateState, code: string) {
  return s.materials.find((m) => m.code.toLowerCase() === code?.toLowerCase());
}
function findLabor(s: EstimateState, grade: string) {
  return s.labor.find((l) => l.grade.toLowerCase() === grade?.toLowerCase());
}
function findEquipment(s: EstimateState, code: string) {
  return s.equipment.find((e) => e.code.toLowerCase() === code?.toLowerCase());
}
function findAnalysis(s: EstimateState, code: string) {
  return s.analyses.find((a) => a.code.toLowerCase() === code?.toLowerCase());
}

/** Dry-run: effect of applying actions to current state (no persistence). */
export function previewActions(before: EstimateState, actions: Action[]): ProposalPreview {
  const after = applyActions(before, actions).state;
  const costBefore = compute(before).costs.total;
  const costAfter = compute(after).costs.total;

  const tally: Record<string, { added: number; updated: number; removed: number }> = {};
  const bump = (kind: string, field: 'added' | 'updated' | 'removed') => {
    tally[kind] = tally[kind] ?? { added: 0, updated: 0, removed: 0 };
    tally[kind][field]++;
  };
  const diffs: ProposalPreview['diffs'] = [];

  for (const a of actions ?? []) {
    switch (a.type) {
      case 'upsert_material': {
        const ex = a.id ? before.materials.find((m) => m.id === a.id) : findMaterial(before, a.code);
        bump('vật liệu', ex ? 'updated' : 'added');
        if (ex && ex.price !== a.price) diffs.push({ ref: a.name || a.code, field: 'Giá', from: fmt(ex.price), to: fmt(a.price) });
        break;
      }
      case 'upsert_labor': {
        const ex = a.id ? before.labor.find((l) => l.id === a.id) : findLabor(before, a.grade);
        bump('nhân công', ex ? 'updated' : 'added');
        if (ex && ex.dayRate !== a.dayRate) diffs.push({ ref: a.name || a.grade, field: 'Lương ngày', from: fmt(ex.dayRate), to: fmt(a.dayRate) });
        break;
      }
      case 'upsert_equipment': {
        const ex = a.id ? before.equipment.find((e) => e.id === a.id) : findEquipment(before, a.code);
        bump('ca máy', ex ? 'updated' : 'added');
        if (ex && ex.shiftRate !== a.shiftRate) diffs.push({ ref: a.name || a.code, field: 'Giá ca', from: fmt(ex.shiftRate), to: fmt(a.shiftRate) });
        break;
      }
      case 'upsert_analysis': {
        const ex = a.id ? before.analyses.find((x) => x.id === a.id) : findAnalysis(before, a.code);
        bump('phân tích đơn giá', ex ? 'updated' : 'added');
        break;
      }
      case 'upsert_takeoff': {
        const ex = a.id ? before.takeoff.find((t) => t.id === a.id) : undefined;
        bump('công tác', ex ? 'updated' : 'added');
        if (ex && a.quantity != null && ex.quantity !== a.quantity) diffs.push({ ref: a.name || a.code, field: 'Khối lượng', from: fmt(ex.quantity), to: fmt(a.quantity) });
        break;
      }
      case 'delete_material': bump('vật liệu', 'removed'); break;
      case 'delete_labor': bump('nhân công', 'removed'); break;
      case 'delete_equipment': bump('ca máy', 'removed'); break;
      case 'delete_analysis': bump('phân tích đơn giá', 'removed'); break;
      case 'delete_takeoff': bump('công tác', 'removed'); break;
      default: break;
    }
  }

  return {
    counts: Object.entries(tally).map(([kind, c]) => ({ kind, ...c })),
    costBefore,
    costAfter,
    costDelta: costAfter - costBefore,
    diffs: diffs.slice(0, 40),
  };
}

/** Human-readable activity entries appended to the change log on each apply. */
export function buildActivity(before: EstimateState, actions: Action[], at: string, src: 'ai' | 'manual'): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const a of actions ?? []) {
    let label: string = a.type;
    let detail: string | undefined;
    switch (a.type) {
      case 'set_project_info': label = 'Cập nhật thông tin công trình'; break;
      case 'set_markups': label = 'Cập nhật hệ số chi phí'; break;
      case 'upsert_material': {
        const ex = a.id ? before.materials.find((m) => m.id === a.id) : findMaterial(before, a.code);
        label = `${ex ? 'Cập nhật' : 'Thêm'} vật liệu ${a.name || a.code}`;
        if (ex && ex.price !== a.price) detail = `${fmt(ex.price)} → ${fmt(a.price)}`;
        break;
      }
      case 'upsert_labor': {
        const ex = a.id ? before.labor.find((l) => l.id === a.id) : findLabor(before, a.grade);
        label = `${ex ? 'Cập nhật' : 'Thêm'} nhân công ${a.name || a.grade}`;
        if (ex && ex.dayRate !== a.dayRate) detail = `${fmt(ex.dayRate)} → ${fmt(a.dayRate)}`;
        break;
      }
      case 'upsert_equipment': {
        const ex = a.id ? before.equipment.find((e) => e.id === a.id) : findEquipment(before, a.code);
        label = `${ex ? 'Cập nhật' : 'Thêm'} ca máy ${a.name || a.code}`;
        if (ex && ex.shiftRate !== a.shiftRate) detail = `${fmt(ex.shiftRate)} → ${fmt(a.shiftRate)}`;
        break;
      }
      case 'upsert_analysis': {
        const ex = a.id ? before.analyses.find((x) => x.id === a.id) : findAnalysis(before, a.code);
        label = `${ex ? 'Cập nhật' : 'Thêm'} phân tích đơn giá ${a.code}`;
        break;
      }
      case 'upsert_takeoff': {
        const ex = a.id ? before.takeoff.find((t) => t.id === a.id) : undefined;
        label = `${ex ? 'Cập nhật' : 'Thêm'} công tác ${a.name || a.code}`;
        if (ex && a.quantity != null && ex.quantity !== a.quantity) detail = `KL ${fmt(ex.quantity)} → ${fmt(a.quantity)}`;
        break;
      }
      case 'delete_material': label = 'Xóa vật liệu'; break;
      case 'delete_labor': label = 'Xóa nhân công'; break;
      case 'delete_equipment': label = 'Xóa ca máy'; break;
      case 'delete_analysis': label = 'Xóa phân tích đơn giá'; break;
      case 'delete_takeoff': label = 'Xóa công tác'; break;
      case 'clear': label = 'Xóa toàn bộ dữ liệu'; break;
      default: break;
    }
    out.push({ at, source: src, kind: a.type, label, detail });
  }
  return out;
}
