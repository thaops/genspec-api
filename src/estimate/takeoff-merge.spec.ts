import { engineRowKeyFromId, planEngineTakeoffMerge, TakeoffEngineRow } from './takeoff-engine.service';
import { applyActions } from './reducer';
import { EstimateState, Action, TakeoffItem } from './estimate.types';

/**
 * CA THẬT (đo trên production, 4 bản THỰC HÀNH 2): bóc gộp tuần tự → mỗi bản sau XOÁ
 * dòng takeoff của bản trước (staleTakeoffs dùng id chỉ của bản hiện tại) và mirror ghi
 * đè cell từ dòng 3 → gộp chỉ còn dòng của bản CUỐI. 13 dòng của 4 bản mất còn 1.
 *
 * Test này mô phỏng đúng luồng FE `handleProjectTakeoff`: với MỖI bản, sinh proposal
 * (delete_takeoff + upsert_takeoff) rồi apply, tuần tự. Kỳ vọng: state.takeoff cộng dồn
 * đủ, KHÔNG bản nào xoá bản khác.
 */
const emptyState = (): EstimateState =>
  ({ sheets: [], takeoff: [], analyses: [], materials: [], labor: [], equipment: [], projectInfo: {}, markups: {} }) as unknown as EstimateState;

/** 1 upsert engine cho bản `drawing`, rowKey `key`. */
const up = (drawing: string, key: string, name: string, qty: number, price?: number): Action =>
  ({
    type: 'upsert_takeoff',
    id: `tk_engine_${drawing}_${key}`,
    group: 'PHẦN THÔ - KẾT CẤU',
    code: '',
    name,
    unit: 'm2',
    quantity: qty,
    note: `x [nhóm:${key}]`,
    ...(price != null ? { unitPrice: price, source: 'TT 13/2021' } : {}),
  }) as Action;

// drawingId phải 24-hex để khớp regex id engine.
const KC = 'a'.repeat(24);
const KHAC = 'b'.repeat(24);
const DIEN = 'c'.repeat(24);

describe('Bóc GỘP nhiều bản — không bản nào xoá/đè bản khác', () => {
  it('engineRowKeyFromId tách đúng rowKey (kể cả key có gạch dưới)', () => {
    expect(engineRowKeyFromId(`tk_engine_${KC}_slab`)).toBe('slab');
    expect(engineRowKeyFromId(`tk_engine_${KHAC}_wall_volume`)).toBe('wall_volume');
    expect(engineRowKeyFromId(`tk_engine_${DIEN}_mep_light`)).toBe('mep_light');
    expect(engineRowKeyFromId('tk_llm_legacy_123')).toBeNull(); // legacy id → null
    expect(engineRowKeyFromId(`tk_engine_${KC}_khong_ton_tai`)).toBeNull(); // key lạ → null
  });

  it('reducer LƯU unitPrice/source vào takeoff item', () => {
    const st = applyActions(emptyState(), [up(KC, 'slab', 'Sàn', 344, 208304)]).state;
    const item = st.takeoff.find((t) => t.id === `tk_engine_${KC}_slab`)!;
    expect(item.unitPrice).toBe(208304);
    expect(item.source).toBe('TT 13/2021');
  });

  it('LUỒNG GỘP: KC → KHAC → DIEN, mỗi bước apply — 3 dòng cùng tồn tại (không xoá nhau)', () => {
    let st = emptyState();
    // Bản KC: slab
    st = applyActions(st, [up(KC, 'slab', 'Sàn (bê tông)', 344.391)]).state;
    expect(st.takeoff).toHaveLength(1);
    // Bản KHAC: tường (mô phỏng: engine sinh delete cho STALE cùng-bản, ở đây rỗng)
    st = applyActions(st, [up(KHAC, 'wall_volume', 'Xây tường', 29.08)]).state;
    expect(st.takeoff.map((t) => t.name).sort()).toEqual(['Sàn (bê tông)', 'Xây tường']);
    // Bản DIEN: đèn
    st = applyActions(st, [up(DIEN, 'mep_light', 'Đèn', 136)]).state;
    const names = st.takeoff.map((t) => t.name).sort();
    expect(names).toEqual(['Sàn (bê tông)', 'Xây tường', 'Đèn']); // ĐỦ 3, KHÔNG mất bản nào
  });

  it('bóc LẠI cùng 1 bản chỉ thay dòng CỦA NÓ, giữ nguyên bản khác', () => {
    let st = emptyState();
    st = applyActions(st, [up(KC, 'slab', 'Sàn', 344)]).state;
    st = applyActions(st, [up(KHAC, 'wall_volume', 'Xây tường', 29)]).state;
    // Re-bóc KC: quantity đổi (344 → 400). KHAC phải còn nguyên.
    st = applyActions(st, [up(KC, 'slab', 'Sàn', 400)]).state;
    expect(st.takeoff).toHaveLength(2);
    expect(st.takeoff.find((t) => t.id === `tk_engine_${KC}_slab`)!.quantity).toBe(400);
    expect(st.takeoff.find((t) => t.id === `tk_engine_${KHAC}_wall_volume`)!.quantity).toBe(29);
  });
});

/** 1 dòng state.takeoff kiểu engine. */
const item = (drawing: string, key: string, name: string, qty: number, price?: number): TakeoffItem =>
  ({ id: `tk_engine_${drawing}_${key}`, group: 'G', code: '', name, unit: 'm2', quantity: qty, note: `x [nhóm:${key}]`, unitPrice: price, source: price != null ? 'TT13' : undefined }) as TakeoffItem;
/** 1 dòng mới engine sinh cho bản đang bóc. */
const erow = (key: string, name: string, qty: number): TakeoffEngineRow =>
  ({ key, group: 'wall', boqGroup: 'G', code: '', name, unit: 'm2', quantity: qty, note: `x [nhóm:${key}]` }) as TakeoffEngineRow;

describe('planEngineTakeoffMerge — chỗ fix (staleIds + mergedRows)', () => {
  it('bóc bản KHAC khi state có dòng KC → KHÔNG xoá dòng KC (bug cũ: xoá sạch)', () => {
    const existing = [item(KC, 'slab', 'Sàn', 344)];
    const { staleIds, mergedRows } = planEngineTakeoffMerge(existing, KHAC, [erow('wall_volume', 'Xây tường', 29)]);
    expect(staleIds).toEqual([]); // KC slab KHÔNG bị xoá
    // mergedRows phải gồm CẢ slab (bản KC) lẫn tường (bản KHAC) → mirror render đủ
    expect(mergedRows.map((r) => r.name).sort()).toEqual(['Sàn', 'Xây tường']);
  });

  it('mergedRows giữ GIÁ của bản khác (không blank khi render lại)', () => {
    const existing = [item(KC, 'slab', 'Sàn', 2, 208304)];
    const { mergedRows } = planEngineTakeoffMerge(existing, KHAC, [erow('wall_volume', 'Tường', 1)]);
    const slab = mergedRows.find((r) => r.name === 'Sàn')!;
    expect(slab.unitPrice).toBe(208304);
    expect(slab.totalPrice).toBe(416608); // 208304 × 2
  });

  it('bóc LẠI bản KC (slab không còn, có beam) → xoá slab CỦA KC, giữ bản khác', () => {
    const existing = [item(KC, 'slab', 'Sàn', 344), item(KHAC, 'wall_volume', 'Tường', 29)];
    const { staleIds, mergedRows } = planEngineTakeoffMerge(existing, KC, [erow('beam_concrete', 'Dầm', 5)]);
    expect(staleIds).toEqual([`tk_engine_${KC}_slab`]); // chỉ slab CỦA KC
    expect(mergedRows.map((r) => r.name).sort()).toEqual(['Dầm', 'Tường']); // KHAC tường còn
  });

  it('re-bóc cùng rowKey → KHÔNG stale (upsert thay tại chỗ), không xoá', () => {
    const existing = [item(KC, 'slab', 'Sàn', 344)];
    const { staleIds } = planEngineTakeoffMerge(existing, KC, [erow('slab', 'Sàn', 400)]);
    expect(staleIds).toEqual([]);
  });

  it('dòng legacy (id không theo scheme) → được dọn', () => {
    const legacy = { id: 'tk_llm_old_1', group: 'G', code: '', name: 'Cũ', unit: 'm2', quantity: 1, note: 'x [nhóm:wall]' } as TakeoffItem;
    const { staleIds } = planEngineTakeoffMerge([legacy], KC, [erow('slab', 'Sàn', 1)]);
    expect(staleIds).toEqual(['tk_llm_old_1']);
  });

  it('mergedRows sắp theo thứ tự rowKey chuẩn (STT ổn định khi bóc lại)', () => {
    // door đứng sau wall_volume trong KEY_ORDER → dù truyền ngược vẫn ra đúng thứ tự.
    const existing = [item(KC, 'door', 'Cửa', 3)];
    const { mergedRows } = planEngineTakeoffMerge(existing, KHAC, [erow('wall_volume', 'Tường', 1)]);
    expect(mergedRows.map((r) => r.key)).toEqual(['wall_volume', 'door']);
  });
});
