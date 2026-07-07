// Một NGUỒN SỰ THẬT cho mã hiệu định mức VN — trước đây mỗi chỗ tự viết regex
// lệch nhau (web-lookup ^[A-Z]{2}\.\d{4,5} vs referenceBlock [A-Za-z]{2,3}[.\-]?\d{4,}),
// khiến mã tìm được ở nơi này không khớp được ở nơi kia. PURE — không Mongo/AI.
//
// Chuẩn công nhận: 2–3 CHỮ HOA + dấu chấm + 4–6 CHỮ SỐ + hậu tố 1 chữ thường tuỳ chọn.
//   Hợp lệ: AF.61120, AK.2111, SAA.1234, AB.11411a
// Bao trùm mọi biến thể thực tế (TT12/2021 dùng 2 chữ; một số hệ 3 chữ; parser
// PDF/Excel dùng 4–6 số) để mã đi qua mọi tầng đều nhất quán.

/** Lõi pattern (không anchor) — để nhúng vào regex khác qua `.source`. */
export const NORM_CODE_CORE = '[A-Z]{2,3}\\.\\d{4,6}[a-z]?';

/** Khớp TOÀN CHUỖI (validate 1 mã đã tách). */
export const NORM_CODE_RE = new RegExp(`^${NORM_CODE_CORE}$`);

/** Trích mã từ văn bản tự do (global) — cho phép khoảng trắng/gạch quanh dấu chấm. */
export const NORM_CODE_GLOBAL_RE = /\b[A-Za-z]{2,3}\s*[.\-]\s*\d{4,6}[a-z]?\b/g;

/** Chuẩn hoá 1 mã: hoa hoá, bỏ khoảng trắng quanh dấu, đổi '-' → '.'. */
export function normalizeNormCode(raw: string): string {
  return (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s*[-.]\s*/, '.')
    .replace(/([a-z])$/i, (m) => m.toLowerCase());
}

/** Mã hợp lệ theo chuẩn (sau khi chuẩn hoá). */
export function isNormCode(s: string): boolean {
  return NORM_CODE_RE.test(normalizeNormCode(s));
}

/** Trích tất cả mã (đã chuẩn hoá, unique) xuất hiện trong text. */
export function extractNormCodes(text: string): string[] {
  const hits = (text ?? '').match(NORM_CODE_GLOBAL_RE) ?? [];
  const norm = hits.map(normalizeNormCode).filter(isNormCode);
  return Array.from(new Set(norm));
}

/**
 * Mã có xuất hiện NGUYÊN VĂN trong text grounded không — chấp nhận biến thể
 * hoa/thường + khoảng trắng quanh dấu chấm ("AE. 62210"). Vẫn là chuỗi trong
 * text, KHÔNG phải kiến thức model (rào chống bịa). PURE.
 */
export function literalCodeInText(code: string, text: string): boolean {
  if (!code || !text) return false;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\.\\s*');
  return new RegExp(escaped, 'i').test(text);
}
