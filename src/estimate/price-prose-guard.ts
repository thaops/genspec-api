/**
 * Chặn GIÁ BỊA trong câu trả lời VĂN XUÔI của chat (read/ask path).
 *
 * `guardFabricatedPricing` chỉ quét `update_cells` (giá ghi vào Ô) — nhưng đường chat "tra
 * giá" KHÔNG sinh action, nó trả một bài markdown tự do. Đo thật trên production: hỏi "tra
 * đơn giá xây tường M75 Hà Nội" → LLM trả nguyên bảng "1.840.250đ VL, 2.155.750đ/m³", tự
 * thú nhận "giả định Quý 4/2025", `sources = []` — số bịa hoàn toàn, mà proposal vẫn chấm
 * `score: 100`. Đúng thứ vision cấm ("thà thiếu còn hơn sai").
 *
 * Luật (deterministic, PURE — test được, không phụ thuộc hành vi LLM):
 *   có số tiền trong prose  ∧  KHÔNG có nguồn grounded (sourceCount === 0)
 *     → chèn cảnh báo ĐẦU bài + hạ điểm tin cậy về trần AI_PROSE_SCORE_CAP.
 *
 * KHÔNG xoá số (người dùng vẫn muốn đọc tham khảo) nhưng dán nhãn rõ để nó không bao giờ
 * trôi vào dự toán như số đã kiểm chứng.
 */

/** Trần điểm tin cậy cho câu trả lời có giá không nguồn — cùng tinh thần AI_PRICE_SCORE_CAP. */
export const AI_PROSE_SCORE_CAP = 40;

export const UNSOURCED_PRICE_WARNING =
  '⚠ **Số giá dưới đây CHƯA có nguồn kiểm chứng** — không tra được công bố giá tỉnh / định mức ' +
  'chính thức cho câu hỏi này. Đây là ước lượng tham khảo, PHẢI đối chiếu công bố giá Sở Xây dựng ' +
  'tỉnh (hoặc định mức hiện hành) trước khi đưa vào dự toán.';

/**
 * Số tiền kiểu Việt Nam: nhóm nghìn có phân tách (`1.840.250`, `2,155,750`). Cố ý KHÔNG bắt số
 * trần (vd `2025`, `220`, mã `AF.22221`) để tránh báo động giả — chỉ số ≥ 4 chữ số CÓ dấu phân
 * tách nghìn (đặc trưng của tiền), tức từ `1.000` trở lên.
 */
const MONEY_RE = /\d{1,3}(?:[.,]\d{3})+/;

export function proseHasMoney(text: string): boolean {
  return MONEY_RE.test(text ?? '');
}

export interface ProseGuardResult {
  message: string;
  /** true nếu đã phát hiện giá không nguồn và chèn cảnh báo. */
  flagged: boolean;
  /** Trần điểm áp cho validation khi flagged (undefined khi không cần hạ). */
  scoreCap?: number;
}

export function guardUnsourcedPriceInProse(message: string, sourceCount: number): ProseGuardResult {
  if (sourceCount > 0 || !proseHasMoney(message)) {
    return { message, flagged: false };
  }
  // Không chèn lại nếu cảnh báo đã có (idempotent — chat gọi nhiều vòng).
  const already = message.startsWith(UNSOURCED_PRICE_WARNING);
  return {
    message: already ? message : `${UNSOURCED_PRICE_WARNING}\n\n${message}`,
    flagged: true,
    scoreCap: AI_PROSE_SCORE_CAP,
  };
}
