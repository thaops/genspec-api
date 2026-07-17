import { parsePriceRows, CellRow } from './catalog-import.parser';

/**
 * CA THẬT — công bố giá Sở Xây dựng Hà Nội (01.02/2026/CBGVL-SXD, giá VLXD T4/2026):
 * bảng tách theo MỎ/BÃI, tiêu đề nhóm là dòng KHÔNG có đơn giá nằm trên các dòng vật liệu.
 * Trước đây rơi vào nhánh "không có đơn giá → bỏ qua" ⇒ MẤT thông tin mỏ.
 *
 * Mất mỏ = giá vô dụng: CÙNG "Cát vàng" có **600.000↔800.000đ/m³ tuỳ bãi** (chênh 33%,
 * số thật). Chính văn bản công bố yêu cầu "căn cứ địa điểm công trình, địa điểm cung cấp
 * vật tư, cự ly vận chuyển… để lựa chọn" ⇒ engine KHÔNG chọn hộ, phải bày ra kèm mỏ.
 */
describe('parsePriceRows — giữ MỎ/BÃI (sourcePoint) của từng giá', () => {
  const HEADER: CellRow = ['Tên vật liệu', 'Đơn vị tính', 'Đơn giá'];
  /** Trích đúng cấu trúc phụ lục công bố T4/2026. */
  const REAL: CellRow[] = [
    HEADER,
    ['Bãi tại thôn Đồng Xung - Xã ứng Hòa', '', null as any],
    ['Cát đen', 'm3', 390000],
    ['Cát vàng', 'm3', 750000],
    ['Bãi Cầu Trung Hà, xã Vật Lại', '', null as any],
    ['Cát đen', 'm3', 250000],
    ['Cát vàng', 'm3', 600000],
    ['Mỏ đá Gò Chói – xã Yên Xuân', '', null as any],
    ['Đá 1x2', 'm3', 495545],
  ];

  it('CA THẬT: mỗi giá gắn đúng mỏ/bãi của nó', () => {
    const r = parsePriceRows(REAL);
    expect(r.items.map((i) => [i.name, i.price, i.sourcePoint])).toEqual([
      ['Cát đen', 390000, 'Bãi tại thôn Đồng Xung - Xã ứng Hòa'],
      ['Cát vàng', 750000, 'Bãi tại thôn Đồng Xung - Xã ứng Hòa'],
      ['Cát đen', 250000, 'Bãi Cầu Trung Hà, xã Vật Lại'],
      ['Cát vàng', 600000, 'Bãi Cầu Trung Hà, xã Vật Lại'],
      ['Đá 1x2', 495545, 'Mỏ đá Gò Chói – xã Yên Xuân'],
    ]);
  });

  it('CÙNG vật liệu, mỏ khác → 2 dòng RIÊNG (không gộp, không trung bình)', () => {
    const cats = parsePriceRows(REAL).items.filter((i) => i.name === 'Cát vàng');
    expect(cats).toHaveLength(2);
    expect(cats.map((c) => c.price)).toEqual([750000, 600000]); // giữ cả hai — QS chọn theo cự ly
  });

  it('tiêu đề mỏ KHÔNG bị coi là lỗi "không có đơn giá"', () => {
    expect(parsePriceRows(REAL).errors).toEqual([]);
  });

  it('dòng CÓ đơn vị nhưng THIẾU giá vẫn là lỗi (không nhầm thành tiêu đề mỏ)', () => {
    const r = parsePriceRows([HEADER, ['Mỏ X', '', null as any], ['Cát vàng', 'm3', null as any]]);
    expect(r.items).toHaveLength(0);
    expect(r.errors[0]).toMatch(/Cát vàng.*không có đơn giá/);
  });

  it('giá giữ nguyên số nguyên lớn (495.545 ≠ 495,545 kiểu Anh)', () => {
    expect(parsePriceRows(REAL).items.find((i) => i.name === 'Đá 1x2')!.price).toBe(495545);
  });
});
