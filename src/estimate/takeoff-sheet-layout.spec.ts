import { BOQ_SHEET_NAMES } from './takeoff-engine.service';
import { rowsToUpdateCells, RescueRow } from './markdown-table-actions';
import { EstimateState, Sheet } from './estimate.types';

const ROWS: RescueRow[] = [
  { stt: '1', code: 'AE.62210', name: 'Xây tường', unit: 'm3', quantity: '2152.667', note: 'x [nhóm:wall]' },
  { stt: '2', code: 'AK.21110', name: 'Trát tường', unit: 'm2', quantity: '10763.336', note: 'y [nhóm:wall]' },
];

function emptySheet(name: string, id = 's1'): Sheet {
  return { id, name, data: { cellData: {}, rowCount: 100, columnCount: 20 } };
}
function stateWith(...sheets: Sheet[]): EstimateState {
  return { sheets } as unknown as EstimateState;
}
/** Áp actions update_cells vào 1 sheet để mô phỏng lần ghi trước (cho test bóc lại). */
function applyToSheet(sheet: Sheet, r: ReturnType<typeof rowsToUpdateCells>): Sheet {
  const cd: Record<string, Record<string, any>> = JSON.parse(JSON.stringify(sheet.data?.cellData ?? {}));
  for (const a of r!.actions) {
    if (a.type !== 'update_cells') continue;
    const m = a.cell.match(/^([A-J])(\d+)$/)!;
    const col = m[1].charCodeAt(0) - 65;
    const rowIdx = Number(m[2]) - 1;
    (cd[String(rowIdx)] ??= {})[String(col)] = a.newValue === '' ? { v: '' } : { v: a.newValue };
  }
  return { ...sheet, data: { ...sheet.data, cellData: cd } };
}
const val = (s: Sheet, cell: string) => {
  const m = cell.match(/^([A-J])(\d+)$/)!;
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
    expect(val(after, 'H2')).toBe('Đơn giá');
    expect(val(after, 'I2')).toBe('Thành tiền');
    expect(val(after, 'J2')).toBe('Nguồn giá');
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

  it('bóc lại: nhận ra header engine sẵn có → KHÔNG xoá sạch rồi ghi lại từ đầu', () => {
    const sheet = emptySheet('1. Kết cấu & bao che');
    const first = applyToSheet(sheet, rowsToUpdateCells(ROWS, stateWith(sheet), '1. Kết cấu & bao che',
      { title: '1. KẾT CẤU & BAO CHE' }));
    const r2 = rowsToUpdateCells(ROWS, stateWith(first), '1. Kết cấu & bao che',
      { title: '1. KẾT CẤU & BAO CHE' });
    // Header đã khớp → KHÔNG xoá vùng title/header (dòng 1-2) để ghi lại từ đầu.
    // (Ô trống ở dòng data là giá trị thật của cột objectGroup, không phải wipe.)
    const wipedHeader = r2!.actions.filter(
      (a: any) => a.type === 'update_cells' && a.newValue === '' && /^[A-J][12]$/.test(a.cell),
    );
    expect(wipedHeader).toHaveLength(0);
    // và không ghi đè lại nhãn header (A2=STT) vì đã đúng chỗ
    const wroteHeader = r2!.actions.some((a: any) => a.cell === 'A2' && a.newValue === 'STT');
    expect(wroteHeader).toBe(false);
  });
});

describe('cột giá/nguồn — trace giá thật ghi vào Excel (không chỉ chat)', () => {
  it('row có unitPrice/totalPrice/source → 3 ô H/I/J nhận đúng giá trị, không bịa số khi thiếu', () => {
    const sheet = emptySheet('1. Kết cấu & bao che');
    const rows: RescueRow[] = [
      { stt: '1', code: 'AE.62210', name: 'Xây tường', unit: 'm3', quantity: '10', note: 'x',
        unitPrice: '1.500.000', totalPrice: '15.000.000', source: 'CB giá Hà Nội 07/2025' },
      { stt: '2', code: 'AK.21110', name: 'Trát tường', unit: 'm2', quantity: '5', note: 'y' }, // thiếu giá
    ];
    // Không truyền title → header ở dòng 1, data bắt đầu dòng 2.
    const r = rowsToUpdateCells(rows, stateWith(sheet), '1. Kết cấu & bao che');
    const after = applyToSheet(sheet, r);
    expect(val(after, 'H2')).toBe('1.500.000');
    expect(val(after, 'I2')).toBe('15.000.000');
    expect(val(after, 'J2')).toBe('CB giá Hà Nội 07/2025');
    // dòng thiếu giá → trống, KHÔNG "0"/ước lượng
    expect(val(after, 'H3')).toBe('');
    expect(val(after, 'I3')).toBe('');
    expect(val(after, 'J3')).toBe('');
  });
});

describe('chọn sheet đích — agent phải bám sheet đang mở', () => {
  const S1 = emptySheet('1. Kết cấu & bao che', 'sheet-1');
  const S2 = emptySheet('2. Hoàn thiện bề mặt', 'sheet-2');
  const S3 = emptySheet('3. Cửa & phụ kiện', 'sheet-3');

  it('hint là ID sheet đang mở → ghi vào đúng sheet đó, không rơi về sheet đầu', () => {
    const r = rowsToUpdateCells(ROWS, stateWith(S1, S2, S3), 'sheet-2');
    expect(r!.sheetName).toBe('2. Hoàn thiện bề mặt');
    expect(r!.actions.every((a: any) => a.sheetId === 'sheet-2')).toBe(true);
  });

  it('hint là TÊN sheet (đường engine) → vẫn route đúng', () => {
    const r = rowsToUpdateCells(ROWS, stateWith(S1, S2, S3), '3. Cửa & phụ kiện');
    expect(r!.sheetName).toBe('3. Cửa & phụ kiện');
    expect(r!.actions.every((a: any) => a.sheetId === 'sheet-3')).toBe(true);
  });

  it('không có hint → sheet đầu (hành vi cũ giữ nguyên)', () => {
    const r = rowsToUpdateCells(ROWS, stateWith(S1, S2, S3));
    expect(r!.sheetName).toBe('1. Kết cấu & bao che');
  });
});

/**
 * CONTRACT FE↔BE: genspec-web/app/estimate/[id]/page.tsx hardcode y hệt 3 tên này
 * (FE và BE deploy riêng, không share được constant lúc compile). Engine route dòng
 * vào sheet theo TÊN → lệch 1 ký tự là hỏng routing ÂM THẦM (sheet trống, không lỗi).
 * Test này để đổi tên ở BE thì ĐỎ ngay, buộc sửa FE cùng lúc.
 */
describe('BOQ_SHEET_NAMES — contract với FE (sửa BE phải sửa FE)', () => {
  it('3 tên sheet khớp đúng bản FE đang hardcode', () => {
    expect(BOQ_SHEET_NAMES).toEqual([
      '1. Kết cấu & bao che',
      '2. Hoàn thiện bề mặt',
      '3. Cửa & phụ kiện',
    ]);
  });
});
