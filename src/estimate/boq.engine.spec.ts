import { compute, resourcePrice, analysisUnitPrice } from './boq.engine';
import { DEFAULT_MARKUPS, EstimateState } from './estimate.types';

function baseState(): EstimateState {
  return {
    projectInfo: {},
    takeoff: [],
    analyses: [],
    materials: [
      { id: 'm1', code: 'VL.XM', name: 'Xi măng', unit: 'kg', price: 2500 },
      { id: 'm2', code: 'VL.CT', name: 'Cát', unit: 'm3', price: 400000 },
    ],
    labor: [
      { id: 'l1', grade: '3.5/7', name: 'Thợ nề', dayRate: 350000 },
    ],
    equipment: [
      { id: 'e1', code: 'MTC', name: 'Máy trộn', unit: 'ca', shiftRate: 1200000 },
    ],
    markups: { ...DEFAULT_MARKUPS },
    sheets: [],
  };
}

describe('resourcePrice', () => {
  const state = baseState();

  it('resolves material by code', () => {
    const r = resourcePrice(state, 'material', 'VL.XM');
    expect(r.price).toBe(2500);
    expect(r.name).toBe('Xi măng');
  });

  it('resolves material by name (case-insensitive)', () => {
    const r = resourcePrice(state, 'material', 'xi măng');
    expect(r.price).toBe(2500);
  });

  it('resolves labor by grade', () => {
    const r = resourcePrice(state, 'labor', '3.5/7');
    expect(r.price).toBe(350000);
  });

  it('resolves equipment by code', () => {
    const r = resourcePrice(state, 'equipment', 'MTC');
    expect(r.price).toBe(1200000);
  });

  it('returns price 0 for unknown ref', () => {
    const r = resourcePrice(state, 'material', 'UNKNOWN');
    expect(r.price).toBe(0);
  });
});

describe('analysisUnitPrice', () => {
  const state = baseState();

  it('sums material + labor + equipment components', () => {
    const analysis = {
      id: 'a1',
      code: 'BT.MON',
      name: 'Bê tông móng',
      unit: 'm3',
      components: [
        { kind: 'material' as const, ref: 'VL.XM', norm: 300 },  // 300kg × 2500 = 750000
        { kind: 'labor' as const, ref: '3.5/7', norm: 1 },        // 1 công × 350000 = 350000
        { kind: 'equipment' as const, ref: 'MTC', norm: 0.5 },    // 0.5 ca × 1200000 = 600000
      ],
    };
    const { material, labor, machine, unitPrice } = analysisUnitPrice(state, analysis);
    expect(material).toBe(750000);
    expect(labor).toBe(350000);
    expect(machine).toBe(600000);
    expect(unitPrice).toBe(1700000);
  });

  it('returns 0 for empty components', () => {
    const analysis = { id: 'a2', code: 'X', name: 'X', unit: 'm2', components: [] };
    const r = analysisUnitPrice(state, analysis);
    expect(r.unitPrice).toBe(0);
  });

  it('rounds results to integer', () => {
    const analysis = {
      id: 'a3',
      code: 'TT',
      name: 'Test',
      unit: 'kg',
      components: [
        { kind: 'material' as const, ref: 'VL.XM', norm: 0.3333 },
      ],
    };
    const { material } = analysisUnitPrice(state, analysis);
    expect(Number.isInteger(material)).toBe(true);
  });
});

describe('compute – BOQ aggregation', () => {
  it('aggregates takeoff by work code', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: 'BT.MON', name: 'BT móng khối 1', unit: 'm3', quantity: 10 },
        { id: 't2', code: 'BT.MON', name: 'BT móng khối 2', unit: 'm3', quantity: 5 },
      ],
      analyses: [
        {
          id: 'a1',
          code: 'BT.MON',
          name: 'Bê tông móng',
          unit: 'm3',
          components: [
            { kind: 'material', ref: 'VL.XM', norm: 300 },
          ],
        },
      ],
    };

    const { boq } = compute(state);
    const row = boq.find((r) => r.code === 'BT.MON');
    expect(row).toBeDefined();
    expect(row!.quantity).toBe(15);
    expect(row!.unitPrice).toBe(750000);
    expect(row!.total).toBe(11250000);
  });

  it('returns 0 unit price when no analysis exists for a work code', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: 'XX.YY', name: 'Công tác không có đơn giá', unit: 'm2', quantity: 20 },
      ],
    };
    const { boq } = compute(state);
    expect(boq[0].unitPrice).toBe(0);
    expect(boq[0].total).toBe(0);
  });

  it('accumulates material cost separately from markups', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: 'BT.MON', name: 'BT móng', unit: 'm3', quantity: 1 },
      ],
      analyses: [
        {
          id: 'a1',
          code: 'BT.MON',
          name: 'BT móng',
          unit: 'm3',
          components: [{ kind: 'material', ref: 'VL.XM', norm: 400 }],
        },
      ],
    };
    const { costs, costSummary } = compute(state);
    expect(costs.material).toBe(1000000); // 400 × 2500
    expect(costs.labor).toBe(0);
    expect(costs.machine).toBe(0);
    // costSummary.total is grand total (after markup)
    expect(costSummary.total).toBeGreaterThan(costs.material);
  });

  it('costSummary.total includes overhead + profit + vat + contingency', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: 'BT.MON', name: 'BT móng', unit: 'm3', quantity: 1 },
      ],
      analyses: [
        {
          id: 'a1',
          code: 'BT.MON',
          name: 'BT móng',
          unit: 'm3',
          components: [{ kind: 'material', ref: 'VL.XM', norm: 400 }],
        },
      ],
    };
    const { costSummary } = compute(state);
    expect(costSummary.overhead).toBeGreaterThan(0);
    expect(costSummary.vat).toBeGreaterThan(0);
    expect(costSummary.total).toBe(
      costSummary.directTotal + costSummary.overhead + costSummary.profit + costSummary.vat + costSummary.contingency,
    );
  });

  // Ca thật (prod 17/07): 4 bản vẽ THUC HANH 2 (NHA) → 16 dòng takeoff, 15 dòng `code: ''`
  // vì engine cố ý không tự chốt mã. Gom theo code dồn cả 15 vào một rổ → "Xây tường 81047.81 m3"
  // (= tổng m³ + m² + m + cái + bộ). Ba test dưới khoá đúng chỗ đó.
  it('does not merge un-coded takeoff rows of different units into one row', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: '', name: 'Xây tường', unit: 'm3', quantity: 6290.869 },
        { id: 't2', code: '', name: 'Xây/trát tường', unit: 'm2', quantity: 28594.86 },
        { id: 't3', code: '', name: 'Len/chân tường', unit: 'm', quantity: 8665.109 },
        { id: 't4', code: '', name: 'Cửa đi', unit: 'cái', quantity: 93 },
        { id: 't5', code: '', name: 'Đèn', unit: 'bộ', quantity: 136 },
      ],
    };

    const { boq } = compute(state);
    expect(boq).toHaveLength(5);
    expect(boq.map((r) => r.quantity).sort((a, b) => a - b)).toEqual(
      [93, 136, 6290.87, 8665.11, 28594.86],
    );
    // Con số bịa của bug cũ: tổng mọi đơn vị cộng lại.
    expect(boq.some((r) => r.quantity === 43779.94)).toBe(false);
    for (const r of boq) expect(r.unit).toBeTruthy();
  });

  it('still merges un-coded rows that share name and unit (same work, 2 drawings)', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: '', name: 'Xây tường', unit: 'm3', quantity: 10 },
        { id: 't2', code: '', name: 'Xây tường', unit: 'm3', quantity: 5 },
      ],
    };

    const { boq } = compute(state);
    expect(boq).toHaveLength(1);
    expect(boq[0].quantity).toBe(15);
    expect(boq[0].name).toBe('Xây tường');
  });

  it('never sums two different units even under the same code', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: 'AF.222', name: 'Bê tông dầm', unit: 'm3', quantity: 12 },
        { id: 't2', code: 'AF.222', name: 'Ván khuôn dầm', unit: 'm2', quantity: 40 },
      ],
    };

    const { boq } = compute(state);
    expect(boq).toHaveLength(2);
    expect(boq.find((r) => r.unit === 'm3')!.quantity).toBe(12);
    expect(boq.find((r) => r.unit === 'm2')!.quantity).toBe(40);
    expect(boq.some((r) => r.quantity === 52)).toBe(false);
  });

  it('đơn giá trên dòng takeoff (Tier 1-5, không analysis) → vào Cost Summary (không còn 0)', () => {
    const state: EstimateState = {
      ...baseState(),
      takeoff: [
        { id: 't1', code: 'AE.22122', name: 'Xây tường', unit: 'm3', quantity: 10, unitPrice: 1_500_000 },
        { id: 't2', code: '', name: 'Ống nước', unit: 'm', quantity: 100, unitPrice: 120_000 },
      ] as any,
      analyses: [], // KHÔNG có phân tích đơn giá
    };
    const { boq, costSummary } = compute(state);
    const wall = boq.find((r) => r.name === 'Xây tường')!;
    expect(wall.unitPrice).toBe(1_500_000);
    expect(wall.total).toBe(15_000_000);
    // directTotal = 10×1.5tr + 100×120k = 15tr + 12tr = 27tr (không còn 0)
    expect(costSummary.directTotal).toBe(27_000_000);
    expect(costSummary.total).toBeGreaterThan(27_000_000); // + markup
  });

  it('returns empty boq for no takeoff', () => {
    const { boq, costSummary } = compute(baseState());
    expect(boq).toHaveLength(0);
    expect(costSummary.directTotal).toBe(0);
    expect(costSummary.total).toBe(0);
  });
});
