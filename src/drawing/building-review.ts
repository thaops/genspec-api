/**
 * AI Review — rà soát THIẾU PHẠM VI (scope-gap) trên Building Graph.
 *
 * PURE. Sau khi bóc xong, KHÔNG tạo BOQ nữa mà REVIEW: chỉ ra cái QS dễ bỏ sót
 * ("WC thiếu lavabo", "tầng 2 không ổ cắm", "có TBVS nhưng chưa thấy tuyến ống").
 * Human-in-the-loop: chỉ CẢNH BÁO để kỹ sư xác nhận, KHÔNG tự thêm/sửa số.
 *
 * Hai tầng rule:
 *   - Floor-level: chạy được NGAY (chỉ cần typeCounts theo tầng)
 *   - Room-level : cần object type='room' (S3b) → tự kích hoạt khi có room
 */
import { assembleBuilding, perFloorTypeCounts, GraphObject } from './building-graph';

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  category: 'missing_scope' | 'consistency';
  code: string;
  scope: string;   // tên phòng / "Tầng X"
  message: string;
  suggestion?: string;
}

/** Phân loại phòng từ tên: phòng ướt (WC/tắm) cần TBVS + thoát sàn. */
const WET_ROOM = /wc|vệ sinh|ve sinh|toilet|nhà tắm|nha tam|\bbath|restroom|lavabo|tắm|tam\b/i;
/** Phòng kỹ thuật/phụ — không kỳ vọng ổ cắm/đèn như phòng ở. */
const UTILITY_ROOM = /kỹ thuật|ky thuat|kho|shaft|hộp|hop gen|gen\b|technical|đổ rác|do rac|thang máy|thang may/i;

function has(counts: Record<string, number>, type: string): boolean {
  return (counts[type] ?? 0) > 0;
}

/** Rà soát room-level (cần room). Rỗng nếu chưa detect room. */
function reviewRooms(objects: GraphObject[]): ReviewFinding[] {
  const building = assembleBuilding(objects);
  const out: ReviewFinding[] = [];
  for (const f of building.floors) {
    for (const r of f.rooms) {
      const c = r.typeCounts;
      const wet = WET_ROOM.test(r.name);
      const utility = UTILITY_ROOM.test(r.name);
      if (wet) {
        if (!has(c, 'sanitary')) out.push({ severity: 'high', category: 'missing_scope', code: 'wc_no_sanitary', scope: r.name, message: `Phòng vệ sinh "${r.name}" chưa có thiết bị vệ sinh (lavabo/bồn cầu…)`, suggestion: 'Kiểm tra bản MEP nước hoặc bổ sung TBVS' });
        if (!has(c, 'floor_drain')) out.push({ severity: 'medium', category: 'missing_scope', code: 'wc_no_drain', scope: r.name, message: `Phòng vệ sinh "${r.name}" chưa có thoát sàn/hố ga`, suggestion: 'Kiểm tra layer thoát nước' });
      }
      if (!has(c, 'light')) out.push({ severity: 'medium', category: 'missing_scope', code: 'room_no_light', scope: r.name, message: `Phòng "${r.name}" chưa có đèn`, suggestion: 'Kiểm tra bản điện chiếu sáng' });
      if (!wet && !utility && !has(c, 'socket')) out.push({ severity: 'low', category: 'missing_scope', code: 'room_no_socket', scope: r.name, message: `Phòng "${r.name}" chưa có ổ cắm`, suggestion: 'Kiểm tra bản điện ổ cắm' });
    }
  }
  return out;
}

/** Rà soát floor-level (chạy ngay, chỉ cần typeCounts). */
function reviewFloors(objects: GraphObject[]): ReviewFinding[] {
  const perFloor = perFloorTypeCounts(objects);
  const out: ReviewFinding[] = [];
  for (const [floor, c] of Object.entries(perFloor)) {
    const label = floor.startsWith('(') ? floor : `Tầng ${floor}`;
    // Có thiết bị vệ sinh nhưng không thấy tuyến ống nước
    if (has(c, 'sanitary') && !has(c, 'pipe')) out.push({ severity: 'medium', category: 'consistency', code: 'sanitary_no_pipe', scope: label, message: `${label}: có thiết bị vệ sinh nhưng chưa thấy tuyến ống nước`, suggestion: 'Kiểm tra layer cấp/thoát nước' });
    // Có đèn/ổ cắm nhưng không thấy tủ điện
    if ((has(c, 'light') || has(c, 'socket')) && !has(c, 'electric_panel')) out.push({ severity: 'low', category: 'consistency', code: 'load_no_panel', scope: label, message: `${label}: có đèn/ổ cắm nhưng chưa thấy tủ điện`, suggestion: 'Kiểm tra layer tủ điện (DB/MDB)' });
    // Có đèn nhưng không có công tắc
    if (has(c, 'light') && !has(c, 'switch')) out.push({ severity: 'low', category: 'consistency', code: 'light_no_switch', scope: label, message: `${label}: có đèn nhưng chưa thấy công tắc`, suggestion: 'Kiểm tra layer công tắc' });
  }
  return out;
}

/** Rà soát toàn bộ. severity cao trước. PURE. */
export function reviewBuilding(objects: GraphObject[]): ReviewFinding[] {
  const rank: Record<ReviewFinding['severity'], number> = { high: 0, medium: 1, low: 2 };
  return [...reviewRooms(objects), ...reviewFloors(objects)].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
