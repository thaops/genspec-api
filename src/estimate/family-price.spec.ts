import {
  applyFamilyRepresentative,
  FamilyPriceOption,
  TakeoffEngineRow,
  TakeoffRowKey,
} from './takeoff-engine.service';

const row = (key: string, unit = 'm3', unitPrice?: number): TakeoffEngineRow =>
  ({ key: key as TakeoffRowKey, group: 'x', boqGroup: 'x', code: '', name: key, unit, quantity: 10, note: 'ct', source: '—',
     ...(unitPrice != null ? { unitPrice } : {}) } as TakeoffEngineRow);

const opt = (code: string, unitPrice: number, unit = 'm3'): FamilyPriceOption =>
  ({ code, name: code, unit, unitPrice, sourceDoc: 'TT 13/2021 — HN' });

describe('applyFamilyRepresentative (Tier 3.5)', () => {
  it('áp giá MEDIAN của họ mã cho dòng chưa có giá + đánh dấu familyRep', () => {
    const opts = new Map<TakeoffRowKey, FamilyPriceOption[]>([
      ['wall_volume' as TakeoffRowKey, [opt('AF.22211', 1_000_000), opt('AF.22212', 2_000_000), opt('AF.22213', 3_000_000)]],
    ]);
    const { rows, familyRepCount } = applyFamilyRepresentative([row('wall_volume')], opts);
    expect(familyRepCount).toBe(1);
    expect(rows[0].unitPrice).toBe(2_000_000); // median
    expect(rows[0].code).toBe('AF.22212');
    expect(rows[0].familyRep).toBe(true);
    expect(rows[0].totalPrice).toBe(20_000_000);
    expect(rows[0].source).toContain('đại diện họ mã');
  });

  it('KHÔNG đụng dòng đã có giá (Tier 1-4 thắng)', () => {
    const opts = new Map<TakeoffRowKey, FamilyPriceOption[]>([['wall_volume' as TakeoffRowKey, [opt('AF.1', 999)]]]);
    const { rows, familyRepCount } = applyFamilyRepresentative([row('wall_volume', 'm3', 500)], opts);
    expect(familyRepCount).toBe(0);
    expect(rows[0].unitPrice).toBe(500);
    expect(rows[0].familyRep).toBeUndefined();
  });

  it('quy đổi đơn vị (100m2 → m2) khi áp giá', () => {
    const opts = new Map<TakeoffRowKey, FamilyPriceOption[]>([
      ['wall_area' as TakeoffRowKey, [opt('AK.211', 8_000_000, '100m2')]],
    ]);
    const { rows } = applyFamilyRepresentative([row('wall_area', 'm2')], opts);
    expect(rows[0].unitPrice).toBe(80_000); // 8tr / 100
  });

  it('bỏ biến thể lệch đơn vị KHÔNG quy đổi được (cái vs m2)', () => {
    const opts = new Map<TakeoffRowKey, FamilyPriceOption[]>([
      ['door' as TakeoffRowKey, [opt('X', 5_000_000, 'm2')]],
    ]);
    const { rows, familyRepCount } = applyFamilyRepresentative([row('door', 'cái')], opts);
    expect(familyRepCount).toBe(0);
    expect(rows[0].unitPrice).toBeUndefined();
  });

  it('không có option → để trống (rơi Tier 5 sau)', () => {
    const { rows, familyRepCount } = applyFamilyRepresentative([row('wall_volume')], new Map());
    expect(familyRepCount).toBe(0);
    expect(rows[0].unitPrice).toBeUndefined();
  });
});
