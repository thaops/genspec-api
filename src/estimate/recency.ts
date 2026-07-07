// Recency engine — một QS senior luôn ưu tiên nguồn MỚI hơn khi hai nguồn mâu
// thuẫn. Ở đây độ tin cậy = độ tin theo LOẠI (source.ts) ± điều chỉnh theo TUỔI
// nguồn. Tách thành module thuần (không Mongo/AI) để test & tái dùng.

/** Parse ngày/quý phát hành từ source.date đa định dạng VN → Date (đầu kỳ). undefined nếu không hiểu. */
export function parseSourceDate(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;

  // Quý: "Q2/2026", "quý 2 2026", "quý 2/2026"
  const q = s.match(/q(?:uý)?\s*([1-4])\s*[\/\-. ]\s*(\d{4})/i);
  if (q) {
    const quarter = Number(q[1]);
    return new Date(Number(q[2]), (quarter - 1) * 3, 1);
  }
  // ISO: 2026-06-22 hoặc 2026-06
  const iso = s.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3] ?? 1));
  // DD/MM/YYYY hoặc MM/YYYY
  const dmy = s.match(/(?:(\d{1,2})[\/\-.])?(\d{1,2})[\/\-.](\d{4})/);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1] ?? 1));
  // Chỉ năm: "2026"
  const y = s.match(/\b(19|20)\d{2}\b/);
  if (y) return new Date(Number(y[0]), 0, 1);
  return undefined;
}

/** Số tháng tính từ `date` tới `now` (âm nếu date ở tương lai). */
export function monthsSince(date: Date, now: Date): number {
  return (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
}

/**
 * Điều chỉnh độ tin cậy theo tuổi nguồn (điểm cộng/trừ vào reliability của LOẠI).
 * Không xác định được ngày → 0 (không phạt oan). Nguồn càng cũ càng trừ nặng —
 * một công bố giá 2018 dù là "government" cũng không đáng tin bằng báo giá 2026.
 */
export function recencyDelta(dateRaw?: string, now: Date = new Date()): number {
  const d = parseSourceDate(dateRaw);
  if (!d) return 0;
  const m = monthsSince(d, now);
  if (m <= 6) return 4;
  if (m <= 12) return 1;
  if (m <= 24) return -4;
  if (m <= 36) return -8;
  if (m <= 60) return -12;
  return -18;
}

/** Độ "tươi" 0–100 để hiển thị (100 = vừa phát hành, giảm dần theo tháng). */
export function freshnessScore(dateRaw?: string, now: Date = new Date()): number | undefined {
  const d = parseSourceDate(dateRaw);
  if (!d) return undefined;
  const m = Math.max(0, monthsSince(d, now));
  return Math.max(0, Math.round(100 - m * 2)); // -2 điểm/tháng
}

/** Năm hiện hành — nhồi vào query web để không cứng "năm 2025". */
export function currentYear(now: Date = new Date()): number {
  return now.getFullYear();
}

/** Nhãn quý gần nhất, vd "Quý 3/2026" — dùng cho query giá "quý gần nhất". */
export function latestQuarterLabel(now: Date = new Date()): string {
  return `Quý ${Math.floor(now.getMonth() / 3) + 1}/${now.getFullYear()}`;
}
