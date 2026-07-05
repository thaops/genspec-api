// Bộ môn bản vẽ (discipline) — hằng số + auto-detect từ tên file.
// Pure, không phụ thuộc engine takeoff. GĐ2 sẽ dùng để định tuyến bóc tách.

export type Discipline = 'KT' | 'KC' | 'DIEN' | 'NUOC' | 'KHAC';

export const DISCIPLINES: { code: Discipline; label: string }[] = [
  { code: 'KT', label: 'Kiến trúc' },
  { code: 'KC', label: 'Kết cấu' },
  { code: 'DIEN', label: 'Điện' },
  { code: 'NUOC', label: 'Nước' },
  { code: 'KHAC', label: 'Khác' },
];

export const DISCIPLINE_CODES: Discipline[] = DISCIPLINES.map((d) => d.code);

export function isDiscipline(v: unknown): v is Discipline {
  return typeof v === 'string' && (DISCIPLINE_CODES as string[]).includes(v);
}

/**
 * Đoán bộ môn từ tên file bản vẽ. Thứ tự ưu tiên: KT → KC → DIEN → NUOC → KHAC.
 * Pure — có thể test độc lập.
 */
export function detectDiscipline(filename: string): Discipline {
  const name = filename ?? '';
  if (/\bKT\b|kien.?truc|architect/i.test(name)) return 'KT';
  if (/\bKC\b|ket.?cau|structur/i.test(name)) return 'KC';
  if (/\bDIEN\b|\bDN\b|dien|electric/i.test(name)) return 'DIEN';
  if (/\b(CTN|CN|N)\b|nuoc|cap.?thoat|plumb|water/i.test(name)) return 'NUOC';
  return 'KHAC';
}
