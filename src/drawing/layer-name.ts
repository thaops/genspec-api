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
export function normalizeLayerName(layer: string): string {
  return (layer ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // dấu thanh + dấu mũ (combining marks)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase();
}
