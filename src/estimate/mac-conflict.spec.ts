import { extractMac, macConflict } from './takeoff-engine.service';

/**
 * CA THẬT (đo trên production sau khi nạp 191 mã TT12): CÙNG mã `AF.12213` —
 * định mức ghi **M250** (xi măng 308,525 kg, khớp chuẩn ngành), đơn giá Hà Nội ghi
 * **Mác 200**. Lệch đúng 1 bậc trên cả họ AF.122. Không có văn bản gốc BXD thì không
 * phân xử được ai đúng ⇒ engine PHÁT HIỆN rồi báo, KHÔNG chọn bên nào và không tính
 * tiền từ hao phí lệch (nối bừa = sai cấp phối kèm dấu "TT12/2021" trông rất thật).
 */
describe('extractMac — hai nguồn viết mác khác nhau', () => {
  it('định mức viết "M250"', () => {
    expect(extractMac('Bê tông cột SX bằng máy trộn, TD ≤0,1m2, chiều cao ≤6m, M250, đá 1x2, PCB40')).toBe(250);
  });

  it('đơn giá tỉnh viết "Mác 200"', () => {
    expect(extractMac('Tiết diện cột ≤ 0,1m2, cao ≤6m - Mác 200')).toBe(200);
  });

  it('vữa: "Vữa XM mác 75" và "vữa XM M75" đều ra 75', () => {
    expect(extractMac('Chiều dày ≤11cm, cao ≤6m - Vữa XM mác 75')).toBe(75);
    expect(extractMac('Xây tường thẳng - Chiều dày ≤11cm, vữa XM M75, PCB40')).toBe(75);
  });

  it('không có mác → null (không bịa)', () => {
    expect(extractMac('Ván khuôn cột vuông, chữ nhật - Chiều cao ≤28m')).toBeNull();
    expect(extractMac('')).toBeNull();
  });

  /** "PCB40" là loại xi măng, KHÔNG phải mác bê tông — không được nhặt nhầm. */
  it('KHÔNG nhặt nhầm PCB40 / đá 1x2 thành mác', () => {
    expect(extractMac('đá 1x2, PCB40')).toBeNull();
  });
});

describe('macConflict — phát hiện, KHÔNG tự chọn bên nào', () => {
  const NORM_12213 = 'Bê tông cột SX bằng máy trộn, đổ bằng thủ công, TD ≤0,1m2, chiều cao ≤6m, M250, đá 1x2, PCB40';
  const PRICE_12213 = 'Tiết diện cột ≤ 0,1m2, cao ≤6m - Mác 200';

  it('CA THẬT AF.12213: M250 vs Mác 200 → BÁO xung đột', () => {
    expect(macConflict(NORM_12213, PRICE_12213)).toEqual({ normMac: 250, priceMac: 200 });
  });

  it('khớp mác → không xung đột (cho phép lập phân tích đơn giá)', () => {
    expect(macConflict('… M200, đá 1x2', 'Tiết diện cột ≤ 0,1m2 - Mác 200')).toBeNull();
  });

  it('một bên KHÔNG có mác → không kết luận xung đột (không bịa mâu thuẫn)', () => {
    expect(macConflict('Ván khuôn cột, chiều cao ≤28m', 'Ván khuôn cột vuông - cao ≤28m')).toBeNull();
    expect(macConflict('… M250 …', 'Ván khuôn cột')).toBeNull();
  });

  it('cả họ AF.122 lệch 1 bậc — mỗi mã đều bị bắt', () => {
    const pairs: Array<[string, string, number, number]> = [
      ['… M200, đá 1x2', '… - Mác 150', 200, 150],
      ['… M250, đá 1x2', '… - Mác 200', 250, 200],
      ['… M300, đá 1x2', '… - Mác 250', 300, 250],
    ];
    for (const [n, p, nm, pm] of pairs) {
      expect(macConflict(n, p)).toEqual({ normMac: nm, priceMac: pm });
    }
  });
});
