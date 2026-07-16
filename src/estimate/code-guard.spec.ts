import { nameMatchScore } from './markdown-table-actions';

/**
 * RÀO MÃ — dùng ĐÚNG 5 ca đo được trên production (bộ Đơn giá Hà Nội 4305 dòng).
 *
 * `verifyCodeInBook` là method private của TakeoffEngineService (cần Mongo), nên test
 * ở đây khoá phần QUYẾT ĐỊNH thuần của nó: ngưỡng `nameMatchScore > 0`. Nếu ngưỡng
 * này sai thì rào sập, bất kể phần Mongo đúng hay không.
 */
describe('Rào mã: tên phải khớp nghĩa — tồn tại trong sách là CHƯA ĐỦ', () => {
  const PASS = (expected: string, actual: string) => nameMatchScore(expected, actual) > 0;

  it('CA THẬT AK.57110: engine gọi "Ốp/len chân tường", sách ghi "Bó vỉa hè" → LOẠI', () => {
    // Trước rào: hiện "Ốp/len chân tường — 74.248đ — TT 13/2021" = giá thật của công tác KHÁC.
    expect(PASS('Ốp/len chân tường', 'Bó vỉa hè, đường bằng tấm bê tông đúc sẵn')).toBe(false);
  });

  it('CA THẬT AK.98110: "Cán nền vữa xi măng" vs "Loại đá có đường kính Dmax ≤ 4" → LOẠI', () => {
    expect(PASS('Lớp cán nền (vữa lót)', 'Loại đá có đường kính - Dmax ≤ 4')).toBe(false);
  });

  it('CA ĐÚNG: "Ván khuôn cột" vs "VÁN KHUÔN CỘT Ván khuôn cột vuông, chữ nhật" → GIỮ', () => {
    expect(PASS('Ván khuôn cột', 'VÁN KHUÔN CỘT Ván khuôn cột vuông, chữ nhật')).toBe(true);
  });

  it('thận trọng: khớp mơ hồ cũng LOẠI (thà thiếu còn hơn sai) — QS chọn từ ứng viên', () => {
    // "Lát nền" vs "LÁT GẠCH CHỈ": có thể đúng, nhưng không đủ chắc → không tự gán.
    expect(PASS('Lát nền (chưa xác định vật liệu)', 'LÁT GẠCH CHỈ, GẠCH THẺ Lát gạch chỉ, vỉa hè')).toBe(false);
    expect(PASS('Trần (chưa xác định loại)', 'Chuẩn bị, lắp đặt khung xương. Gắn tấm thạch cao')).toBe(false);
  });

  it('không phân biệt HOA/thường và dấu tiếng Việt (sách ghi hoa, engine ghi thường)', () => {
    expect(PASS('Bê tông cột', 'BÊ TÔNG CỘT đá 1x2 mác 250')).toBe(true);
  });

  it('tên rỗng → LOẠI, không crash', () => {
    expect(PASS('', 'Bó vỉa hè')).toBe(false);
    expect(PASS('Ốp/len chân tường', '')).toBe(false);
  });
});
