import { engineRowKeyFromId, planEngineTakeoffMerge, regionIdOf, TakeoffEngineRow } from './takeoff-engine.service';
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

describe('planEngineTakeoffMerge — VÙNG (chống bóc đè cùng bản)', () => {
  const rA = 'aaaa1111', rB = 'bbbb2222';
  /** dòng đã ghi cho (bản, vùng). */
  const ritem = (region: string, key: string, qty: number): TakeoffItem =>
    ({ id: `tk_engine_${KC}_${region}_${key}`, group: 'G', code: '', name: key, unit: 'm2', quantity: qty, note: '' }) as TakeoffItem;

  it('regionIdOf: cùng bbox → cùng mã; khác bbox → khác mã; không region → 00000000', () => {
    const r1 = regionIdOf({ x: 10, y: 20, w: 30, h: 40 });
    expect(regionIdOf({ x: 10, y: 20, w: 30, h: 40 })).toBe(r1); // tất định
    expect(regionIdOf({ x: 11, y: 20, w: 30, h: 40 })).not.toBe(r1);
    expect(regionIdOf(undefined)).toBe('00000000');
    expect(r1).toMatch(/^[0-9a-f]{8}$/);
  });

  it('bóc vùng B khi đã có vùng A (cùng bản, cùng rowKey) → KHÔNG xoá vùng A', () => {
    const existing = [ritem(rA, 'slab', 344)];
    // rows của vùng B (regionId=rB)
    const { staleIds, mergedRows } = planEngineTakeoffMerge(existing, KC, [erow('slab', 'Sàn', 100)], rB);
    expect(staleIds).toEqual([]); // vùng A slab KHÔNG bị đè
    // mergedRows gồm CẢ slab vùng A (344) lẫn slab vùng B (100) → 2 dòng
    expect(mergedRows.filter((r) => r.key === 'slab').length).toBe(2);
    expect(mergedRows.some((r) => r.quantity === 344)).toBe(true);
    expect(mergedRows.some((r) => r.quantity === 100)).toBe(true);
  });

  it('bóc LẠI vùng A → thay ĐÚNG vùng A, giữ vùng B', () => {
    const existing = [ritem(rA, 'slab', 344), ritem(rB, 'slab', 100)];
    const { staleIds, mergedRows } = planEngineTakeoffMerge(existing, KC, [erow('slab', 'Sàn', 500)], rA);
    expect(staleIds).toEqual([]); // slab vùng A upsert tại chỗ (cùng id)
    // vùng B (100) GIỮ; vùng A giờ là 500 (từ rows mới)
    expect(mergedRows.some((r) => r.quantity === 100)).toBe(true); // vùng B còn
    expect(mergedRows.some((r) => r.quantity === 500)).toBe(true); // vùng A mới
    expect(mergedRows.some((r) => r.quantity === 344)).toBe(false); // vùng A cũ đã thay
  });

  it('bóc TOÀN BẢN (không region) → dọn HẾT vùng (đo lại từ đầu)', () => {
    const existing = [ritem(rA, 'slab', 344), ritem(rB, 'slab', 100)];
    const { staleIds } = planEngineTakeoffMerge(existing, KC, [erow('slab', 'Sàn', 500)]); // whole
    expect(staleIds.sort()).toEqual([`tk_engine_${KC}_${rA}_slab`, `tk_engine_${KC}_${rB}_slab`].sort());
  });
});
