import { applyActions } from './reducer';
import { buildTakeoffFormatAction } from './markdown-table-actions';
import { EstimateState, Sheet } from './estimate.types';

function sheet(): Sheet {
  return { id: 's1', name: '1. Kết cấu & bao che', data: { cellData: {}, rowCount: 100, columnCount: 20 } } as unknown as Sheet;
}
const stateWith = (s: Sheet) => ({ sheets: [s], takeoff: [], analyses: [], materials: [], labor: [], equipment: [], projectInfo: {}, markups: {} }) as unknown as EstimateState;
const cellOf = (st: EstimateState, r: number, c: number) => (st.sheets![0].data as any)?.cellData?.[String(r)]?.[String(c)];

/**
 * BUG THẬT (do chính lượt thêm cột Đơn giá/Thành tiền gây ra): reducer ép kiểu bằng
 * `isFinite(Number(v)) ? Number(v) : v`. Ghi "1.500.000" (toLocaleString) →
 * Number("1.500.000") = NaN → giữ CHUỖI → Excel KHÔNG cộng/sort được cột Thành tiền
 * ⇒ BOQ không tổng được tiền = vô dụng.
 */
describe('Cột tiền phải là SỐ, không phải text', () => {
  it('ghi số thô "1500000" → reducer lưu thành NUMBER', () => {
    const st = applyActions(stateWith(sheet()), [
      { type: 'update_cells', sheetId: 's1', cell: 'I3', oldValue: '', newValue: '1500000' },
    ] as any).state;
    const v = cellOf(st, 2, 8)?.v;
    expect(typeof v).toBe('number');
    expect(v).toBe(1500000);
  });

  it('CHỨNG MINH bug cũ: chuỗi đã format "1.500.000" → lưu thành STRING (không cộng được)', () => {
    const st = applyActions(stateWith(sheet()), [
      { type: 'update_cells', sheetId: 's1', cell: 'I3', oldValue: '', newValue: '1.500.000' },
    ] as any).state;
    expect(typeof cellOf(st, 2, 8)?.v).toBe('string'); // đây là hành vi CŨ, nên KHÔNG ghi kiểu này nữa
  });

  it('khối lượng "314.701" vẫn là số (1 dấu chấm = số thập phân)', () => {
    const st = applyActions(stateWith(sheet()), [
      { type: 'update_cells', sheetId: 's1', cell: 'F3', oldValue: '', newValue: '314.701' },
    ] as any).state;
    expect(cellOf(st, 2, 5)?.v).toBe(314.701);
  });

  it('ô giá TRỐNG vẫn trống — không bị ép thành 0', () => {
    const st = applyActions(stateWith(sheet()), [
      { type: 'update_cells', sheetId: 's1', cell: 'I4', oldValue: '', newValue: '' },
    ] as any).state;
    expect(cellOf(st, 3, 8)?.v).toBeNull();
  });
});

describe('format_sheet: number format + wrap + freeze', () => {
  const fmt: any = buildTakeoffFormatAction('s1', 2, 3, 5, undefined, undefined, 1);

  // Layout: A=STT B=Mã hiệu C=Tên D=Nhóm E=ĐVT F=Khối lượng G=Đơn giá H=Thành tiền
  // I=Nguồn J=Bản vẽ K=Diễn giải. Diễn giải để CUỐI: nó dài 420px, đặt giữa KL và Đơn giá thì
  // đẩy cột tiền ra khỏi tầm nhìn — QS phải cuộn ngang mới thấy tiền.
  it('cột Đơn giá(G)/Thành tiền(H) có number format #,##0 — hiển thị có phân cách mà giá trị vẫn là số', () => {
    expect(fmt.cells.find((c: any) => c.cell === 'G3').s.n).toEqual({ pattern: '#,##0' });
    expect(fmt.cells.find((c: any) => c.cell === 'H3').s.n).toEqual({ pattern: '#,##0' });
  });

  /**
   * BUG THẬT (thấy trên sheet): pattern `#,##0.###` in DẤU CHẤM THỪA cho số nguyên —
   * "93 cái" → **"93."**, "136 bộ" → "136.". Dấu `.` trong pattern là literal, luôn hiện.
   * ⇒ Khối lượng KHÔNG gán number format, để General: 93 → "93", 314.701 → "314.701".
   */
  it('cột Khối lượng(F) KHÔNG có number format — tránh dấu chấm thừa "93."', () => {
    expect(fmt.cells.find((c: any) => c.cell === 'F3').s.n).toBeUndefined();
  });

  it('cột Tên(C)/Diễn giải(K) có wrap text — chữ dài không bị cắt', () => {
    expect(fmt.cells.find((c: any) => c.cell === 'C3').s.tb).toBe(3);
    expect(fmt.cells.find((c: any) => c.cell === 'K3').s.tb).toBe(3);
  });

  it('cột chữ KHÔNG bị gán number format (nếu không sẽ hỏng hiển thị mã/tên/nguồn)', () => {
    expect(fmt.cells.find((c: any) => c.cell === 'B3').s.n).toBeUndefined();
    expect(fmt.cells.find((c: any) => c.cell === 'I3').s.n).toBeUndefined(); // Nguồn giá
    expect(fmt.cells.find((c: any) => c.cell === 'J3').s.n).toBeUndefined(); // Bản vẽ
    expect(fmt.cells.find((c: any) => c.cell === 'K3').s.n).toBeUndefined(); // Diễn giải
  });

  it('freeze tính từ headerRow THẬT (không hardcode 2)', () => {
    expect(fmt.freeze).toEqual({ xSplit: 0, ySplit: 2, startRow: 2, startColumn: 0 });
    const noTitle: any = buildTakeoffFormatAction('s1', 1, 2, 4);
    expect(noTitle.freeze).toEqual({ xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 });
  });

  it('sheet của USER (headerRow=null) → KHÔNG đụng freeze của họ', () => {
    const userSheet: any = buildTakeoffFormatAction('s1', null, 5, 7);
    expect(userSheet.freeze).toBeUndefined();
  });

  it('reducer apply được freeze vào sheet data', () => {
    const st = applyActions(stateWith(sheet()), [fmt] as any).state;
    expect((st.sheets![0].data as any).freeze).toEqual({ xSplit: 0, ySplit: 2, startRow: 2, startColumn: 0 });
  });
});
