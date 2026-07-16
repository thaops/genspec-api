import { repairLayerMojibake, normalizeLayerName } from './layer-name';

/**
 * CA THẬT (4 bản "THỰC HÀNH 2", đo trên production): libredwg trả tên layer là **bytes
 * UTF-8 bị decode thành CP1252** (byte không có trong CP1252 giữ ở lone surrogate U+DCxx).
 * Hệ quả: luật layer tìm "tường"/"cấp" KHÔNG BAO GIỜ khớp → hàng nghìn entity rơi vào
 * `polyline` chưa phân loại → BOQ mỏng (NUOC chỉ nhận 13/7321 object = 0,2%).
 */
describe('repairLayerMojibake — tên layer tiếng Việt bị méo', () => {
  it('CA THẬT: "N - Cáº¤P" → "N - CẤP" (nước cấp)', () => {
    expect(repairLayerMojibake('N - Cáº¤P')).toBe('N - CẤP');
  });

  it('CA THẬT: byte lạ giữ ở lone surrogate → vẫn khôi phục ĐÚNG', () => {
    // "Tường": byte 0x9D không có trong CP1252 → decoder giữ ở U+DC9D, KHÔNG mất.
    expect(repairLayerMojibake('5- Cáº¯t tÆ°á»\udc9dng')).toBe('5- Cắt tường');
    expect(repairLayerMojibake('3- TÆ°á»\udc9dng bao máº·t Ä‘á»©ng')).toBe('3- Tường bao mặt đứng');
  });

  it('CA THẬT: ký tự CP1252 vùng 0x80–0x9F (Ã”=0x94) cũng đảo được', () => {
    expect(repairLayerMojibake('Ã”NG Cáº¤P')).toBe('ÔNG CẤP');
    expect(repairLayerMojibake('NÃ©t Ä‘á»©t')).toBe('Nét đứt');
  });

  it('layer ASCII bình thường → GIỮ NGUYÊN (không phá)', () => {
    for (const l of ['0', 'DIEN', 'NET CHINH', 'A-WALL', 'KC-COT-500', 'e-thietbi', 'dientich']) {
      expect(repairLayerMojibake(l)).toBe(l);
    }
  });

  it('layer tiếng Việt ĐÃ ĐÚNG → giữ nguyên, không sửa 2 lần', () => {
    expect(repairLayerMojibake('Cắt tường')).toBe('Cắt tường');
    expect(repairLayerMojibake('ỐNG CẤP')).toBe('ỐNG CẤP');
  });

  it('chuỗi Latin-1 THẬT (không phải mojibake) → giữ nguyên', () => {
    // "Café": byte 0xE9 đứng một mình KHÔNG hợp lệ UTF-8 → phải trả nguyên.
    expect(repairLayerMojibake('Café')).toBe('Café');
  });

  it('rỗng/không có → không nổ', () => {
    expect(repairLayerMojibake('')).toBe('');
    expect(repairLayerMojibake(undefined as unknown as string)).toBe('');
  });

  /** Đây mới là thứ quyết định: sau sửa, luật layer tìm "TUONG" phải khớp được. */
  it('normalizeLayerName: layer méo → chuẩn hoá ra token khớp được luật', () => {
    expect(normalizeLayerName('5- Cáº¯t tÆ°á»\udc9dng')).toBe('5- CAT TUONG');
    expect(normalizeLayerName('3- TÆ°á»\udc9dng bao máº·t Ä‘á»©ng')).toBe('3- TUONG BAO MAT DUNG');
    expect(normalizeLayerName('N - Cáº¤P')).toBe('N - CAP');
  });

  it('normalizeLayerName vẫn chạy đúng với layer KHÔNG méo (không hồi quy)', () => {
    expect(normalizeLayerName('Cắt tường')).toBe('CAT TUONG');
    expect(normalizeLayerName('KC-COT-500')).toBe('KC-COT-500');
  });
});

/**
 * Tier 1c — cụm từ tiếng Việt có dấu cách. Đo thật bản NUOC: chỉ nhận 13/7321 entity
 * (0,2%) vì layer tên "ỐNG CẤP"/"CẤP THOÁT NƯỚC" không khớp key 1-từ của LAYER_TYPE_MAP.
 */
describe('PHRASE_TYPE_RULES — cụm từ nước, KHÔNG đoán khi mập mờ', () => {
  // Lấy đúng bảng luật trong service để test không lệch khỏi code thật.
  const src = require('fs').readFileSync('src/drawing/services/drawing-detector.service.ts', 'utf8');
  const block = src.slice(src.indexOf('const PHRASE_TYPE_RULES'), src.indexOf('];', src.indexOf('const PHRASE_TYPE_RULES')));
  const RULES: Array<{ phrase: string; type: string }> = [...block.matchAll(/phrase: '([^']+)', type: '([^']+)'/g)]
    .map((m: any) => ({ phrase: m[1], type: m[2] }));
  const hit = (raw: string) => RULES.find((r) => normalizeLayerName(raw).includes(r.phrase))?.type;

  it('layer nước THẬT (đã méo) → nhận ra pipe', () => {
    expect(hit('Ã”NG Cáº¤P')).toBe('pipe');        // "ỐNG CẤP"
    expect(hit('cap thoat nuoc')).toBe('pipe');
    expect(hit('Ã”NG THOAT MÆ¯A')).toBe('pipe');  // "ỐNG THOAT MƯA"
  });

  it('⚠ KHÔNG đoán "CẤP" đứng một mình — bản nước là "cấp", bản điện là "cáp"', () => {
    expect(hit('N - Cáº¤P')).toBeUndefined(); // "N - CẤP" — gần chắc là nước nhưng KHÔNG đoán
    expect(hit('MANG CAP')).toBeUndefined(); // máng cáp (điện) — không được thành ống nước
  });

  it('layer điện/kết cấu KHÔNG bị nhận nhầm thành ống nước', () => {
    for (const l of ['DIEN', 'e-thietbi', 'NET CHINH', 'KC-COT-500', 'CHU-250', '1ChongSet']) {
      expect(hit(l)).toBeUndefined();
    }
  });
});
