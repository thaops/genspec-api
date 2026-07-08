import { executeAgentTool, findRow, getSheetState, locateSheet, reconcileByCode } from './agent-tools';
import { DEFAULT_MARKUPS, EstimateState } from './estimate.types';

function state(): EstimateState {
  return {
    projectInfo: {},
    takeoff: [],
    analyses: [],
    materials: [],
    labor: [],
    equipment: [],
    markups: { ...DEFAULT_MARKUPS },
    sheets: [
      { id: 'ov', name: 'Tổng quan', data: { cellData: { '0': { '0': { v: 'Ghi chú' } } } } },
      {
        id: 'bt',
        name: 'Bóc tách',
        data: {
          cellData: {
            '0': { '0': { v: 'STT' }, '1': { v: 'Mã hiệu' }, '2': { v: 'Tên công tác' }, '3': { v: 'Khối lượng' } },
            '1': { '0': { v: 1 }, '1': { v: 'AE.62210' }, '2': { v: 'Xây tường' }, '3': { v: 12.5 } },
            '2': { '0': { v: 2 }, '1': { v: 'AK.21110' }, '2': { v: 'Trát tường' }, '3': { v: 40 } },
          },
        },
      },
    ],
  };
}

describe('locateSheet', () => {
  it('tìm sheet bóc tách theo NỘI DUNG (detect), trả sheetId', () => {
    const r = locateSheet(state(), 'takeoff');
    expect(r.found).toBe(true);
    expect(r.sheetId).toBe('bt');
  });
  it('không có loại → found=false', () => {
    expect(locateSheet(state(), 'labor').found).toBe(false);
  });
});

describe('getSheetState', () => {
  it('trả header + sample rows', () => {
    const r = getSheetState(state(), 'bt');
    expect(r.found).toBe(true);
    expect(r.headers).toEqual(['STT', 'Mã hiệu', 'Tên công tác', 'Khối lượng']);
    expect(r.sampleRows?.length).toBe(2);
  });
});

describe('findRow (read-before-write)', () => {
  it('định vị dòng theo mã hiệu', () => {
    const r = findRow(state(), 'bt', 'AK.21110');
    expect(r.found).toBe(true);
    expect(r.row).toBe(2);
    expect(r.col).toBe(1);
    expect(r.cells).toContain('Trát tường');
  });
  it('mã không có → found=false (không đoán)', () => {
    expect(findRow(state(), 'bt', 'XX.99999').found).toBe(false);
  });
});

describe('reconcileByCode (MERGE by key, dedupe)', () => {
  it('mã đã có → matchedRow; mã mới → null; bỏ trùng', () => {
    const r = reconcileByCode(state(), 'bt', ['AE.62210', 'XX.99999', 'ae.62210']);
    expect(r).toEqual([
      { code: 'AE.62210', matchedRow: 1 },
      { code: 'XX.99999', matchedRow: null },
    ]);
  });
});

describe('executeAgentTool dispatch', () => {
  it('route đúng tool + tool lạ trả error', () => {
    expect((executeAgentTool(state(), 'locate_sheet', { type: 'takeoff' }) as any).sheetId).toBe('bt');
    expect((executeAgentTool(state(), 'no_such', {}) as any).error).toMatch(/unknown/);
  });
});
