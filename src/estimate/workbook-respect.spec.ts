import { rowsToUpdateCells, RescueRow } from './markdown-table-actions';
import { EstimateState, Sheet } from './estimate.types';

// Workbook CỦA CÔNG TY (Template A) — header khác GenSpec, có dữ liệu thật.
function companySheet(): Sheet {
  return {
    id: 'user-boq', name: 'BẢNG KHỐI LƯỢNG',
    data: { cellData: {
      '0': { '0': { v: 'TT' }, '1': { v: 'MÃ CÔNG TÁC' }, '2': { v: 'DIỄN GIẢI CÔNG VIỆC' }, '3': { v: 'ĐVT' }, '4': { v: 'KL' } },
      '1': { '0': { v: 1 }, '1': { v: 'AE.11110' }, '2': { v: 'Đào móng bằng thủ công' }, '3': { v: 'm3' }, '4': { v: 45.2 } },
      '2': { '0': { v: 2 }, '1': { v: 'AF.11220' }, '2': { v: 'Bê tông lót móng' }, '3': { v: 'm3' }, '4': { v: 12.8 } },
    }, rowCount: 100, columnCount: 20 },
  } as unknown as Sheet;
}
const ROWS: RescueRow[] = [{ stt: '1', code: 'AE.62210', name: 'Xây tường', unit: 'm3', quantity: '10', note: 'x' }];
const st = (s: Sheet) => ({ sheets: [s] }) as unknown as EstimateState;
const wipes = (r: ReturnType<typeof rowsToUpdateCells>) =>
  r!.actions.filter((a: any) => a.type === 'update_cells' && a.newValue === '' && a.oldValue !== '');

/**
 * GENSPEC-VISION CASE 2/3: "AI KHÔNG được chuyển Workbook về template GenSpec".
 * Trước fix: header không khớp → xoá sạch A1:J{lastRow} → probe thật đếm được
 * 16 ô của user bị xoá (cả header lẫn "Đào móng bằng thủ công 45.2 m³").
 */
describe('Workbook của user — TUYỆT ĐỐI không phá', () => {
  it('sheet công ty (header lạ) → 0 ô bị xoá', () => {
    const r = rowsToUpdateCells(ROWS, st(companySheet()), 'user-boq');
    expect(wipes(r)).toHaveLength(0);
  });

  it('KHÔNG ghi đè header của user bằng header GenSpec', () => {
    const r = rowsToUpdateCells(ROWS, st(companySheet()), 'user-boq');
    const touchedHeader = r!.actions.filter((a: any) => /^[A-J]1$/.test(a.cell));
    expect(touchedHeader).toHaveLength(0);
  });

  it('dữ liệu mới ghi TIẾP dưới dòng cuối (dòng 4), không đè dòng 2-3 của user', () => {
    const r = rowsToUpdateCells(ROWS, st(companySheet()), 'user-boq');
    const rowsTouched = [...new Set(r!.actions.map((a: any) => Number(a.cell.match(/\d+/)[0])))];
    expect(Math.min(...rowsTouched)).toBeGreaterThanOrEqual(4); // user dùng dòng 1-3
  });

  it('sheet do ENGINE tạo (engineOwnedSheet) → vẫn được dựng lại layout (không hồi quy)', () => {
    const junk = { id: 's1', name: '1. Kết cấu & bao che',
      data: { cellData: { '0': { '0': { v: 'rác cũ' } } }, rowCount: 100, columnCount: 20 } } as unknown as Sheet;
    const r = rowsToUpdateCells(ROWS, st(junk), 's1', { engineOwnedSheet: true, title: 'X' });
    expect(r!.actions.some((a: any) => a.newValue === 'STT')).toBe(true); // có ghi header GenSpec
  });

  it('sheet GenSpec đã đúng layout → bóc lại vẫn cập nhật tại chỗ (không hồi quy)', () => {
    const first = rowsToUpdateCells(ROWS, st({ id: 's1', name: '1. Kết cấu & bao che',
      data: { cellData: {}, rowCount: 100, columnCount: 20 } } as unknown as Sheet), 's1', { engineOwnedSheet: true });
    expect(first!.actions.some((a: any) => a.newValue === 'STT')).toBe(true);
  });
});
