import { NORM_FAMILIES, TakeoffRowKey } from './takeoff-engine.service';

/**
 * `UnitPriceService.search()` phân nhánh theo CHÍNH regex này (unit-price.service.ts:163):
 * khớp → lọc `code` theo prefix; KHÔNG khớp → rơi sang `$text` theo TÊN.
 */
const CODE_PREFIX_RX = /^[A-Z]{2}\.\d/i;

describe('NORM_FAMILIES — họ mã định mức TT12/2021 (tra từ sách thật)', () => {
  /**
   * CẠM BẪY THẬT, âm thầm: prefix sai định dạng (vd "AF122" thiếu chấm) → `search()`
   * KHÔNG báo lỗi mà lặng lẽ rơi sang `$text` theo tên → gợi ý rác. Đã đo trên chính
   * 4305 dòng đơn giá Hà Nội: "bê tông cột" → "cọc tiêu bê tông cốt thép, cột km".
   */
  it('mọi prefix phải khớp regex prefix của search() — nếu không sẽ ÂM THẦM rơi về $text', () => {
    for (const [key, fam] of Object.entries(NORM_FAMILIES)) {
      for (const p of fam!.prefixes) {
        expect({ key, p, ok: CODE_PREFIX_RX.test(p) }).toEqual({ key, p, ok: true });
      }
    }
  });

  it('KHÔNG map rowKey → 1 mã: mỗi công tác chỉ nêu HỌ + thông số cần QS chốt', () => {
    for (const fam of Object.values(NORM_FAMILIES)) {
      expect(fam!.prefixes.length).toBeGreaterThan(0);
      // `spec` là thứ QS phải quyết (mác bê tông, mác vữa…) — không có nó thì họ mã vô nghĩa.
      expect(fam!.spec.trim().length).toBeGreaterThan(0);
    }
  });

  /** Mã đầy đủ (vd "AF.12213") sẽ ghim đúng 1 biến thể = ĐOÁN mác bê tông. Prefix phải NGẮN hơn. */
  it('prefix là HỌ chứ không phải mã đầy đủ (AF.122 chứ không phải AF.12213)', () => {
    for (const fam of Object.values(NORM_FAMILIES)) {
      for (const p of fam!.prefixes) {
        const digits = p.split('.')[1] ?? '';
        expect(digits.length).toBeLessThan(5);
      }
    }
  });

  /**
   * Cửa sổ & trần thạch cao KHÔNG có trong Phụ lục Phần Xây dựng TT12/2021 (đã tra 7490
   * mã: "trần thạch cao" = 0 kết quả; "cửa sổ" chỉ ra AG.114 = bê tông cửa sổ TRỜI).
   * Bảng cũ vẫn bịa `AH.12110`/`AK.64110` cho chúng → khoá lại để không tái diễn.
   */
  it('window/ceiling KHÔNG có trong Phần Xây dựng → để trống, không bịa', () => {
    expect(NORM_FAMILIES.window).toBeUndefined();
    expect(NORM_FAMILIES.ceiling).toBeUndefined();
  });

  it('các họ đã tra được đều có mặt', () => {
    const must: TakeoffRowKey[] = [
      'wall_volume', 'wall_area', 'column_concrete', 'beam_concrete',
      'slab', 'footing_concrete', 'floor_screed', 'floor_finish', 'skirting',
    ];
    for (const k of must) expect(NORM_FAMILIES[k]).toBeDefined();
  });
});
