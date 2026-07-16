import { parseNormRows, parseNumber, CellRow } from './catalog-import.parser';

/**
 * BUG THẬT (lộ ra khi nạp định mức TT12/2021): `workbookToRows` ép MỌI ô về chuỗi →
 * hao phí xi măng `308.525 kg` thành `"308.525"` → `parseNumber` khớp regex "kiểu Việt"
 * (`1.234` = 1234) → **308525**, SAI 1000 LẦN. Đơn giá bê tông sẽ vô nghĩa mà vẫn kèm
 * nguồn "TT 12/2021" trông rất chính thống — đúng loại sai nguy hiểm nhất.
 *
 * Với số ≥100 có ĐÚNG 3 số lẻ, chuỗi KHÔNG phân biệt được thập phân vs phân cách nghìn
 * (dấu phẩy cũng vậy: "308,525" khớp regex "kiểu Anh") ⇒ phải GIỮ NGUYÊN kiểu number.
 */
describe('Định mức: hao phí phải giữ đúng số lẻ (chống sai 1000×)', () => {
  const HEADER: CellRow = ['Mã hiệu', 'Mã hao phí', 'Tên công tác', 'Đơn vị', 'Định mức'];
  const rowsOf = (comps: CellRow[]): CellRow[] => [
    HEADER,
    ['AF.12213', '', 'Bê tông cột M200', 'm3', ''],
    ['', '', 'Vật liệu', '', ''],
    ...comps,
  ];

  it('CA THẬT: xi măng 308.525 kg giữ nguyên số — KHÔNG thành 308525', () => {
    const r = parseNormRows(rowsOf([['', 'V08770', 'Xi măng PCB40', 'kg', 308.525]]));
    expect(r.items[0].components[0].norm).toBe(308.525);
  });

  it('CA THẬT: nước 187.575 lít — số ≥100 có 3 số lẻ là ca hỏng', () => {
    const r = parseNormRows(rowsOf([['', 'V00494', 'Nước', 'lít', 187.575]]));
    expect(r.items[0].components[0].norm).toBe(187.575);
  });

  it('số nhỏ vẫn đúng (cát 0.532, máy 0.095)', () => {
    const r = parseNormRows(rowsOf([
      ['', 'V00112', 'Cát vàng', 'm3', 0.532],
      ['', 'M104', 'Máy trộn', 'ca', 0.095],
    ]));
    expect(r.items[0].components.map((c) => c.norm)).toEqual([0.532, 0.095]);
  });

  it('số nguyên vẫn đúng (101 m cọc)', () => {
    const r = parseNormRows(rowsOf([['', 'V03543', 'Cọc BTCT', 'm', 101]]));
    expect(r.items[0].components[0].norm).toBe(101);
  });

  it('kind suy từ section header (Vật liệu/Nhân công/Máy thi công)', () => {
    const r = parseNormRows([
      HEADER,
      ['AF.12213', '', 'Bê tông cột M200', 'm3', ''],
      ['', '', 'Vật liệu', '', ''],
      ['', 'V08770', 'Xi măng PCB40', 'kg', 308.525],
      ['', '', 'Nhân công', '', ''],
      ['', 'N0015', 'Nhân công bậc 3,5/7', 'công', 3.15],
      ['', '', 'Máy thi công', '', ''],
      ['', 'M104', 'Máy trộn bê tông', 'ca', 0.095],
    ]);
    expect(r.items[0].components.map((c) => c.kind)).toEqual(['material', 'labor', 'machine']);
    expect(r.items[0].components.map((c) => c.refCode)).toEqual(['V08770', 'N0015', 'M104']);
  });

  /** parseNumber vẫn phải đọc đúng CHUỖI kiểu Việt/Anh (file khác vẫn gửi chuỗi). */
  it('parseNumber giữ nguyên hành vi với chuỗi có phân cách nghìn', () => {
    expect(parseNumber('1.234.567')).toBe(1234567); // VN
    expect(parseNumber('1,234,567')).toBe(1234567); // EN
    expect(parseNumber('0,342')).toBe(0.342); // VN thập phân
    expect(parseNumber(308.525)).toBe(308.525); // number → nguyên vẹn
  });
});
