/**
 * Phân loại type MEP theo CÁCH ĐO. PURE, không import gì — đặt riêng để phá vòng
 * import: `drawing-detector.service` đã import `MIN_SECTION_M/SECTION_TYPES` từ
 * `estimate/takeoff-engine.service`, nên nếu takeoff-engine import ngược 2 Set này
 * từ detector thì thành vòng → lúc chạy thật `MEP_COUNT_TYPES` là `undefined`
 * ("not iterable"). tsc và SWC ĐỀU không bắt được — chỉ jest bắt.
 * Cùng lý do đã tách `layer-name.ts` trước đó.
 */

/** Thiết bị MEP đếm theo SỐ LƯỢNG (block/fixture) — không đo diện tích/thể tích. */
export const MEP_COUNT_TYPES = new Set([
  'light', 'socket', 'switch', 'electric_panel', 'sanitary',
  'valve', 'floor_drain', 'diffuser', 'hvac_unit', 'smoke_detector',
]);

/** Tuyến MEP đo theo CHIỀU DÀI (ống/dây/máng) — polyline length. */
export const MEP_LENGTH_TYPES = new Set(['wire', 'conduit', 'cable_tray', 'pipe', 'duct']);

/**
 * Phân type MEP theo BỘ MÔN — để bản ĐIỆN không đẻ ra công tác cấp thoát nước và
 * ngược lại (cùng nguyên tắc DISCIPLINE_ROWKEYS đã chặn bản kiến trúc đẻ công tác
 * kết cấu). PCCC (`smoke_detector`) tạm xếp vào ĐIỆN vì thường nằm chung bản vẽ điện.
 * HVAC (`duct`/`diffuser`/`hvac_unit`) cũng xếp ĐIỆN — GenSpec chưa có bộ môn HVAC riêng.
 */
export const DIEN_MEP_TYPES = new Set([
  'light', 'socket', 'switch', 'electric_panel', 'smoke_detector',
  'wire', 'conduit', 'cable_tray',
  'duct', 'diffuser', 'hvac_unit',
]);

/** Cấp/thoát nước + thiết bị vệ sinh. */
export const NUOC_MEP_TYPES = new Set(['sanitary', 'valve', 'floor_drain', 'pipe']);
