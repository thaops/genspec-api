import { rowsToUpdateCells, RescueRow } from './markdown-table-actions';
import { EstimateState, Sheet } from './estimate.types';

const ROWS: RescueRow[] = [
  { stt: '1', code: 'AE.62210', name: 'Xây tường', unit: 'm3', quantity: '2152.667', note: 'x [nhóm:wall]' },
  { stt: '2', code: 'AK.21110', name: 'Trát tường', unit: 'm2', quantity: '10763.336', note: 'y [nhóm:wall]' },
];

function emptySheet(name: string): Sheet {
  return { id: 's1', name, data: { cellData: {}, rowCount: 100, columnCount: 20 } };
}
function stateWith(sheet: Sheet): EstimateState {
  return { sheets: [sheet] } as unknown as EstimateState;
}
/** Áp actions update_cells vào 1 sheet để mô phỏng lần ghi trước (cho test bóc lại). */
function applyToSheet(sheet: Sheet, r: ReturnType<typeof rowsToUpdateCells>): Sheet {
  const cd: Record<string, Record<string, any>> = JSON.parse(JSON.stringify(sheet.data?.cellData ?? {}));
  for (const a of r!.actions) {
    if (a.type !== 'update_cells') continue;
    const m = a.cell.match(/^([A-I])(\d+)$/)!;
    const col = m[1].charCodeAt(0) - 65;
    const rowIdx = Number(m[2]) - 1;
    (cd[String(rowIdx)] ??= {})[String(col)] = a.newValue === '' ? { v: '' } : { v: a.newValue };
  }
  return { ...sheet, data: { ...sheet.data, cellData: cd } };
}
const val = (s: Sheet, cell: string) => {
  const m = cell.match(/^([A-I])(\d+)$/)!;
  return s.data?.cellData?.[String(Number(m[2]) - 1)]?.[String(m[1].charCodeAt(0) - 65)]?.v ?? '';
};

describe('layout sheet BOQ — tiêu đề + header + footnote', () => {
  it('ghi mới: A1=title, A2/I2=header cột, data từ dòng 3', () => {
    const sheet = emptySheet('1. Kết cấu & bao che');
    const r = rowsToUpdateCells(ROWS, stateWith(sheet), '1. Kết cấu & bao che',
      { title: '1. KẾT CẤU & BAO CHE', footnote: 'ghi chú giả định' });
    const after = applyToSheet(sheet, r);
    expect(val(after, 'A1')).toBe('1. KẾT CẤU & BAO CHE');
    expect(val(after, 'A2')).toBe('STT');
    expect(val(after, 'G2')).toBe('Diễn giải');
    expect(val(after, 'B3')).toBe('AE.62210');
    expect(val(after, 'B4')).toBe('AK.21110');
    // footnote NGAY dưới data cuối (dòng 5), không chừa dòng trống
    expect(val(after, 'B5')).toBe('ghi chú giả định');
    // format action có style cho titleRow + headerRow
    const fmt: any = r!.formatAction;
    expect(fmt.type).toBe('format_sheet');
    expect(fmt.cells.some((c: any) => c.cell === 'A1')).toBe(true); // title styled
    expect(fmt.cells.some((c: any) => c.cell === 'A2')).toBe(true); // header styled
  });

  it('bóc lại: giữ title dòng 1 + header dòng 2, không đẩy bảng xuống', () => {
    const sheet = emptySheet('1. Kết cấu & bao che');
    const first = applyToSheet(sheet, rowsToUpdateCells(ROWS, stateWith(sheet), '1. Kết cấu & bao che',
      { title: '1. KẾT CẤU & BAO CHE' }));
    // bóc lại với ít dòng hơn
    const r2 = rowsToUpdateCells([ROWS[0]], stateWith(first), '1. Kết cấu & bao che',
      { title: '1. KẾT CẤU & BAO CHE' });
    const after = applyToSheet(first, r2);
    expect(val(after, 'A1')).toBe('1. KẾT CẤU & BAO CHE');
    expect(val(after, 'A2')).toBe('STT');
    expect(val(after, 'B3')).toBe('AE.62210');
    // dòng data cũ thứ 2 (B4) đã được dọn
    expect(val(after, 'B4')).toBe('');
  });
});
