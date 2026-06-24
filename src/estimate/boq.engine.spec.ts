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

  it('returns empty boq for no takeoff', () => {
    const { boq, costSummary } = compute(baseState());
    expect(boq).toHaveLength(0);
    expect(costSummary.directTotal).toBe(0);
    expect(costSummary.total).toBe(0);
  });
});
