import { executeAgentTool, findRow, getRow, getSheetState, locateSheet, reconcileByCode } from './agent-tools';
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

describe('getRow — định vị theo SỐ DÒNG (gap "dòng 5 sai, sửa lại")', () => {
  it('row = số dòng hiển thị (1-based, khớp cell "X<row>") — dòng 3 = Trát tường', () => {
    const r = getRow(state(), 'bt', 3);
    expect(r.found).toBe(true);
    expect(r.row).toBe(3);
    expect(r.cells).toEqual(['2', 'AK.21110', 'Trát tường', '40']);
  });

  it('dòng 1 = header (đúng như user thấy trên sheet)', () => {
    const r = getRow(state(), 'bt', 1);
    expect(r.found).toBe(true);
    expect(r.cells).toEqual(['STT', 'Mã hiệu', 'Tên công tác', 'Khối lượng']);
  });

  it('dòng 2 = Xây tường (không lệch off-by-one)', () => {
    const r = getRow(state(), 'bt', 2);
    expect(r.cells).toEqual(['1', 'AE.62210', 'Xây tường', '12.5']);
  });

  it('dòng ngoài phạm vi / trống → found=false, KHÔNG bịa nội dung', () => {
    expect(getRow(state(), 'bt', 99).found).toBe(false);
    expect(getRow(state(), 'bt', 0).found).toBe(false);
    expect(getRow(state(), 'bt', -1).found).toBe(false);
  });

  it('sheet không tồn tại → found=false', () => {
    expect(getRow(state(), 'no-such-sheet', 1).found).toBe(false);
  });

  it('executeAgentTool dispatch tới get_row', () => {
    const r = executeAgentTool(state(), 'get_row', { sheetId: 'bt', row: 3 }) as any;
    expect(r.found).toBe(true);
    expect(r.cells).toContain('Trát tường');
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
