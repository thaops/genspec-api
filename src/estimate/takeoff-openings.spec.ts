import { computeTakeoffRows, isRealSection } from './takeoff-engine.service';

const A = { floorHeight: 3.3, wallThickness: 0.22, beamDepth: 0.4 } as any;
/** kích thước tính bằng mm (factor 0.001) — như bản vẽ thật. */
const o = (type: string, w: number, h: number, i = 0) =>
  ({ type, boundingBox: { x: i * 10_000, y: 0, w, h } }) as any;
const rowOf = (objs: any[], key: string) =>
  computeTakeoffRows(objs, 0.001, A, {}, undefined).find((r: any) => r.key === key);

/**
 * CA THẬT ("KT.dwg", 221 cửa): engine báo **658 m² cửa** vì `qty = tổng diện tích bbox
 * MẶT BẰNG`. Bbox cửa trên mặt bằng là *bề rộng × cung quét cánh* (vệt sàn) — hoặc
 * *bề rộng × bề dày tường* khi cửa vẽ dạng khối — không bao giờ là diện tích cánh cửa.
 * Đo thật đủ bác bỏ mọi công thức suy m²/bề rộng từ bbox: chỉ 27% cửa có bbox vuông,
 * chỉ 10% có cạnh nhỏ trong dải 0,6–1,2m. m² cửa = rộng × cao, mà **mặt bằng không có
 * chiều cao** ⇒ chỉ báo thứ bảo vệ được: SỐ LƯỢNG.
 */
describe('Cửa / cửa sổ — đếm CÁI, không bịa m² từ mặt bằng', () => {
  const doors = Array.from({ length: 5 }, (_, i) => o('door', 900, 900, i));

  it('cửa đi → đơn vị "cái", số lượng = số cửa (KHÔNG phải m²)', () => {
    const r = rowOf(doors, 'door')!;
    expect(r.unit).toBe('cái');
    expect(r.quantity).toBe(5);
  });

  it('cửa sổ → cũng đếm "cái" (bbox mặt bằng = rộng × BỀ DÀY TƯỜNG, vô nghĩa)', () => {
    const r = rowOf(Array.from({ length: 3 }, (_, i) => o('window', 1200, 220, i)), 'window')!;
    expect(r.unit).toBe('cái');
    expect(r.quantity).toBe(3);
  });

  it('note nói RÕ vì sao trống m² và cần gì để có — không im lặng', () => {
    expect(rowOf(doors, 'door')!.note).toMatch(/bảng thống kê cửa/);
    expect(rowOf(doors, 'door')!.note).toMatch(/không suy m²/);
  });

  /**
   * Chống hồi quy về công thức cũ: 5 cửa 900×900mm = 0,81 m² mỗi cái → tổng 4,05 m².
   * Đổi lại `qty = t.area` thì quantity thành 4.05 thay vì 5.
   */
  it('KHÔNG bao giờ trả tổng diện tích bbox (4.05 m² cho 5 cửa 900×900)', () => {
    const r = rowOf(doors, 'door')!;
    expect(r.quantity).not.toBeCloseTo(4.05, 2);
    expect(Number.isInteger(r.quantity)).toBe(true); // đếm cái → luôn nguyên
  });
});

/**
 * ⚠ BÀI HỌC ĐÃ TRẢ GIÁ (chính lượt này): tôi thêm ngưỡng `MIN_OPENING_M = 0.3` cho cửa,
 * tưởng loại được ký hiệu. Số liệu thật bác bỏ: 67/221 "cửa" có cạnh nhỏ < 0,3m nhưng là
 * **cửa THẬT vẽ mỏng** (`1050×200`, `800×200`, `1500×200`, `200×900` mm — 200mm là bề dày
 * tường). Ngưỡng đó xoá cửa thật. Test này khoá để không ai thêm lại.
 */
describe('KHÔNG áp ngưỡng cạnh nhỏ cho cửa — cửa vẽ mỏng là cửa THẬT', () => {
  it('cửa 1050×200mm (vẽ cắt ngang tường dày 200) → PHẢI được đếm', () => {
    expect(isRealSection(o('door', 1050, 200), 0.001)).toBe(true);
  });

  it('cửa 200×900mm (xoay 90°) → PHẢI được đếm', () => {
    expect(isRealSection(o('door', 200, 900), 0.001)).toBe(true);
  });

  it('cửa sổ 1200×220mm → PHẢI được đếm', () => {
    expect(isRealSection(o('window', 1200, 220), 0.001)).toBe(true);
  });

  it('4 cửa vẽ mỏng → đếm đủ 4, không bị ngưỡng nuốt', () => {
    const thin = [o('door', 1050, 200, 0), o('door', 800, 200, 1), o('door', 1500, 200, 2), o('door', 200, 600, 3)];
    expect(rowOf(thin, 'door')!.quantity).toBe(4);
  });

  it('cột/dầm VẪN giữ ngưỡng tiết diện 0,08m (chúng là mặt cắt — khác hẳn cửa)', () => {
    expect(isRealSection(o('column', 100, 100), 0.001)).toBe(true);
    expect(isRealSection(o('column', 40, 40), 0.001)).toBe(false);
    expect(isRealSection(o('beam', 40, 40), 0.001)).toBe(false);
  });

  it('type không thuộc SECTION_TYPES → không bị chặn', () => {
    expect(isRealSection(o('wall', 100, 100), 0.001)).toBe(true);
    expect(isRealSection(o('hatch', 10, 10), 0.001)).toBe(true);
  });
});
