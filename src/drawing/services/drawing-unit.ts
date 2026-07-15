/**
 * Đơn vị bản vẽ → tỉ lệ mét, suy từ header lúc PARSE (một nguồn duy nhất).
 *
 * Vì sao cần: guard tiết diện cấu kiện KC (detector Tier 1b + engine isRealSection)
 * chỉ chạy được khi biết m/đơn-vị-vẽ. Detector chạy lúc parse, còn tỉ lệ trước đây
 * chỉ suy ra lúc takeoff → nhánh guard của detector chết. Suy sớm ở đây rồi lưu vào
 * Drawing.unitFactor để detector dùng được ngay từ lần parse đầu.
 *
 * NGUYÊN TẮC: chỉ tin đơn vị bản vẽ KHAI BÁO ($INSUNITS). Thiếu khai báo → undefined,
 * KHÔNG đoán mò theo kích thước tổng thể: bản vẽ KC thường gộp nhiều hình chiếu cạnh
 * nhau trong model space nên span "hợp lý" không chứng minh được đơn vị, đoán sai làm
 * cấu kiện THẬT bị loại thành ký hiệu. Thà thiếu còn hơn sai — undefined thì lớp 2
 * (engine isRealSection lúc đo) vẫn chặn.
 */
import type { DxfUnits } from '../parsers/dxf-parser.service';

/** Quy đổi đơn vị bản vẽ ($INSUNITS) → mét. */
export const INSUNITS_TO_METERS: Record<string, number> = { mm: 0.001, m: 1, inch: 0.0254 };

/** Kích thước tổng thể công trình hợp lý — cùng ngưỡng với takeoff engine. */
const MIN_SPAN_M = 2;
const MAX_SPAN_M = 5000;

/** Mã $INSUNITS → tên đơn vị. 0 = "unitless" (không khai báo) → 'unknown'. */
export function unitsFromInsunits(insunits: unknown): DxfUnits {
  const n = typeof insunits === 'string' ? Number(insunits) : (insunits as number);
  switch (n) {
    case 4: return 'mm';
    case 6: return 'm';
    case 1: return 'inch';
    default: return 'unknown';
  }
}

/** metadata parse result → tên đơn vị. DWG trả `insunits` (mã số), DXF trả `units` (chuỗi). */
export function unitsFromMetadata(metadata: Record<string, unknown> | undefined): DxfUnits {
  if (!metadata) return 'unknown';
  if (metadata.insunits !== undefined) return unitsFromInsunits(metadata.insunits);
  const u = metadata.units;
  return typeof u === 'string' && u in INSUNITS_TO_METERS ? (u as DxfUnits) : 'unknown';
}

export interface UnitFactorSource {
  metadata?: Record<string, unknown>;
  extMin?: { x: number; y: number };
  extMax?: { x: number; y: number };
}

/**
 * m/đơn vị vẽ suy từ header. undefined = KHÔNG chắc chắn → caller truyền undefined
 * xuống detector (bỏ qua guard tiết diện) thay vì đoán bừa tỉ lệ.
 *
 * Trả undefined khi: (a) thiếu/không đọc được $INSUNITS, hoặc (b) header CÓ khai đơn vị
 * nhưng với đơn vị đó kích thước tổng thể ra vô lý (ngoài 2m–5km) → header khai láo,
 * không tin. Extents thiếu/bằng 0 thì bỏ qua bước kiểm tra (b) và vẫn tin khai báo.
 */
export function inferUnitFactor(source: UnitFactorSource): number | undefined {
  const declared = INSUNITS_TO_METERS[unitsFromMetadata(source.metadata)];
  if (declared == null) return undefined;

  const w = (source.extMax?.x ?? 0) - (source.extMin?.x ?? 0);
  const h = (source.extMax?.y ?? 0) - (source.extMin?.y ?? 0);
  const span = Math.max(w, h);
  if (!isFinite(span) || span <= 0) return declared;

  const meters = span * declared;
  return meters >= MIN_SPAN_M && meters <= MAX_SPAN_M ? declared : undefined;
}
