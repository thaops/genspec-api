import { normalizeLayerName } from './layer-name';
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

const KC_LAYER_TOKEN_RE = /^(?:NET|LINE|TT|KC|KCC|BTCT|BT|BE|TONG|S)?(?:COT|COL|DAM|GIANG|BEAM|MONG|FOOTING|FOUND|COC|PILE|THEP|REBAR|KETCAU)\d*$/;
const KT_LAYER_TOKEN_RE = /^(?:TUONG|WALL|CUA|DOOR|CUASO|WINDOW|NEN|FLOOR|HOANTHIEN|FINISH|TRAN|CEILING)\d*$/;

/**
 * Fallback: đoán bộ môn từ TÊN LAYER khi filename không theo quy ước (trả 'KHAC').
 * Không đè lên tín hiệu filename rõ ràng — chỉ dùng khi filename mơ hồ. Đếm token
 * khớp KC vs KT trên mọi layer; đa số thắng, hoà/0 vẫn 'KHAC' — thà thiếu còn hơn
 * đoán sai bộ môn (routing checklist/CHECKLIST_QS phụ thuộc giá trị này).
 */
export function detectDisciplineFromLayers(layers: string[]): Discipline {
  let kc = 0;
  let kt = 0;
  for (const layer of layers ?? []) {
    // Bỏ dấu trước khi tokenize — nếu không, layer tiếng Việt có dấu ("Tường bao
    // mặt đứng") bị [^A-Z0-9] cắt vụn thành rác và không khớp token nào.
    const tokens = normalizeLayerName(layer).split(/[^A-Z0-9]+/).filter(Boolean);
    for (const t of tokens) {
      if (KC_LAYER_TOKEN_RE.test(t)) kc++;
      else if (KT_LAYER_TOKEN_RE.test(t)) kt++;
    }
  }
  if (kc === 0 && kt === 0) return 'KHAC';
  return kc > kt ? 'KC' : kt > kc ? 'KT' : 'KHAC';
}
