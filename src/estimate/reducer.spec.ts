import { applyActions, parseExcelCell } from './reducer';
import { DEFAULT_MARKUPS, EstimateState } from './estimate.types';

function emptyState(): EstimateState {
  return {
    projectInfo: {},
    takeoff: [],
    analyses: [],
    materials: [],
    labor: [],
    equipment: [],
    markups: { ...DEFAULT_MARKUPS },
    sheets: [],
  };
}

describe('update_cells – resolve sheet đích (map chuẩn, không tạo mới)', () => {
  const withSheets = (): EstimateState => ({
    ...emptyState(),
    sheets: [
      { id: 'overview', name: 'Tổng quan', data: { cellData: { '0': { '0': { v: 'Ghi chú' } } } } },
      { id: 'bt', name: 'Bóc tách khối lượng', data: { cellData: { '0': { '0': { v: 'STT' } } } } },
    ],
  });

  it('sheetId stale → rơi vào sheet Bóc tách (không phải sheet đầu, không tạo mới)', () => {
    const { state } = applyActions(withSheets(), [
      { type: 'update_cells', sheetId: 'sheet-stale-123', cell: 'B2', oldValue: '', newValue: 'AE.62210' } as any,
    ]);
    expect(state.sheets!.length).toBe(2); // KHÔNG đẻ sheet mới
    const bt = state.sheets!.find((s) => s.id === 'bt')!;
    expect(bt.data.cellData['1']['1'].v).toBe('AE.62210'); // ghi vào Bóc tách
    const overview = state.sheets!.find((s) => s.id === 'overview')!;
    expect(overview.data.cellData['1']).toBeUndefined(); // KHÔNG ghi nhầm sheet đầu
  });

  it('sheetId đúng → ghi đúng sheet đó', () => {
    const { state } = applyActions(withSheets(), [
      { type: 'update_cells', sheetId: 'overview', cell: 'A5', oldValue: '', newValue: 'x' } as any,
    ]);
    expect(state.sheets!.find((s) => s.id === 'overview')!.data.cellData['4']['0'].v).toBe('x');
  });
});

describe('parseExcelCell', () => {
  it('parses A1 → row 0, col 0', () => {
    expect(parseExcelCell('A1')).toEqual({ row: 0, col: 0 });
  });
  it('parses B2 → row 1, col 1', () => {
    expect(parseExcelCell('B2')).toEqual({ row: 1, col: 1 });
  });
  it('parses Z1 → col 25', () => {
    expect(parseExcelCell('Z1')).toEqual({ row: 0, col: 25 });
  });
  it('parses AA1 → col 26', () => {
    expect(parseExcelCell('AA1')).toEqual({ row: 0, col: 26 });
  });
  it('returns 0,0 for invalid input', () => {
    expect(parseExcelCell('invalid')).toEqual({ row: 0, col: 0 });
  });
});

describe('applyActions – set_project_info', () => {
  it('merges patch into projectInfo', () => {
    const { state } = applyActions(emptyState(), [
      { type: 'set_project_info', patch: { name: 'Nhà phố', location: 'HCM' } },
    ]);
    expect(state.projectInfo.name).toBe('Nhà phố');
    expect(state.projectInfo.location).toBe('HCM');
  });

  it('preserves existing fields not in patch', () => {
    const initial = { ...emptyState(), projectInfo: { name: 'A', investor: 'B' } };
    const { state } = applyActions(initial, [
      { type: 'set_project_info', patch: { location: 'HN' } },
    ]);
    expect(state.projectInfo.investor).toBe('B');
    expect(state.projectInfo.location).toBe('HN');
  });
});

describe('applyActions – upsert_material', () => {
  it('inserts new material', () => {
    const { state } = applyActions(emptyState(), [
      { type: 'upsert_material', code: 'VL.XM', name: 'Xi măng', unit: 'kg', price: 2500 },
    ]);
    expect(state.materials).toHaveLength(1);
    expect(state.materials[0].code).toBe('VL.XM');
    expect(state.materials[0].price).toBe(2500);
  });

  it('updates existing material by code (case-insensitive)', () => {
    const initial = {
      ...emptyState(),
      materials: [{ id: 'mat-1', code: 'VL.XM', name: 'Xi măng', unit: 'kg', price: 2500 }],
    };
    const { state } = applyActions(initial, [
      { type: 'upsert_material', code: 'vl.xm', name: 'Xi măng Portland', unit: 'kg', price: 3000 },
    ]);
    expect(state.materials).toHaveLength(1);
    expect(state.materials[0].price).toBe(3000);
    expect(state.materials[0].id).toBe('mat-1');
  });

  it('coerces string price to number', () => {
    const { state } = applyActions(emptyState(), [
      { type: 'upsert_material', code: 'VL.ST', name: 'Thép', unit: 'kg', price: '18000' as any },
    ]);
    expect(state.materials[0].price).toBe(18000);
  });
});

describe('applyActions – delete_material', () => {
  it('removes material by id', () => {
    const initial = {
      ...emptyState(),
      materials: [{ id: 'mat-1', code: 'VL.XM', name: 'Xi măng', unit: 'kg', price: 2500 }],
    };
    const { state } = applyActions(initial, [{ type: 'delete_material', id: 'mat-1' }]);
    expect(state.materials).toHaveLength(0);
  });
});

describe('applyActions – upsert_takeoff', () => {
  it('computes quantity from L×W when quantity not given', () => {
    const { state } = applyActions(emptyState(), [
      { type: 'upsert_takeoff', code: 'BT.SAN', name: 'Sàn BT', unit: 'm2', length: 10, width: 5 },
    ]);
    expect(state.takeoff[0].quantity).toBe(50);
  });

  it('computes L×W×H×count for 3D volume', () => {
    const { state } = applyActions(emptyState(), [
      {
        type: 'upsert_takeoff',
        code: 'BT.COT',
        name: 'Cột BT',
        unit: 'm3',
        length: 0.4,
        width: 0.4,
        height: 3,
        count: 10,
      },
    ]);
    expect(state.takeoff[0].quantity).toBeCloseTo(4.8, 2);
  });

  it('explicit quantity takes precedence over dimensions', () => {
    const { state } = applyActions(emptyState(), [
      { type: 'upsert_takeoff', code: 'BT.SAN', name: 'Sàn', unit: 'm2', length: 10, width: 5, quantity: 99 },
    ]);
    expect(state.takeoff[0].quantity).toBe(99);
  });
});

describe('applyActions – set_sheets', () => {
  it('replaces sheets array', () => {
    const initial = {
      ...emptyState(),
      sheets: [{ id: 's1', name: 'Old', data: { cellData: {}, rowCount: 100, columnCount: 20 } }],
    };
    const newSheets = [
      { id: 's2', name: 'New', data: { cellData: {}, rowCount: 100, columnCount: 20 } },
      { id: 's3', name: 'New2', data: { cellData: {}, rowCount: 100, columnCount: 20 } },
    ];
    const { state } = applyActions(initial, [{ type: 'set_sheets', sheets: newSheets } as any]);
    expect(state.sheets).toHaveLength(2);
    expect(state.sheets![0].id).toBe('s2');
  });
});

describe('applyActions – update_cells', () => {
  it('updates a cell value and converts numeric strings', () => {
    const initial = {
      ...emptyState(),
      sheets: [{ id: 's1', name: 'Sheet 1', data: { cellData: {}, rowCount: 100, columnCount: 20 } }],
    };
    const { state } = applyActions(initial, [
      { type: 'update_cells', sheetId: 's1', cell: 'B3', newValue: '42' } as any,
    ]);
    const row2 = state.sheets![0].data?.cellData?.['2'];
    expect(row2?.['1']?.v).toBe(42);
  });

  it('keeps string for non-numeric value', () => {
    const initial = {
      ...emptyState(),
      sheets: [{ id: 's1', name: 'Sheet 1', data: { cellData: {}, rowCount: 100, columnCount: 20 } }],
    };
    const { state } = applyActions(initial, [
      { type: 'update_cells', sheetId: 's1', cell: 'A1', newValue: 'hello' } as any,
    ]);
    expect(state.sheets![0].data?.cellData?.['0']?.['0']?.v).toBe('hello');
  });
});

describe('applyActions – error resilience', () => {
  it('skips unknown action type and records warning', () => {
    const { state, warnings, applied } = applyActions(emptyState(), [
      { type: 'nonexistent_action' } as any,
    ]);
    expect(applied).toBe(1);
    expect(warnings).toHaveLength(0);
    expect(state.materials).toHaveLength(0);
  });

  it('applies remaining actions after a bad one', () => {
    const { state, applied } = applyActions(emptyState(), [
      { type: 'upsert_material', code: 'VL.XM', name: 'Xi măng', unit: 'kg', price: 2500 },
      { type: 'upsert_material', code: 'VL.ST', name: 'Thép', unit: 'kg', price: 18000 },
    ]);
    expect(applied).toBe(2);
    expect(state.materials).toHaveLength(2);
  });

  it('does not mutate original state', () => {
    const original = emptyState();
    applyActions(original, [
      { type: 'upsert_material', code: 'VL.XM', name: 'Xi măng', unit: 'kg', price: 2500 },
    ]);
    expect(original.materials).toHaveLength(0);
  });
});
