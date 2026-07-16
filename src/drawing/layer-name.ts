/**
 * Chuẩn hoá TÊN LAYER trước khi so khớp. PURE, không phụ thuộc module nào —
 * đặt riêng để cả `discipline.ts` lẫn `services/drawing-detector.service.ts` dùng
 * chung mà KHÔNG tạo vòng import (detector → takeoff-engine → discipline).
 *
 * BUG ĐÃ XÁC NHẬN (file thật "F550-BENH XA LD"): file CAD Việt Nam đặt tên layer
 * CÓ DẤU ("5- Cắt tường" 445 entity, "3- Tường bao mặt đứng" 228, "Lưới trục" 134).
 * Trước đây so khớp trên chuỗi THÔ đã upper-case:
 *   - `LAYER_TYPE_MAP`: "5- CẮT TƯỜNG" không bao giờ === / startsWith / endsWith "TUONG".
 *   - Tokenizer `[^A-Z0-9]+`: ắ/ư/ờ KHÔNG thuộc [A-Z] ASCII → bị coi là DẤU PHÂN CÁCH
 *     → "CẮT TƯỜNG" vỡ thành ["C","T","T","NG"] (rác).
 * Hệ quả: toàn bộ layer tiếng Việt có dấu vô hình với detection theo layer.
 *
 * Dùng đúng phép chuẩn hoá NFD đã có sẵn trong repo (`mep-takeoff.ts` normalizeName,
 * `markdown-table-actions.ts` normalize) — không phát minh kiểu mới.
 */
/**
 * CP1252 0x80–0x9F → codepoint (ngoài dải này CP1252 ≡ Latin-1). 5 byte 0x81/0x8D/0x8F/
 * 0x90/0x9D KHÔNG có trong CP1252 → decoder giữ chúng ở lone surrogate U+DCxx.
 */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * SỬA MOJIBAKE tên layer. BUG THẬT (đo trên 4 bản "THỰC HÀNH 2"): libredwg trả tên layer
 * là **bytes UTF-8 bị decode thành CP1252** (byte lạ giữ ở lone surrogate U+DCxx):
 *   `N - Cáº¤P` = "N - CẤP" · `5- Cáº¯t tÆ°á»<U+DC9D>ng` = "5- Cắt tường" · `Ã”NG Cáº¤P` = "ỐNG CẤP"
 *
 * Hệ quả: luật layer tìm "tường"/"cấp"/"ống" KHÔNG BAO GIỜ khớp → hàng nghìn entity rơi
 * vào `polyline` chưa phân loại → BOQ mỏng. Đo thật: NUOC chỉ nhận 13/7321 object (0,2%),
 * bản kiến trúc nhận 18 tường trong khi 551 polyline nằm trên layer "Cắt tường"/"Tường bao".
 * `normalizeLayerName` (NFD) KHÔNG cứu được vì chuỗi đã méo trước khi tới nó.
 *
 * Đảo đúng cặp decoder gốc: encode CP1252 (+ surrogate → byte) rồi decode UTF-8.
 * AN TOÀN: chuỗi không phải mojibake sẽ (a) chứa ký tự ngoài CP1252 → trả nguyên, hoặc
 * (b) ra byte không hợp lệ UTF-8 → trả nguyên. Đo thật: sửa 17/17 layer méo (3398 object),
 * 0/197 layer bình thường bị đụng. PURE.
 */
export function repairLayerMojibake(layer: string): string {
  const s = layer ?? '';
  if (!s) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xdc80 && cp <= 0xdcff) bytes.push(cp - 0xdc00); // surrogateescape → byte gốc
    else if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) bytes.push(cp); // ASCII + Latin-1 trên
    else {
      const b = CP1252_HIGH[cp];
      if (b === undefined) return s; // ký tự ngoài CP1252 (vd 'ư' đã đúng) → không phải mojibake
      bytes.push(b);
    }
  }
  const out = Buffer.from(bytes).toString('utf8');
  return out.includes('�') ? s : out; // không phải UTF-8 hợp lệ → giữ nguyên
}

export function normalizeLayerName(layer: string): string {
  return repairLayerMojibake(layer ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // dấu thanh + dấu mũ (combining marks)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase();
}
