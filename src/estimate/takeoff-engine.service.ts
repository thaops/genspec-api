// Deterministic Takeoff Engine — khối lượng tính bằng CODE từ hình học bản vẽ,
// mã hiệu tra từ DB norm_items thật. KHÔNG có LLM call nào ở đây.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NormComponent, NormItem } from '../catalog/catalog-db.schemas';
import { CatalogService, lookupComponentPrice } from '../catalog/catalog.service';
import { UnitPriceService } from '../catalog/unit-price.service';
import { UnitPrice } from '../catalog/unit-price.schema';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { Discipline, isDiscipline } from '../drawing/discipline';
import { EstimateService } from './estimate.service';
import { Action, EstimateState, TakeoffItem, ValidationFinding, ValidationReport } from './estimate.types';
import { rowsToUpdateCells, nameMatchScore } from './markdown-table-actions';
import { NormWebLookupService } from './norm-web-lookup.service';
import { PriceWebLookupService, WebPriceHit } from './price-web-lookup.service';
import { previewActions } from './transparency';
import { aggregateRebar, RebarTakeoff } from '../drawing/rebar-takeoff';
import { MEP_COUNT_TYPES, MEP_LENGTH_TYPES, DIEN_MEP_TYPES, NUOC_MEP_TYPES } from '../drawing/mep-types';
import { mepTakeoff, MEP_LABEL, MEP_UNIT } from '../drawing/mep-takeoff';

// ===== Pure core (không Mongo — verify script gọi trực tiếp từ dist) =====

export interface TakeoffAssumptions {
  floorHeight: number; // m
  wallThickness: number; // m
  beamDepth: number; // m
  footingDepth?: number; // m — chiều cao móng (giả định, mặc định 0.4m); mặt bằng không có → công khai trong ghi chú
  pileLength?: number; // m — chiều dài cọc (giả định, mặc định 20m); mặt cắt không có thông tin dài → công khai trong ghi chú
}

/** Chiều cao móng giả định (m) khi assumptions.footingDepth trống — ghi rõ trong Ghi chú mỗi dòng móng. */
export const DEFAULT_FOOTING_DEPTH = 0.4;

/** Chiều dài cọc giả định (m) khi assumptions.pileLength trống — ghi rõ trong Ghi chú mỗi dòng cọc. */
export const DEFAULT_PILE_LENGTH = 20;

export interface EngineDrawingObject {
  type: string;
  geometry?: number[][];
  boundingBox: { x?: number; y?: number; w: number; h: number };
  /** Tier 1/2.5: classification unresolved (multi-candidate) — must not be counted. */
  ambiguous?: boolean;
  /** Loại entity CAD gốc (LINE/LWPOLYLINE/HATCH…) — cần để tách nét đơn khỏi mặt cắt kín. */
  rawType?: string;
}

/**
 * A detected object may become a real BOQ quantity only when its class is settled.
 * Excludes: ambiguous (unresolved candidates), 'ignored' (non-plotting/excluded),
 * 'unknown' (undetected). Keeps every quantity defensible in front of an owner.
 */
export function isCountableObject(o: EngineDrawingObject): boolean {
  return !o.ambiguous && o.type !== 'ignored' && o.type !== 'unknown';
}

/** 1 ứng viên mã đơn giá THẬT từ `unit_prices` — để QS/agent CHỌN, engine KHÔNG tự chốt. */
export interface UnitPriceSuggestion {
  code: string;
  name: string;
  unit: string;
  unitPrice: number;
  sourceDoc: string;
}

export interface NormCandidate {
  code: string;
  name: string;
  unit: string;
  sourceDoc?: string;
  /** Hao phí VL/NC/M từ norm_items — nguồn tính đơn giá thật. */
  components?: { kind?: string; refCode?: string; name: string; unit?: string; norm: number }[];
  /**
   * ĐƠN GIÁ TRỌN GÓI từ `unit_prices` (đơn giá tỉnh) khi mã ĐÃ được chốt.
   * Khác `components`: đơn giá tỉnh là giá trọn gói/đơn vị công tác, không cần nhân
   * hao phí × giá tài nguyên. Thiếu đường này thì DÙ MÃ ĐÚNG giá vẫn null — đúng lỗi
   * đã đo trên production (4305 đơn giá Hà Nội nằm im, 13/13 dòng không giá).
   */
  directPrice?: { unitPrice: number; sourceDoc: string };
  /** Có mặt = mã tra từ WEB (grounded search) chứ không phải DB — cần kiểm chứng. */
  webSource?: { title?: string; uri?: string };
}

/**
 * HỌ MÃ định mức TT12/2021 theo từng công tác — tra từ bản định mức thật
 * (`TongHop Dinh muc_ Thong tu 12-2021-BXD`, 7490 mã Phần Xây dựng), KHÔNG tự chế.
 *
 * ⚠️ CỐ Ý KHÔNG phải `rowKey → 1 mã`. Bảng `COMMON_FALLBACK_CODES` cũ làm vậy và **17/18
 * mã sai** (12 mã không tồn tại; `AF.86411` là ván khuôn TRƯỢT, `AF.61120` là CỐT THÉP
 * móng, `AK.98110` là đá đệm móng, `AK.57110` là bó vỉa hè). Sai không phải vì tra ẩu —
 * mà vì **không tồn tại "một mã đúng"**: `AF.122` (bê tông cột) có **48 biến thể** khác
 * nhau ở tiết diện × chiều cao × mác bê tông × cỡ đá; `AE.221` (xây tường) có 16 biến thể
 * theo chiều dày × chiều cao × mác vữa. Những thông số đó nằm ở **thuyết minh/chỉ dẫn kỹ
 * thuật, KHÔNG suy được từ hình học bản vẽ** ⇒ máy tự chọn 1 mã = **đoán mác bê tông**.
 *
 * Nên engine chỉ thu hẹp về ĐÚNG HỌ (mọi ứng viên chắc chắn cùng loại công tác, chỉ khác
 * quy cách) rồi để QS chốt biến thể. Đây cũng là lý do KHÔNG dùng `$text` theo tên: đã đo
 * `"bê tông cột"` → khớp nhầm `"cọc tiêu bê tông cốt thép, cột km"` (cọc tiêu đường bộ).
 *
 * `window` KHÔNG có trong Phụ lục Phần Xây dựng (tra 7490 mã: chỉ có `AG.13231` gia công CỐT THÉP
 * cửa sổ và `AG.114` bê tông cửa sổ TRỜI — đều không phải công tác lắp cửa sổ) → để trống, không
 * bịa; cửa sổ nằm ở phụ lục Lắp đặt, chưa nạp.
 */
export const NORM_FAMILIES: Partial<Record<TakeoffRowKey, { prefixes: string[]; spec: string }>> = {
  wall_volume: { prefixes: ['AE.221'], spec: 'chiều dày tường, chiều cao, mác vữa' },
  wall_area: { prefixes: ['AK.211'], spec: 'trát trong/ngoài, chiều dày lớp trát, mác vữa' },
  wall_paint: { prefixes: ['AK.841'], spec: 'trong/ngoài nhà, số nước phủ (bả riêng: AK.825)' },
  column_concrete: { prefixes: ['AF.122'], spec: 'tiết diện cột, chiều cao, mác bê tông, cỡ đá' },
  beam_concrete: { prefixes: ['AF.123'], spec: 'chiều cao, mác bê tông, cỡ đá' },
  slab: { prefixes: ['AF.124'], spec: 'mác bê tông, cỡ đá' },
  footing_concrete: { prefixes: ['AF.112'], spec: 'chiều rộng móng, mác bê tông, cỡ đá' },
  // Ván khuôn: AF.83x = ván ép công nghiệp, AF.811x = gỗ → giữ cả hai để QS chọn vật liệu.
  column_formwork: { prefixes: ['AF.834', 'AF.8113'], spec: 'vật liệu ván khuôn, chiều cao, tiết diện cột' },
  beam_formwork: { prefixes: ['AF.833', 'AF.8114'], spec: 'vật liệu ván khuôn, chiều cao' },
  footing_formwork: { prefixes: ['AF.8111', 'AF.8112'], spec: 'loại móng (băng/bè/cột), vật liệu ván khuôn' },
  floor_screed: { prefixes: ['AK.411'], spec: 'chiều dày lớp láng, mác vữa, có/không đánh màu' },
  floor_finish: { prefixes: ['AK.512'], spec: 'kích thước viên gạch, mác vữa' },
  skirting: { prefixes: ['AK.312'], spec: 'tiết diện viên gạch ốp' },
  // Trần: AK.66 = thạch cao (phẳng AK.66110 / giật cấp AK.66210), AK.64 = tấm nhựa,
  // AK.61 = gỗ dán/ván ép → giữ cả ba, vật liệu trần do QS chốt (bản vẽ không nói).
  ceiling: { prefixes: ['AK.66', 'AK.64', 'AK.61'], spec: 'vật liệu tấm (thạch cao/nhựa/gỗ), trần phẳng hay giật cấp' },
  ceiling_paint: { prefixes: ['AK.841'], spec: 'trong/ngoài nhà, số nước phủ' },
  pile_concrete: { prefixes: ['AC.251'], spec: 'kích thước cọc, chiều dài đoạn cọc, lực ép' },
  // `door` CỐ Ý không có: dòng cửa nay tính theo **cái** (xem DERIVE.door — m² không suy
  // được từ mặt bằng), trong khi mã lắp cửa `AH.321` tính theo **m²** ⇒ gợi ý nó chỉ dẫn
  // QS tới đúng chỗ `unitPriceScale` chặn. Khi QS có m² từ bảng thống kê cửa thì chốt mã
  // thủ công. `window` không có mã trong Phần Xây dựng (xem doc ở trên).
};

export type TakeoffRowKey =
  | 'wall_area'
  | 'wall_volume'
  | 'wall_paint'
  | 'column_concrete'
  | 'column_formwork'
  | 'beam_concrete'
  | 'beam_formwork'
  | 'footing_concrete'   // bê tông móng (= diện tích móng × chiều cao giả định)
  | 'footing_formwork'   // ván khuôn móng (= chu vi móng × chiều cao)
  | 'pile_concrete'      // bê tông cọc (= tiết diện mặt cắt kín × chiều dài cọc giả định)
  | 'door'
  | 'window'
  | 'slab'
  | 'floor_screed'    // lớp cán nền/vữa lót (= diện tích sàn) — suy ra
  | 'floor_finish'
  | 'ceiling'         // trần (= diện tích sàn) — suy ra
  | 'ceiling_paint'   // sơn trần (= diện tích trần)
  | 'skirting'        // len/chân tường (= chiều dài tường)
  | MepRowKey;

/**
 * RowKey cho MEP — 1 key / 1 loại thiết bị hoặc tuyến, khớp 1-1 với type detector đã
 * nhận diện được (`MEP_COUNT_TYPES` đếm cái/bộ, `MEP_LENGTH_TYPES` đo mét).
 * Khối lượng do `mep-takeoff.ts` tính (module đã hoàn chỉnh từ trước, chỉ chưa nối
 * vào engine — giống hệt ca `rebar-takeoff.ts`).
 */
export type MepRowKey =
  // đếm số lượng (MEP_COUNT_TYPES)
  | 'mep_light' | 'mep_socket' | 'mep_switch' | 'mep_electric_panel' | 'mep_sanitary'
  | 'mep_valve' | 'mep_floor_drain' | 'mep_diffuser' | 'mep_hvac_unit' | 'mep_smoke_detector'
  // đo chiều dài tuyến (MEP_LENGTH_TYPES)
  | 'mep_wire' | 'mep_conduit' | 'mep_cable_tray' | 'mep_pipe' | 'mep_duct';

/** type detector → rowKey MEP. Nguồn chân lý là 2 Set trong detector, KHÔNG chép tay. */
export const mepRowKeyOf = (type: string) => `mep_${type}` as MepRowKey;

/** Tất cả rowKey MEP — sinh từ 2 Set của detector để không bao giờ lệch nhau. */
export const MEP_ROW_KEYS: MepRowKey[] = [...MEP_COUNT_TYPES, ...MEP_LENGTH_TYPES].map(mepRowKeyOf);

/** MEP rowKey → type gốc (bỏ tiền tố) để tra `MEP_LABEL`/`MEP_UNIT` sẵn có. */
const mepTypeOf = (key: MepRowKey) => key.slice('mep_'.length);

export type NormCandidateMap = Partial<Record<TakeoffRowKey, NormCandidate>>;

/**
 * Định tuyến bộ môn → tập TakeoffRowKey được phép sinh. GĐ2 "1 BOQ tổng xuyên
 * bộ môn, KHÔNG đếm trùng do thiết kế": mỗi bản vẽ theo bộ môn chỉ sinh nhóm
 * công tác của bộ môn đó, tất cả ghi vào cùng sheet "Khối lượng".
 *
 * Phân vai wall_* (lý do QS): trong dân dụng tường bao/ngăn là công tác KIẾN
 * TRÚC (xây + trát + bả/sơn) → wall_area/wall_volume/wall_paint gán KT. KC chỉ
 * cấu kiện chịu lực: cột/dầm/sàn (cột/dầm/sàn BT + ván khuôn). slab (bê tông
 * sàn) là kết cấu → KC; floor_finish (lát nền) là hoàn thiện → KT. Cửa đi/sổ là
 * hoàn thiện kiến trúc → KT. DIEN/NUOC: chưa có rowKey chuyên ngành → rỗng
 * (chỉ checklist, KHÔNG bịa). KHAC/undefined → null = giữ TẤT CẢ (hành vi cũ,
 * không vỡ bản vẽ đơn chưa gắn bộ môn).
 */
export const DISCIPLINE_ROWKEYS: Record<Discipline, TakeoffRowKey[] | null> = {
  KT: ['wall_area', 'wall_volume', 'wall_paint', 'door', 'window', 'floor_screed', 'floor_finish', 'ceiling', 'ceiling_paint', 'skirting'],
  KC: ['footing_concrete', 'footing_formwork', 'column_concrete', 'column_formwork', 'beam_concrete', 'beam_formwork', 'slab', 'pile_concrete'],
  // MEP: rowKey sinh tu type detector nhan dien duoc (mep-takeoff da tinh khoi luong).
  // Truoc day = [] nen bo ve DIEN/NUOC luon ra 0 dong du detector thay 136 den.
  DIEN: MEP_ROW_KEYS.filter((k) => DIEN_MEP_TYPES.has(k.slice(4))),
  NUOC: MEP_ROW_KEYS.filter((k) => NUOC_MEP_TYPES.has(k.slice(4))),
  KHAC: null,
};

/**
 * Tập rowKey được phép cho 1 bộ môn. null = không giới hạn (giữ tất cả — dùng
 * cho KHAC / bản vẽ chưa gắn bộ môn). PURE.
 */
export function rowKeysForDiscipline(discipline?: string): Set<TakeoffRowKey> | null {
  if (!discipline || !isDiscipline(discipline)) return null;
  const keys = DISCIPLINE_ROWKEYS[discipline];
  return keys == null ? null : new Set(keys);
}

export interface TakeoffEngineRow {
  key: TakeoffRowKey;
  group: string; // nhóm HÌNH HỌC: wall | column | beam | door | window | slab (dùng cho token [nhóm:x] + cleanup)
  /** Nhóm công tác BOQ chuẩn TT13 để hiển thị header phân nhóm (upsert_takeoff.group). */
  boqGroup: string;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  /** Diễn giải: CHỈ công thức số + token [nhóm:x] (+ ⚠ ngắn khi thiếu mã). */
  note: string;
  /** Nguồn dữ liệu: sourceDoc của norm (vd "TT12/2021") + "· CB giá <tỉnh> <MM/YYYY>" khi có giá; "—" khi không có. */
  source?: string;
  /** Đơn giá VNĐ (làm tròn) từ price_items tỉnh — undefined khi thiếu giá (KHÔNG ước lượng). */
  unitPrice?: number;
  /** Thành tiền = unitPrice × quantity (làm tròn VNĐ). */
  totalPrice?: number;
  /** true = mã tra từ web (không phải norm_items DB) — không tính là "đủ mã" cho score 90. */
  webSourced?: boolean;
  /** true = ĐƠN GIÁ tra từ web (không phải công bố giá tỉnh) — cần kiểm chứng. */
  pricedFromWeb?: boolean;
  /** true = ĐƠN GIÁ do LLM ƯỚC LƯỢNG (Tier 5, không nguồn) — số phao cuối, PHẢI kiểm chứng. */
  estimated?: boolean;
  /** true = giá ĐẠI DIỆN họ mã (Tier 3.5): giá THẬT từ đơn giá tỉnh nhưng chưa chốt biến thể. */
  familyRep?: boolean;
  /**
   * Bản vẽ nguồn của dòng (truy vết). Dòng MỚI của bản đang bóc để trống (caller dùng
   * `input.drawingId`); dòng GỘP từ bản khác thì suy từ id takeoff.
   */
  drawingId?: string;
  /** Mã vùng (8hex) dòng thuộc về — phân biệt các vùng/cụm cùng bản (chống bóc đè). */
  regionId?: string;
  /** Nhãn vùng hiển thị cho QS ("Cụm 1", "Tầng 1"…) — cột "Khu vực" trong sheet. */
  regionLabel?: string;
}

// ===== Pricing (pure — verify script gọi trực tiếp, không Mongo) =====

export interface PricingPriceItem {
  refCode?: string;
  name: string;
  price: number;
}

export interface PriceContextLite {
  province: string;
  sourceDoc: string;
  effectiveDate: string; // yyyy-mm-dd
  prices: PricingPriceItem[];
}

/**
 * 1 dòng bảng GIÁ VẬT LIỆU (sheet 04) — giá TẠI NGUỒN kèm truy vết.
 * `sourcePoint` + `includesTransport` là thứ khiến giá dùng lại được: cùng "Cát vàng"
 * có 600.000↔800.000đ/m³ tuỳ bãi, và giá mỏ CHƯA gồm cước vận chuyển. Thiếu 2 field
 * này thì con số vô nghĩa (không biết mỏ nào, bao nhiêu km).
 */
/** Layout sheet 04 — cột "Nguồn (mỏ/NCC)" và "Ghi chú" là bắt buộc, không phải trang trí. */
export const RESOURCE_PRICE_HEADERS = ['STT', 'Mã', 'Tên vật liệu / nhân công / máy', 'Đơn vị', 'Đơn giá', 'Nguồn (mỏ/NCC)', 'Ghi chú'] as const;

/**
 * Dựng bảng GIÁ VẬT LIỆU cho sheet 04. Mỗi dòng PHẢI mang mỏ + trạng thái vận chuyển:
 * giá mỏ dùng thẳng vào dự toán là THIẾU cước → Cost Summary hụt mà không lộ ra.
 * KHÔNG gộp/không trung bình các mỏ — cùng vật liệu nhiều mỏ thì giữ nhiều dòng, QS chốt
 * theo cự ly (chính công bố Sở XD yêu cầu vậy). PURE.
 */
export function buildResourcePriceRows(prices: ResourcePriceRow[]): string[][] {
  return prices.map((p, i) => [
    String(i + 1),
    p.refCode ?? '',
    p.name,
    p.unit ?? '',
    String(Math.round(p.price)),
    p.sourcePoint ?? '',
    [
      p.includesTransport ? 'đã gồm vận chuyển' : '⚠ CHƯA gồm vận chuyển/bốc xếp',
      'chưa VAT',
      p.sourceConfidence === 'medium' ? 'nguồn: báo giá đại lý — cần kiểm chứng' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  ]);
}

export interface ResourcePriceRow {
  refCode?: string;
  name: string;
  unit: string;
  /** Giá tại nguồn — chưa VAT (rule `markups.vatPct`), chưa vận chuyển. */
  price: number;
  kind: string;
  sourcePoint?: string;
  includesTransport?: boolean;
  sourceConfidence?: 'high' | 'medium';
}

/**
 * Đơn giá 1 công tác = Σ (norm × giá price_item khớp) trên TOÀN BỘ components.
 * Bất kỳ component nào không khớp giá → null (không ước lượng phần thiếu).
 */
export function priceNormComponents(
  components: { refCode?: string; name: string; norm: number }[] | undefined,
  prices: PricingPriceItem[],
): number | null {
  if (!components?.length || !prices.length) return null;
  let total = 0;
  for (const c of components) {
    const p = lookupComponentPrice(c, prices);
    if (p == null) return null;
    total += c.norm * p;
  }
  return Math.round(total);
}

/**
 * Gán đơn giá/thành tiền vào rows. Mutate-free: trả rows mới.
 * Thiếu giá → giữ nguyên dòng (cột giá trống), caller sinh finding warn.
 *
 * HAI nguồn giá, ưu tiên ĐƠN GIÁ TỈNH trọn gói trước:
 *  1. `cand.directPrice` — đơn giá công tác từ `unit_prices` (vd bộ Đơn giá Hà Nội,
 *     4305 dòng, nguồn TT 13/2021). Trọn gói/đơn vị → dùng thẳng, KHÔNG cần hao phí.
 *  2. `components` × `price_items` (định mức + công bố giá tỉnh) — đường cũ, chỉ chạy
 *     được khi `norm_items` đã import.
 * Trước đây CHỈ có (2) → `norm_items` rỗng thì dù mã đúng giá vẫn null (đo thật trên
 * production: 13/13 dòng không giá dù đã có 4305 đơn giá thật trong DB).
 */
/** Chuẩn hoá đơn vị để so sánh: "M²" / "m2 " / "1m2" → "m2". */
export function normalizeUnit(u?: string): string {
  return (u ?? '')
    .toLowerCase()
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/\s+/g, '')
    .replace(/^1(?=[a-z])/, ''); // "1m2" (đơn giá hay ghi vậy) ≡ "m2"
}

/**
 * Hệ số quy đổi giá của đơn giá tỉnh về ĐƠN VỊ CỦA DÒNG, hoặc `null` nếu KHÔNG quy đổi
 * được → không được áp giá.
 *
 * BUG THẬT chặn ở đây: đơn giá tỉnh nhiều mã tính theo **100m²/100m** trong khi dòng
 * engine tính theo m²/m — `AF.83411` ván khuôn cột = 8.387.228đ/**100m²**,
 * `AC.25111` ép cọc = 15.280.110đ/**100m**. Nhân thẳng `unitPrice × quantity` là
 * **đội giá 100 lần**. Quy đổi ÷100 là số học chính xác (không phải giả định), nhưng
 * đơn vị khác loại (vd "cái" vs "m2") thì KHÔNG có hệ số nào đúng ⇒ để trống.
 */
export function unitPriceScale(candUnit?: string, rowUnit?: string): number | null {
  const c = normalizeUnit(candUnit);
  const r = normalizeUnit(rowUnit);
  if (!c || !r) return null;
  if (c === r) return 1;
  const m = c.match(/^(\d+)(.+)$/); // "100m2" → ["100","m2"]
  if (m && m[2] === r) {
    const n = Number(m[1]);
    if (isFinite(n) && n > 0) return 1 / n;
  }
  return null;
}

/** Nhãn nguồn cho giá Tier 5 (LLM ước lượng) — cố định để guard/FE nhận diện không nhầm. */
export const ESTIMATED_PRICE_SOURCE = 'ƯỚC LƯỢNG — chưa kiểm chứng';
/** Trần điểm tin cậy khi dự toán có ≥1 dòng giá ước lượng (Tier 5). */
export const ESTIMATED_PRICE_SCORE_CAP = 45;

/** 1 giá ước lượng Tier 5 cho một rowKey (số do LLM đưa, đã parse). */
export interface EstimatedPrice {
  key: TakeoffRowKey;
  unitPrice: number;
  /** Cơ sở ước lượng LLM nêu (vd "mặt bằng giá thị trường 2026") — ghi vào diễn giải. */
  basis?: string;
}

/**
 * TIER 5 — phao cuối "LUÔN CÓ GIÁ": điền đơn giá ƯỚC LƯỢNG cho dòng VẪN null sau Tier 1-4
 * (DB tỉnh → tỉnh khác → định mức×giá → web grounded). Số này KHÔNG có nguồn kiểm chứng —
 * đây là ngoại lệ vision cho phép theo yêu cầu người dùng ("giá luôn có, không null"), nên
 * bắt buộc:
 *   · source = ESTIMATED_PRICE_SOURCE (nhãn cố định, không giả官 nguồn chính thống),
 *   · cờ `estimated: true` để FE/guard tô khác + validation hạ trần điểm,
 *   · chỉ áp cho dòng thật sự chưa có giá và có số ước lượng hợp lệ (>0).
 *
 * PURE — số ước lượng do caller (LLM) cấp; hàm này chỉ LẮP RÁP + ĐÁNH DẤU, test được. */
export function applyEstimatedFallback(
  rows: TakeoffEngineRow[],
  estimates: Map<TakeoffRowKey, EstimatedPrice>,
): { rows: TakeoffEngineRow[]; estimatedCount: number } {
  let estimatedCount = 0;
  const out = rows.map((r) => {
    if (r.unitPrice != null) return r; // đã có giá thật (Tier 1-4) → không đụng
    const e = estimates.get(r.key);
    if (!e || !(e.unitPrice > 0)) return r; // không có số hợp lệ → vẫn để trống, KHÔNG bịa 0
    estimatedCount++;
    return {
      ...r,
      unitPrice: Math.round(e.unitPrice),
      totalPrice: Math.round(e.unitPrice * r.quantity),
      source: ESTIMATED_PRICE_SOURCE,
      estimated: true,
      note: `${r.note} · Đơn giá ƯỚC LƯỢNG${e.basis ? ` (${e.basis})` : ''} — chưa đối chiếu công bố giá, cần kiểm chứng.`,
    };
  });
  return { rows: out, estimatedCount };
}

/** 1 ứng viên đơn giá tỉnh cho 1 rowKey (dùng cho Tier 3.5). */
export interface FamilyPriceOption {
  code: string;
  name: string;
  unit: string;
  unitPrice: number;
  sourceDoc: string;
}

/**
 * TIER 3.5 — GIÁ ĐẠI DIỆN HỌ MÃ (deterministic, dùng đơn giá tỉnh THẬT).
 *
 * Vấn đề đo trên prod: 4305 đơn giá Hà Nội nằm im vì rows không có `code`, mà đường DUY NHẤT
 * gán code (web-lookup grounded) rất chập chờn (Gemini fail → 0 giá thật, rơi hết Tier 5 dù
 * location đúng). Trong khi `NORM_FAMILIES` + `unit_prices.search` ĐÃ cho ra ĐÚNG HỌ mã +
 * giá thật, chỉ chưa chốt được BIẾN THỂ (mác bê tông/vữa).
 *
 * Tier 3.5 áp giá ĐẠI DIỆN của họ (median theo unitPrice — giảm sai lệch biến thể so với
 * min/max) cho dòng còn trống, TRƯỚC khi rơi Tier 5 LLM. Đây là giá THẬT có nguồn (sourceDoc),
 * chỉ cần QS chốt biến thể → đánh dấu `familyRep` + nguồn ghi rõ "cần chọn biến thể". Khác Tier
 * 5: có nguồn thật, sai số chỉ ở mức biến thể (mác), không phải đoán khơi khơi. PURE.
 */
export function applyFamilyRepresentative(
  rows: TakeoffEngineRow[],
  options: Map<TakeoffRowKey, FamilyPriceOption[]>,
): { rows: TakeoffEngineRow[]; familyRepCount: number } {
  let familyRepCount = 0;
  const out = rows.map((r) => {
    if (r.unitPrice != null) return r; // đã có giá (Tier 1-4)
    const opts = (options.get(r.key) ?? []).filter((o) => o.unitPrice > 0 && unitPriceScale(o.unit, r.unit) != null);
    if (opts.length === 0) return r;
    // Đại diện = MEDIAN theo unitPrice đã quy đổi về đơn vị dòng.
    const scaled = opts
      .map((o) => ({ o, price: Math.round(o.unitPrice * (unitPriceScale(o.unit, r.unit) as number)) }))
      .sort((a, b) => a.price - b.price);
    const rep = scaled[Math.floor(scaled.length / 2)];
    familyRepCount++;
    return {
      ...r,
      code: rep.o.code,
      unitPrice: rep.price,
      totalPrice: Math.round(rep.price * r.quantity),
      source: `${rep.o.sourceDoc} — giá đại diện họ mã (${opts.length} biến thể), CẦN CHỌN biến thể`,
      familyRep: true,
      note: `${r.note} · Đơn giá đại diện họ mã ${rep.o.code} (median ${opts.length} biến thể) — chốt biến thể để chính xác.`,
    };
  });
  return { rows: out, familyRepCount };
}

export function applyPricingToRows(
  rows: TakeoffEngineRow[],
  candidates: NormCandidateMap,
  ctx: PriceContextLite | null,
): TakeoffEngineRow[] {
  return rows.map((r) => {
    if (!r.code) return r;
    const cand = candidates[r.key];
    // 1. Đơn giá tỉnh trọn gói — có nguồn thật (sourceDoc), không phụ thuộc ctx.
    const direct = cand?.directPrice;
    if (direct) {
      // Đơn vị phải khớp (hoặc quy đổi được) — xem unitPriceScale. Lệch đơn vị mà vẫn
      // nhân = sai 100 lần nhưng kèm nguồn thật ⇒ nguy hiểm hơn để trống.
      const scale = unitPriceScale(cand?.unit, r.unit);
      if (scale == null) {
        return {
          ...r,
          note: `${r.note} ⚠ Mã ${r.code} tính theo "${cand?.unit ?? '?'}" nhưng dòng tính theo "${r.unit}" — không quy đổi được nên KHÔNG áp giá (tránh sai đơn vị).`,
        };
      }
      const unitPrice = Math.round(direct.unitPrice * scale);
      // Nguồn mã và nguồn giá là CÙNG một văn bản đơn giá tỉnh → không nối 2 lần
      // ("TT 13/2021 · TT 13/2021"). Chỉ nối khi thật sự là 2 nguồn khác nhau.
      const base = r.source && r.source !== '—' && !r.source.includes(direct.sourceDoc) ? `${r.source} · ` : '';
      const conv = scale === 1 ? '' : ` (quy đổi từ ${Math.round(direct.unitPrice).toLocaleString('vi-VN')}đ/${cand?.unit})`;
      return {
        ...r,
        unitPrice,
        totalPrice: Math.round(unitPrice * r.quantity),
        source: `${base}${direct.sourceDoc}${conv}`,
      };
    }
    // 2. Định mức × công bố giá tỉnh (đường cũ).
    if (!ctx) return r;
    const unitPrice = priceNormComponents(cand?.components, ctx.prices);
    if (unitPrice == null) return r;
    // MM/YYYY từ effectiveDate (yyyy-mm-dd)
    const [yyyy, mm] = ctx.effectiveDate.split('-');
    const priceSource = `CB giá ${ctx.province} ${mm}/${yyyy}`;
    const base = r.source && r.source !== '—' ? `${r.source} · ` : '';
    return {
      ...r,
      unitPrice,
      totalPrice: Math.round(unitPrice * r.quantity),
      source: `${base}${priceSource}`,
    };
  });
}

/** Bề rộng dầm giả định cố định (m) — ghi rõ trong Ghi chú mỗi dòng dầm. */
export const ASSUMED_BEAM_WIDTH = 0.2;

// Hatch KHÔNG nằm trong MEASURED_TYPES: nó được bóc riêng (lọc outlier) thành
// slab/floor_finish, và bị loại khỏi pool tính span của factor guard (hatch
// rác thường bị parked xa công trình).
const MEASURED_TYPES = ['wall', 'column', 'beam', 'door', 'window'] as const;

/** Ngưỡng lọc hatch: mảng < 0.5 m² là pattern ký hiệu, không phải nền. */
export const HATCH_MIN_AREA = 0.5;
/** Mảng hatch chiếm > tỉ lệ này của TỔNG diện tích hatch = biên/khối lớn bất thường → loại. */
export const HATCH_MAX_SHARE = 0.9;


/** Nhóm công tác BOQ chuẩn TT13/2021 cho mỗi dòng đo được. */
export const BOQ_GROUP_THO = 'PHẦN THÔ - KẾT CẤU';
export const BOQ_GROUP_FINISH = 'PHẦN HOÀN THIỆN';
export const BOQ_GROUP_OTHER = 'PHẦN KHÁC';

/** MEP la hang muc rieng, khong thuoc PHAN THO/HOAN THIEN. */
export const BOQ_GROUP_MEP = 'PHẦN ĐIỆN - NƯỚC';

/** Sinh Record cho moi rowKey MEP tu MOT nguon (MEP_ROW_KEYS) — khong chep tay 15 dong. */
const mepRecord = <T,>(fn: (k: MepRowKey) => T): Record<MepRowKey, T> =>
  Object.fromEntries(MEP_ROW_KEYS.map((k) => [k, fn(k)])) as Record<MepRowKey, T>;

const BOQ_GROUP: Record<TakeoffRowKey, string> = {
  ...mepRecord(() => BOQ_GROUP_MEP),
  wall_volume: BOQ_GROUP_THO,
  footing_concrete: BOQ_GROUP_THO,
  footing_formwork: BOQ_GROUP_THO,
  column_concrete: BOQ_GROUP_THO,
  column_formwork: BOQ_GROUP_THO,
  beam_concrete: BOQ_GROUP_THO,
  beam_formwork: BOQ_GROUP_THO,
  slab: BOQ_GROUP_THO,
  pile_concrete: BOQ_GROUP_THO,
  wall_area: BOQ_GROUP_FINISH,
  wall_paint: BOQ_GROUP_FINISH,
  floor_screed: BOQ_GROUP_FINISH,
  floor_finish: BOQ_GROUP_FINISH,
  door: BOQ_GROUP_FINISH,
  window: BOQ_GROUP_FINISH,
  ceiling: BOQ_GROUP_FINISH,
  ceiling_paint: BOQ_GROUP_FINISH,
  skirting: BOQ_GROUP_FINISH,
};

/** Thứ tự trình bày nhóm BOQ (thô trước, hoàn thiện sau, khác cuối). */
const BOQ_GROUP_ORDER = [BOQ_GROUP_THO, BOQ_GROUP_FINISH, BOQ_GROUP_OTHER];

/**
 * Phân sheet BOQ theo nhóm công tác QS (bản kiến trúc): thay vì dồn tất cả vào
 * 1 sheet "Khối lượng", tách 3 sheet để QS đọc theo trình tự chuẩn TT17/2019.
 * Mỗi sheet 1 màu header để phân biệt trực quan + cảm giác "lật trang" khi bóc.
 */
export interface BoqSheetDef {
  key: string;
  name: string;
  /** Nền nhạt cho thanh tiêu đề (đọc được với chữ accent đậm kể cả khi Univer strip nền). */
  tint: string;
  /** Màu accent đậm cho chữ tiêu đề + viền — mỗi sheet 1 màu để phân biệt. */
  accent: string;
}

export const BOQ_SHEETS: readonly BoqSheetDef[] = [
  { key: 'structure', name: '1. Kết cấu & bao che', tint: '#dbe4f0', accent: '#1e3a5f' }, // xanh dương
  { key: 'finishing', name: '2. Hoàn thiện bề mặt', tint: '#d7ead9', accent: '#14532d' }, // xanh lá
  { key: 'openings', name: '3. Cửa & phụ kiện', tint: '#f0e4cf', accent: '#713f12' }, // hổ phách
  { key: 'mep', name: '4. Điện & Nước', tint: '#e6dcf2', accent: '#4c1d95' }, // tím — MEP là hạng mục riêng
] as const;

/** Tên 3 sheet (thứ tự) — FE dùng để tạo sheet trước khi bóc. */
export const BOQ_SHEET_NAMES = BOQ_SHEETS.map((s) => s.name);

/**
 * rowKey → sheet đích. Xây + trát (bao che) và cấu kiện chịu lực → sheet 1;
 * bả/sơn + lát nền → sheet 2; cửa đi/sổ → sheet 3.
 */
const ROWKEY_SHEET: Record<TakeoffRowKey, string> = {
  ...mepRecord(() => 'mep'),
  wall_volume: 'structure',
  wall_area: 'structure',
  footing_concrete: 'structure',
  footing_formwork: 'structure',
  column_concrete: 'structure',
  column_formwork: 'structure',
  beam_concrete: 'structure',
  beam_formwork: 'structure',
  slab: 'structure',
  pile_concrete: 'structure',
  wall_paint: 'finishing',
  floor_screed: 'finishing',
  floor_finish: 'finishing',
  ceiling: 'finishing',
  ceiling_paint: 'finishing',
  skirting: 'finishing',
  door: 'openings',
  window: 'openings',
};

/**
 * rowKey → nhóm HÌNH HỌC (cột "Nhóm đối tượng"/D). Cần khi render GỘP: dòng của bản vẽ
 * KHÁC nằm trong `state.takeoff` chỉ còn id+giá, phải suy lại nhóm hình học từ rowKey.
 * MEP suy bằng cách bỏ tiền tố `mep_` (mep_light → light) — khớp `group` gốc lúc bóc.
 */
const ROWKEY_GEOM_GROUP: Record<TakeoffRowKey, string> = {
  ...mepRecord((k) => k.replace(/^mep_/, '')),
  wall_volume: 'wall', wall_area: 'wall', wall_paint: 'wall', skirting: 'wall',
  column_concrete: 'column', column_formwork: 'column',
  beam_concrete: 'beam', beam_formwork: 'beam',
  footing_concrete: 'footing', footing_formwork: 'footing',
  slab: 'slab', floor_screed: 'slab', floor_finish: 'slab', ceiling: 'slab', ceiling_paint: 'slab',
  pile_concrete: 'pile',
  door: 'door', window: 'window',
};

/**
 * MÃ VÙNG 8-hex tất định từ bbox vùng bóc — bóc LẠI cùng vùng → cùng mã → thay đúng vùng đó;
 * vùng KHÁC → mã khác → cộng thêm (KHÔNG đè). Toàn bản (không region) = '00000000'. PURE.
 *
 * Root cause bug "bóc đè": id cũ `tk_engine_<bản>_<rowKey>` không có chiều vùng → 2 cụm cùng
 * bản trùng id → cụm sau xoá cụm trước (đo thật prod: Sàn cụm 1 mất khi bóc cụm 3).
 */
export const WHOLE_DRAWING_REGION = '00000000';
export function regionIdOf(region?: { x: number; y: number; w: number; h: number }): string {
  if (!region) return WHOLE_DRAWING_REGION;
  const s = `${Math.round(region.x)}|${Math.round(region.y)}|${Math.round(region.w)}|${Math.round(region.h)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * id engine = `tk_engine_<drawingId 24hex>_[<region 8hex>_]<rowKey>` → tách rowKey.
 * Đoạn region 8-hex là TUỲ CHỌN (id cũ không có) — rowKey không bao giờ khớp `[0-9a-f]{8}_`
 * (vd "wall_volume" có 'w','l' không phải hex) nên phân biệt được. null nếu không khớp.
 */
export function engineRowKeyFromId(id: string): TakeoffRowKey | null {
  const m = /^tk_engine_[0-9a-fA-F]{24}_(?:[0-9a-f]{8}_)?(.+)$/.exec(id);
  const key = m?.[1];
  return key && key in ROWKEY_GEOM_GROUP ? (key as TakeoffRowKey) : null;
}

/** id engine → mã vùng (8hex) nếu có; null = id cũ / toàn bản. */
export function engineRegionIdFromId(id: string): string | null {
  return /^tk_engine_[0-9a-fA-F]{24}_([0-9a-f]{8})_/.exec(id)?.[1] ?? null;
}

/**
 * Rút MÁC (bê tông/vữa) từ tên công tác. Hai nguồn viết khác nhau nhưng cùng nghĩa:
 * định mức ghi `"M250"`, đơn giá tỉnh ghi `"Mác 200"` / `"mác 75"`. PURE.
 */
export function extractMac(name: string): number | null {
  const s = (name ?? '').toLowerCase();
  const m = /\bm[áa]c\s*(\d{2,3})\b/.exec(s) ?? /\bm(\d{2,3})\b/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return isFinite(n) ? n : null;
}

/**
 * Phát hiện MÂU THUẪN QUY CÁCH giữa định mức và đơn giá tỉnh cho CÙNG một mã.
 *
 * CA THẬT (đo trên production sau khi nạp 191 mã TT12): định mức nói `AF.12213` = **M250**
 * (xi măng 308,525 kg — khớp chuẩn ngành), đơn giá Hà Nội nói `AF.12213` = **Mác 200**.
 * Lệch đúng một bậc trên cả họ AF.122. Không có văn bản gốc BXD thì KHÔNG phân xử được ai
 * đúng — nên engine KHÔNG chọn bên nào, mà PHÁT HIỆN rồi báo, và không tự tính tiền từ
 * hao phí lệch. Nối bừa = "Phân tích đơn giá sai cấp phối" kèm dấu TT12/2021 trông rất thật.
 *
 * `null` = không đối chiếu được (thiếu mác ở một bên) → coi như KHÔNG xung đột (không bịa
 * mâu thuẫn), nhưng cũng không dùng làm bằng chứng khớp.
 */
export function macConflict(normName: string, priceName: string): { normMac: number; priceMac: number } | null {
  const a = extractMac(normName);
  const b = extractMac(priceName);
  if (a == null || b == null || a === b) return null;
  return { normMac: a, priceMac: b };
}

const isEngineTakeoffId = (id: string) => /^tk_engine_[0-9a-fA-F]{24}_/.test(id);

/** id engine → drawingId (null nếu không phải id engine). */
export function engineDrawingIdFromId(id: string): string | null {
  return /^tk_engine_([0-9a-fA-F]{24})_/.exec(id)?.[1] ?? null;
}

/**
 * QUYẾT ĐỊNH GỘP nhiều bản vẽ — PURE, tách khỏi `run()` để test khoá hành vi.
 *
 * Trả về:
 *  - `staleIds`: dòng cần XOÁ = dòng cũ CỦA CHÍNH bản này (rowKey không còn) + dòng legacy
 *    (id không theo scheme engine). TUYỆT ĐỐI KHÔNG xoá dòng bản KHÁC (bug cũ: gộp mất
 *    sạch bản trước, chỉ còn bản cuối).
 *  - `mergedRows`: render-set TOÀN CỤC = dòng bản KHÁC (dựng lại từ state.takeoff) + dòng
 *    MỚI của bản này, sắp theo thứ tự rowKey chuẩn để STT ổn định khi bóc lại. Mirror phải
 *    render set này, không chỉ dòng bản hiện tại — nếu không bản sau ghi đè bản trước.
 */
export function planEngineTakeoffMerge(
  existing: TakeoffItem[],
  drawingId: string,
  rows: TakeoffEngineRow[],
  /** Mã vùng đang bóc. Có region → chỉ đụng dòng CÙNG (bản, vùng), vùng khác GIỮ (cộng dồn).
   *  Toàn bản (WHOLE_DRAWING_REGION) → dọn TẤT CẢ vùng của bản (đo lại từ đầu). */
  regionId: string = WHOLE_DRAWING_REGION,
): { staleIds: string[]; mergedRows: TakeoffEngineRow[] } {
  const drawingPrefix = `tk_engine_${drawingId}_`;
  const wholeRedo = regionId === WHOLE_DRAWING_REGION;
  // Prefix của ĐÚNG vùng đang bóc — toàn bản dùng id CŨ (không mã vùng, tương thích ngược).
  const regionPrefix = wholeRedo ? drawingPrefix : `${drawingPrefix}${regionId}_`;
  const newIds = new Set(rows.map((r) => `${regionPrefix}${r.key}`));
  /** true nếu id thuộc CÙNG (bản, vùng) đang bóc. */
  const sameScope = (id: string) => {
    if (!id.startsWith(drawingPrefix)) return false;
    if (wholeRedo) return true; // toàn bản → mọi vùng của bản này thuộc phạm vi đo lại
    return engineRegionIdFromId(id) === regionId; // chỉ đúng vùng này
  };
  const staleIds = existing
    .filter((t) => {
      if (newIds.has(t.id)) return false; // dòng sẽ được upsert thay tại chỗ
      // Dòng cũ CÙNG (bản, vùng) đang bóc (rowKey không còn) → dọn. Vùng KHÁC của cùng bản → GIỮ.
      if (sameScope(t.id)) return true;
      // Dòng của bản KHÁC (hoặc vùng khác cùng bản) → GIỮ (không, bóc xoá sạch phần trước).
      if (isEngineTakeoffId(t.id)) return false;
      // Dòng LEGACY (engine/LLM bản cũ, id không theo scheme): nhận diện bằng token
      // `[nhóm:` — token này CHỈ còn để nhận legacy, KHÔNG ghi vào note mới nữa (nó
      // rò rỉ ra cột Diễn giải cho QS đọc: "... [nhóm:wall]").
      return typeof t.note === 'string' && t.note.includes('[nhóm:');
    })
    .map((t) => t.id);
  const deleted = new Set(staleIds);
  // GIỮ + render lại: mọi dòng engine KHÔNG bị dọn và KHÔNG bị dòng mới thay — gồm dòng bản
  // khác VÀ vùng khác của cùng bản (đây là chỗ chống "bóc đè": vùng khác cùng bản được bảo toàn).
  const otherRows: TakeoffEngineRow[] = existing
    .filter((t) => isEngineTakeoffId(t.id) && !deleted.has(t.id) && !newIds.has(t.id))
    .map((t): TakeoffEngineRow | null => {
      const key = engineRowKeyFromId(t.id);
      if (!key) return null;
      return {
        key,
        drawingId: engineDrawingIdFromId(t.id) ?? undefined,
        regionId: engineRegionIdFromId(t.id) ?? undefined,
        regionLabel: (t as any).regionLabel,
        group: ROWKEY_GEOM_GROUP[key],
        boqGroup: t.group ?? BOQ_GROUP[key],
        code: t.code ?? '',
        name: t.name,
        unit: t.unit,
        quantity: t.quantity,
        note: t.note ?? '',
        source: t.source,
        unitPrice: t.unitPrice,
        totalPrice: t.unitPrice != null ? Math.round(t.unitPrice * t.quantity) : undefined,
      };
    })
    .filter((r): r is TakeoffEngineRow => r !== null);
  const KEY_ORDER = Object.keys(ROWKEY_GEOM_GROUP) as TakeoffRowKey[];
  const mergedRows = [...otherRows, ...rows].sort(
    (x, y) => KEY_ORDER.indexOf(x.key) - KEY_ORDER.indexOf(y.key),
  );
  return { staleIds, mergedRows };
}

/**
 * Tên hiển thị cột "Tên công tác": mã web LUÔN dùng tên chuẩn engine; tên DB
 * chỉ dùng khi gọn (≤60 ký tự và ≤50% chữ viết hoa) — ngược lại rơi về tên chuẩn.
 * Chống tên web "SB.82510 SƠN DẦM, TRẦN, CỘT, TƯỜNG TRONG NHÀ...". PURE.
 */
export function standardDisplayName(key: TakeoffRowKey, raw: string | undefined): string {
  const std = DEFAULT_NAMES[key];
  if (!raw) return std;
  const letters = [...raw].filter((c) => c.toLowerCase() !== c.toUpperCase());
  const uppers = letters.filter((c) => c === c.toUpperCase());
  const upperRatio = letters.length ? uppers.length / letters.length : 0;
  if (raw.length > 60 || upperRatio > 0.5) return std;
  return raw;
}

/**
 * Các đầu việc QS chuẩn KHÔNG bóc được từ bản KIẾN TRÚC — danh sách TĨNH, không
 * phụ thuộc LLM. Chỉ để ghi chú minh bạch "cần bổ sung", KHÔNG sinh action/số.
 */
/**
 * `need`: các bộ môn mà — NẾU estimate đã có bản vẽ của một trong số đó — nguồn
 * dữ liệu đã tồn tại (chỉ là chưa detect ra), nên message đổi sang `haveReason`
 * thay vì "cần bản …". Item không có `need` = luôn cần bổ sung thủ công.
 */
export const CHECKLIST_QS: {
  name: string;
  reason: string;
  need?: Discipline[];
  haveReason?: string;
}[] = [
  {
    name: 'Cốt thép cột/dầm/sàn/móng',
    reason: 'cần bản KẾT CẤU (KT.dwg là bản kiến trúc, không có thông tin thép)',
    need: ['KC'],
    // KHÔNG nói "chưa nhận diện" — mâu thuẫn với finding "đã nhận ra N cấu kiện KC".
    haveReason: 'đã có bản KẾT CẤU — cấu kiện/thép vẽ nét đơn/ký hiệu, cần khoanh vùng để đo (xem finding cấu kiện KC)',
  },
  {
    name: 'Đào đất, bê tông lót, móng',
    reason: 'cần bản kết cấu móng',
    need: ['KC'],
    haveReason: 'đã có bản KẾT CẤU — móng vẽ nét đơn/ký hiệu, cần khoanh vùng để đo (xem finding cấu kiện KC)',
  },
  {
    name: 'Điện, nước, PCCC',
    reason: 'cần bản MEP',
    need: ['DIEN', 'NUOC'],
    haveReason: 'đã có bản Điện/Nước — chưa nhận diện được công tác MEP, cần khoanh vùng/gán loại',
  },
  { name: 'Ốp lát WC/bếp, gạch trang trí, len chân tường (từng loại)', reason: 'cần khoanh vùng nền/tường theo phòng — không tách được vật liệu từ nét mặt bằng' },
  { name: 'Chống thấm WC/ban công/mái', reason: 'cần khoanh vùng khu vệ sinh/ban công/mái' },
  { name: 'Trần (thạch cao/nhôm) từng loại, chi tiết trần', reason: 'đã suy diện tích trần ≈ sàn — cần tách loại trần theo phòng' },
  { name: 'Cầu thang, lan can, tay vịn, ram dốc, bậc tam cấp, bó vỉa', reason: 'cần bản chi tiết / khoanh vùng thủ công' },
  { name: 'Mái, mái kính, mái che, vách kính, vách ngăn, lanh tô', reason: 'cần bản chi tiết / mặt đứng — không bóc được từ mặt bằng' },
];

/** Reason phản ánh ĐÚNG cái còn thiếu theo bộ môn đã có trong estimate. */
function checklistReason(c: (typeof CHECKLIST_QS)[number], existing?: Set<string>): string {
  if (c.need && c.haveReason && existing && c.need.some((d) => existing.has(d))) return c.haveReason;
  return c.reason;
}

/**
 * Khối ghi chú "CẦN BỔ SUNG" — text thuần, KHÔNG phải công tác, KHÔNG có số.
 * `existing` = tập bộ môn đã có bản vẽ trong estimate → message phản ánh đúng
 * cái còn thiếu (có bản KC/MEP thì đổi "cần bản …" → "đã có, chưa detect").
 */
export function renderChecklistQs(existing?: Set<string>): string {
  const lines = CHECKLIST_QS.map((c, i) => `${i + 1}. ${c.name} — ${checklistReason(c, existing)}`);
  // Header trung lập bộ môn: bản KC không phải "bản kiến trúc".
  return `CẦN BỔ SUNG (chưa bóc được từ bản vẽ hiện tại — KHÔNG tạo số khống):\n${lines.join('\n')}`;
}

const DEFAULT_NAMES: Record<TakeoffRowKey, string> = {
  ...mepRecord((k) => MEP_LABEL[mepTypeOf(k)] ?? mepTypeOf(k)),
  wall_area: 'Xây/trát tường',
  wall_volume: 'Xây tường',
  wall_paint: 'Bả + sơn tường',
  column_concrete: 'Bê tông cột',
  column_formwork: 'Ván khuôn cột',
  beam_concrete: 'Bê tông dầm',
  beam_formwork: 'Ván khuôn dầm',
  footing_concrete: 'Bê tông móng',
  footing_formwork: 'Ván khuôn móng',
  pile_concrete: 'Bê tông cọc',
  door: 'Cửa đi',
  window: 'Cửa sổ',
  slab: 'Sàn (bê tông)',
  floor_screed: 'Lớp cán nền (vữa lót)',
  floor_finish: 'Lát nền (chưa xác định vật liệu)',
  ceiling: 'Trần (chưa xác định loại)',
  ceiling_paint: 'Sơn trần',
  skirting: 'Len/chân tường',
};

/** Nhãn cột "Nhóm đối tượng" — cho QS truy vết công tác bóc từ đối tượng nào. */
/**
 * Nhãn cột "Nhóm đối tượng" cho MEP — tái dùng `MEP_LABEL` sẵn có. Thiếu nó thì cột hiện
 * type thô tiếng Anh cho QS đọc ("light", "pipe") — đo thật trên sheet 4.
 */
const MEP_GROUP_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(MEP_LABEL).map(([t, vi]) => [t, `${vi} (${t})`]),
);

const OBJECT_GROUP_LABEL: Record<string, string> = {
  ...MEP_GROUP_LABEL, // Đèn (light), Ống nước (pipe)… — không để lộ type thô tiếng Anh
  wall: 'Tường (wall)',
  column: 'Cột (column)',
  beam: 'Dầm (beam)',
  footing: 'Móng (footing)',
  pile: 'Cọc (pile)',
  door: 'Cửa đi (door)',
  window: 'Cửa sổ (window)',
  slab: 'Sàn/nền (slab)',
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const f3 = (v: number) => String(round3(v));

function polylineLength(geometry: number[][]): number {
  let len = 0;
  for (let i = 1; i < geometry.length; i++) {
    len += Math.hypot(geometry[i][0] - geometry[i - 1][0], geometry[i][1] - geometry[i - 1][1]);
  }
  return len;
}

function shoelaceArea(geometry: number[][]): number {
  let a = 0;
  for (let i = 0, j = geometry.length - 1; i < geometry.length; j = i++) {
    a += (geometry[j][0] + geometry[i][0]) * (geometry[j][1] - geometry[i][1]);
  }
  return Math.abs(a) / 2;
}

/** Cùng công thức với genspec-web/lib/drawing/objectMeasure.ts. */
function measure(obj: EngineDrawingObject, factor: number): { length: number; area: number; perimeter: number } {
  const geo = obj.geometry ?? [];
  const { w, h } = obj.boundingBox;
  const rawLength = geo.length >= 2 ? polylineLength(geo) : Math.max(w, h);
  const rawArea = geo.length >= 3 ? shoelaceArea(geo) : w * h;
  return {
    length: rawLength * factor,
    area: rawArea * factor * factor,
    perimeter: 2 * (w + h) * factor, // xấp xỉ chu vi mặt cắt từ bbox
  };
}

interface GroupTotals {
  count: number;
  length: number;
  area: number;
  perimeter: number;
  /** Số object bị loại vì outlier diện tích (chỉ door/window — xem OUTLIER_PRONE_TYPES). */
  outliersDropped?: number;
}

// ===== RULE ENGINE — 1 đối tượng → N công tác (khai báo, không hardcode nhánh) =====
// QS không đo từng công tác riêng: 1 tường → xây + trát + sơn + len; 1 cột → bê
// tông + ván khuôn. Trước đây các suy diễn này nằm rải trong computeTakeoffRows.
// Nay khai báo thành bảng: thêm 1 công tác dẫn xuất = thêm 1 dòng, KHÔNG sửa code.
// Công thức + ghi chú giữ NGUYÊN VĂN (không đổi số/diễn giải) để không phá test.

/** Giả định đã resolve (m) truyền vào từng rule. */
export interface ResolvedAssumptions {
  H: number;  // cao tầng
  T: number;  // dày tường
  D: number;  // cao dầm
  W: number;  // bề rộng dầm
  FD: number; // cao móng
  PL: number; // chiều dài cọc
}

export interface DeriveRule {
  key: TakeoffRowKey;
  group: string; // nhóm hình học nguồn (wall/column/beam/footing/door)
  unit: string;
  /** Khối lượng từ tổng đo được của nhóm + giả định. */
  qty: (t: GroupTotals, a: ResolvedAssumptions) => number;
  /** Diễn giải công thức (chỉ số + đơn vị) — QS truy vết. */
  note: (t: GroupTotals, a: ResolvedAssumptions) => string;
}

/** nhóm hình học → danh sách công tác dẫn xuất. Slab/window có logic đặc thù (đo chéo nhóm) nên KHÔNG ở đây. */
export const DERIVE_RULES: Record<string, DeriveRule[]> = {
  wall: [
    { key: 'wall_area', group: 'wall', unit: 'm2',
      qty: (t, a) => round3(t.length * a.H),
      note: (t, a) => `${f3(t.length)}m × ${f3(a.H)}m = ${f3(round3(t.length * a.H))} m²` },
    { key: 'wall_volume', group: 'wall', unit: 'm3',
      qty: (t, a) => round3(t.length * a.H) * a.T,
      note: (t, a) => { const m2 = round3(t.length * a.H); return `${f3(m2)} m² × ${f3(a.T)}m = ${f3(m2 * a.T)} m³`; } },
    // Bả + sơn: cùng diện tích bề mặt trát (hệ số 1:1 ghi rõ, không nhân khống).
    { key: 'wall_paint', group: 'wall', unit: 'm2',
      qty: (t, a) => round3(t.length * a.H),
      note: (t, a) => { const m2 = round3(t.length * a.H); return `bả+sơn theo diện tích trát: ${f3(m2)} m² × 1 (hệ số 1:1) = ${f3(m2)} m²`; } },
    // Len/chân tường: chạy dọc chân tường ≈ chiều dài tường (suy ra, cần đối chiếu).
    { key: 'skirting', group: 'wall', unit: 'm',
      qty: (t) => t.length,
      note: (t) => `len/chân tường theo chiều dài tường = ${f3(t.length)} m` },
  ],
  column: [
    { key: 'column_concrete', group: 'column', unit: 'm3',
      qty: (t, a) => t.area * a.H,
      note: (t, a) => `${f3(t.area)} m² tiết diện (${t.count} cột) × ${f3(a.H)}m = ${f3(t.area * a.H)} m³` },
    { key: 'column_formwork', group: 'column', unit: 'm2',
      qty: (t, a) => t.perimeter * a.H,
      note: (t, a) => `chu vi ${f3(t.perimeter)}m (≈2×(w+h) bbox mỗi cột) × ${f3(a.H)}m = ${f3(t.perimeter * a.H)} m²` },
  ],
  beam: [
    { key: 'beam_concrete', group: 'beam', unit: 'm3',
      qty: (t, a) => t.length * a.D * a.W,
      note: (t, a) => `${f3(t.length)}m × ${f3(a.D)}m × ${f3(a.W)}m = ${f3(t.length * a.D * a.W)} m³` },
    { key: 'beam_formwork', group: 'beam', unit: 'm2',
      qty: (t, a) => t.length * (a.D * 2 + a.W),
      note: (t, a) => `${f3(t.length)}m × (${f3(a.D)}×2 + ${f3(a.W)})m = ${f3(t.length * (a.D * 2 + a.W))} m²` },
  ],
  footing: [
    { key: 'footing_concrete', group: 'footing', unit: 'm3',
      qty: (t, a) => t.area * a.FD,
      note: (t, a) => `${f3(t.area)} m² (${t.count} móng) × ${f3(a.FD)}m cao (giả định) = ${f3(t.area * a.FD)} m³` },
    { key: 'footing_formwork', group: 'footing', unit: 'm2',
      qty: (t, a) => t.perimeter * a.FD,
      note: (t, a) => `chu vi ${f3(t.perimeter)}m × ${f3(a.FD)}m cao = ${f3(t.perimeter * a.FD)} m²` },
  ],
  pile: [
    { key: 'pile_concrete', group: 'pile', unit: 'm3',
      qty: (t, a) => t.area * a.PL,
      note: (t, a) => `${f3(t.area)} m² tiết diện (${t.count} cọc) × ${f3(a.PL)}m dài (giả định) = ${f3(t.area * a.PL)} m³` },
  ],
  /**
   * CỬA ĐI ĐẾM THEO **CÁI**, KHÔNG suy m² từ hình học mặt bằng.
   *
   * Trước đây: `qty = t.area` = tổng diện tích **bbox mặt bằng** của cửa. Sai về bản chất —
   * bbox cửa trong mặt bằng là *bề rộng × cung quét cánh* (vệt sàn), không phải diện tích
   * cánh cửa. m² cửa trong BOQ = **rộng × cao**, mà **chiều cao không tồn tại trong mặt bằng**.
   *
   * Đo thật trên "KT.dwg" (221 cửa) — đủ để bác bỏ MỌI công thức suy m²/bề rộng từ bbox:
   *  · chỉ 27% cửa có bbox "vuông" (cánh+cung quét); median tỉ lệ cạnh 2,40
   *  · chỉ 10% có cạnh nhỏ nằm trong dải cửa thật 0,6–1,2m
   *  · 67/201 có cạnh nhỏ < 0,3m (không thể là cửa)
   * ⇒ cả `area` lẫn `width` đều KHÔNG suy được. Gốc là luật layer `"cua"` vơ hết mọi thứ
   * trên layer đó (ký hiệu, phụ kiện, mặt đứng), không phải công thức sai.
   *
   * Nên chỉ báo thứ BẢO VỆ ĐƯỢC: **số lượng cửa đếm được**. m² để QS điền từ bảng thống kê
   * cửa (file này KHÔNG có bảng đó — đã tra: 0 kết quả "THỐNG KÊ", 0 mã D1/P1 dạng text).
   * Nâng cấp về sau: đọc bảng thống kê khi bản vẽ có → m² CÓ NGUỒN THẬT, vẫn không giả định.
   */
  door: [
    { key: 'door', group: 'door', unit: 'cái',
      qty: (t) => t.count,
      // Diễn giải NGẮN — chỉ cách ra số. Lý do "vì sao không có m²" đã nằm ở finding
      // gộp, nhét cả đoạn văn vào ô làm bảng không đọc nổi.
      note: (t) =>
        `đếm ${t.count} cửa từ block bản vẽ` +
        `${t.outliersDropped ? ` (loại ${t.outliersDropped} block lỗi kích thước)` : ''}`,
    },
  ],
};

/** Thứ tự chạy nhóm (giữ đúng thứ tự phát sinh cũ để STT ổn định). */
const DERIVE_GROUP_ORDER = ['wall', 'column', 'beam', 'footing', 'pile', 'door'];

export interface HatchSlabStats {
  /** Số hatch có diện tích > 0. */
  count: number;
  /** Số hatch đủ tin cậy (qua lọc ngưỡng) → dùng bóc sàn. */
  used: number;
  /** Số hatch bị loại (quá nhỏ / quá lớn). */
  dropped: number;
  /** Tổng diện tích các hatch đủ tin cậy (m²). */
  area: number;
}

/**
 * Bóc diện tích sàn/nền từ hatch — ĐO THẬT bằng shoelace, không bịa.
 * Lọc outlier: bỏ mảng < HATCH_MIN_AREA (pattern ký hiệu) và mảng
 * > HATCH_MAX_SHARE tổng (biên/khối bất thường). Trả về Σ diện tích qualified.
 */
export function hatchSlabStats(objects: EngineDrawingObject[], factor: number): HatchSlabStats {
  const areas: number[] = [];
  for (const o of objects) {
    if (o.type !== 'hatch' || !isCountableObject(o)) continue;
    const a = measure(o, factor).area;
    if (a > 0) areas.push(a);
  }
  const total = areas.reduce((s, a) => s + a, 0);
  const cap = HATCH_MAX_SHARE * total;
  const qualified = areas.filter((a) => a >= HATCH_MIN_AREA && a <= cap);
  return {
    count: areas.length,
    used: qualified.length,
    dropped: areas.length - qualified.length,
    area: round3(qualified.reduce((s, a) => s + a, 0)),
  };
}

/**
 * Đếm số "cụm bản vẽ" trong model space: gom tâm bbox các đối tượng ĐO ĐƯỢC vào
 * lưới ô cạnh eps (mét thật, quy về đơn vị vẽ qua factor) rồi nối 8-neighbour
 * (union-find). DWG dân dụng hay đặt nhiều mặt bằng/mặt đứng/chi tiết cạnh nhau
 * → nhiều cụm; "bóc toàn bộ" sẽ CỘNG DỒN tất cả → khối lượng phồng. eps ~ kích
 * thước 1 công trình để KHÔNG xé nhỏ 1 mặt bằng thành nhiều cụm. PURE.
 */
export interface ObjectCluster {
  /** Vùng bbox của cụm (world coords bản vẽ) — dùng thẳng làm `region` để bóc lại. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Số đối tượng đo được trong cụm. */
  count: number;
  /** Đếm theo type — để QS nhận ra cụm nào là mặt bằng (nhiều tường/cửa). */
  byType: Record<string, number>;
}

/**
 * Như `countObjectClusters` nhưng GIỮ LẠI thành phần từng cụm (bbox + đếm theo type).
 * Cần thiết vì engine KHÔNG được tự đoán cụm nào là mặt bằng cần bóc (đo thật: ghép nét
 * tường ngây thơ ra 6403m thay vì ~150-200m) — thay vào đó phơi bày cấu trúc để QS chọn,
 * và trả sẵn `region` để bóc lại đúng cụm đó. PURE.
 */
export function objectClusters(
  objects: EngineDrawingObject[],
  factor: number,
  epsMeters = 25,
): { clusters: ObjectCluster[]; spanM: number } {
  const cell = epsMeters / (factor || 1);
  /** [cx, cy, type, bbox] của từng object đo được. */
  const pts: { cx: number; cy: number; type: string; b: EngineDrawingObject['boundingBox'] }[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const o of objects) {
    // Cấu kiện KC vẽ nét đơn (beam/footing LINE) là AMBIGUOUS nên trượt isCountableObject —
    // nhưng kcLinearRows ĐO chúng, và chúng thuộc về mặt bằng KC. Không đưa vào clustering
    // thì `region` của cụm KHÔNG bao chúng → bóc theo cụm mất sạch dầm nét đơn (đo thật trên
    // prod: cụm "15 dầm" nhưng bóc ra 0 dầm). Nhận cả hai: đối tượng đo được thường, và nét
    // đơn KC.
    const isKcLinear =
      (o.rawType ?? '').toUpperCase() === 'LINE' && (o.type === 'beam' || o.type === 'footing');
    // Cột tròn ambiguous cũng thuộc mặt bằng KC — không đưa vào cụm thì region KHÔNG bao,
    // confirmRoundColumns bóc theo vùng sẽ mất sạch cột (cùng lỗi như dầm nét đơn).
    const countable = isCountableObject(o) && (MEASURED_TYPES as readonly string[]).includes(o.type);
    // Object MEP (pipe/light/socket…) cũng phải vào clustering — nếu không, bản ĐIỆN/NƯỚC
    // KHÔNG tách được cụm (sau V1 hết cấu kiện giả) → gộp cả sơ đồ trục đứng/chi tiết vào tổng
    // (đo thật prod: NƯỚC ống 7342m gộp mọi view). Cùng lý do như cấu kiện KC.
    const isMep = isCountableObject(o) && (MEP_COUNT_TYPES.has(o.type) || MEP_LENGTH_TYPES.has(o.type));
    if (!countable && !isKcLinear && !isRoundColumnSection(o) && !isMep) continue;
    const b = o.boundingBox;
    const cx = (b.x ?? 0) + (b.w ?? 0) / 2;
    const cy = (b.y ?? 0) + (b.h ?? 0) / 2;
    if (!isFinite(cx) || !isFinite(cy)) continue;
    pts.push({ cx, cy, type: o.type, b });
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
  }
  const spanM = pts.length ? Math.max(maxX - minX, maxY - minY) * factor : 0;
  const asCluster = (list: typeof pts): ObjectCluster => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const byType: Record<string, number> = {};
    for (const p of list) {
      const bx = p.b.x ?? 0, by = p.b.y ?? 0;
      x0 = Math.min(x0, bx); y0 = Math.min(y0, by);
      x1 = Math.max(x1, bx + (p.b.w ?? 0)); y1 = Math.max(y1, by + (p.b.h ?? 0));
      byType[p.type] = (byType[p.type] ?? 0) + 1;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, count: list.length, byType };
  };
  // <8 đối tượng: quá ít để nói về "nhiều bản vẽ" → coi như 1 cụm (giữ nguyên hành vi cũ).
  if (pts.length < 8) return { clusters: pts.length ? [asCluster(pts)] : [], spanM: 0 };

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) { parent.set(r, parent.get(parent.get(r)!)!); r = parent.get(r)!; }
    return r;
  };
  const key = (ix: number, iy: number) => `${ix}:${iy}`;
  const cellOf = (p: { cx: number; cy: number }) => key(Math.floor(p.cx / cell), Math.floor(p.cy / cell));
  const cells = new Set<string>();
  for (const p of pts) {
    const k = cellOf(p);
    cells.add(k);
    if (!parent.has(k)) parent.set(k, k);
  }
  for (const c of cells) {
    const [ix, iy] = c.split(':').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const nb = key(ix + dx, iy + dy);
      if (parent.has(nb)) {
        const ra = find(c), rb = find(nb);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const groups = new Map<string, typeof pts>();
  for (const p of pts) {
    const root = find(cellOf(p));
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(p);
  }
  return {
    // Cụm đông đối tượng nhất lên đầu — thường là mặt bằng chính; QS vẫn tự chọn.
    clusters: [...groups.values()].map(asCluster).sort((a, b) => b.count - a.count),
    spanM,
  };
}

/**
 * Mô tả từng cụm cho QS đọc: kích thước thật, thành phần, và TOẠ ĐỘ VÙNG để bóc lại
 * đúng cụm đó (agent đọc được toạ độ này → gọi lại takeoff với `region`, QS không phải
 * kéo tay). KHÔNG kết luận cụm nào là mặt bằng — chỉ bày ra. PURE.
 */
export function describeClusters(clusters: ObjectCluster[], factor: number, max = 8): string {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return clusters
    .slice(0, max)
    .map((c, i) => {
      const parts = Object.entries(c.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`)
        .join(', ');
      return (
        `· Cụm ${i + 1}: ${c.count} đối tượng (${parts}) — kích thước ~${r1(c.w * factor)}×${r1(c.h * factor)}m, ` +
        `vùng x=${Math.round(c.x)} y=${Math.round(c.y)} w=${Math.round(c.w)} h=${Math.round(c.h)}`
      );
    })
    .concat(clusters.length > max ? [`· … và ${clusters.length - max} cụm nhỏ hơn`] : [])
    .join('\n');
}

/**
 * Vùng bóc của một cụm, nới thêm biên an toàn.
 *
 * bbox của cụm ôm khít tâm-bbox các đối tượng ĐO ĐƯỢC (`objectClusters` chỉ nhìn
 * MEASURED_TYPES). Dùng khít sẽ rụng mất hatch sàn / lỗ mở / đường ống nằm sát mép —
 * chúng không tham gia clustering nhưng vẫn thuộc mặt bằng đó. Nới 1m mỗi phía (quy về
 * đơn vị vẽ) đủ ôm trọn mà chưa chạm cụm kế bên (khoảng cách giữa 2 cụm ≥ eps = 25m). PURE.
 */
export function clusterRegion(
  c: ObjectCluster,
  factor: number,
  padMeters = 1,
): { x: number; y: number; w: number; h: number } {
  const pad = padMeters / (factor || 1);
  return { x: c.x - pad, y: c.y - pad, w: c.w + pad * 2, h: c.h + pad * 2 };
}

/** Lọc đối tượng theo TÂM bbox nằm trong vùng — cùng luật với `region` của `run()`. PURE. */
export function objectsInRegion<T extends { boundingBox?: { x?: number; y?: number; w?: number; h?: number } }>(
  objects: T[],
  r: { x: number; y: number; w: number; h: number },
): T[] {
  return objects.filter((o) => {
    const b = (o as any).boundingBox ?? {};
    const cx = Number(b.x ?? 0) + Number(b.w ?? 0) / 2;
    const cy = Number(b.y ?? 0) + Number(b.h ?? 0) / 2;
    return isFinite(cx) && isFinite(cy) && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  });
}

/** Một cụm đã bóc thử — đủ để QS nhìn số mà chọn, chưa ghi gì vào Workbook. */
export interface ClusterPreview {
  /** 1-based, khớp số thứ tự trong `describeClusters`. */
  id: number;
  /** Truyền thẳng lại vào `POST /takeoff-engine` dưới khoá `region` để bóc đúng cụm này. */
  region: { x: number; y: number; w: number; h: number };
  count: number;
  byType: Record<string, number>;
  widthM: number;
  heightM: number;
  /** Mô tả thành phần đo được — KHÔNG kết luận "đây là mặt bằng tầng 1". */
  hint: string;
  /** Khối lượng nếu bóc riêng cụm này (hình học thuần, chưa tra mã/giá). */
  lines: { name: string; unit: string; quantity: number }[];
}

/**
 * Bóc THỬ từng cụm để QS so số rồi chọn, thay vì nhận một con số tổng đã cộng dồn mọi
 * cụm (đo trên production: 4 bản THUC HANH 2 → tường 28.594 m² / 6.290 m³ cho một trạm
 * xá ~315 m² sàn, vì model space có 6 cụm mặt bằng/mặt đứng/chi tiết cạnh nhau).
 *
 * Chỉ chạy hình học (`computeTakeoffRows` + `computeMepRows` đều PURE) — KHÔNG tra mã,
 * KHÔNG tra giá, KHÔNG gọi web: preview là để chọn cụm, không phải để ghi vào Workbook,
 * và nhân số cụm lên sẽ đốt sạch quota grounding. PURE.
 */
export function clusterPreviews(
  objects: EngineDrawingObject[],
  clusters: ObjectCluster[],
  factor: number,
  assumptions: TakeoffAssumptions,
  allowedKeys?: Set<TakeoffRowKey> | null,
  max = 8,
): ClusterPreview[] {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return clusters.slice(0, max).map((c, i) => {
    const region = clusterRegion(c, factor);
    const inside = objectsInRegion(objects as any[], region) as EngineDrawingObject[];
    const lines = mergeRowsByKey([
      ...computeTakeoffRows(inside, factor, assumptions, {}, allowedKeys),
      ...computeMepRows(inside as any[], factor, allowedKeys),
      // Dầm nét đơn KC — nếu không đưa vào preview, hint "15 dầm" mà lines trống → QS bối rối.
      ...kcLinearRows(inside, factor, assumptions, allowedKeys).rows,
    ]).map((r) => ({ name: r.name, unit: r.unit, quantity: r.quantity }));
    const hint = Object.entries(c.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`)
      .join(', ');
    return {
      id: i + 1,
      region,
      count: c.count,
      byType: c.byType,
      widthM: r1(c.w * factor),
      heightM: r1(c.h * factor),
      hint,
      lines,
    };
  });
}

/** Wrapper giữ nguyên chữ ký cũ (chỉ cần số cụm + span). */
export function countObjectClusters(
  objects: EngineDrawingObject[],
  factor: number,
  epsMeters = 25,
): { clusters: number; spanM: number } {
  const r = objectClusters(objects, factor, epsMeters);
  return { clusters: r.clusters.length, spanM: r.spanM };
}

// Guard tiết diện cấu kiện KC: cạnh nhỏ hơn ngưỡng vật lý = ký hiệu/điểm/bọt lưới
// trục, KHÔNG phải mặt cắt thật → không đo (chống ván khuôn/bê tông khống).
// Cột/dầm thật cạnh ≥ ~100mm; 0.08m an toàn dưới mọi tiết diện thật.
export const SECTION_TYPES = new Set(['column', 'beam', 'footing', 'pile']);
export const MIN_SECTION_M = 0.08;

/**
 * ⚠ KHÔNG áp ngưỡng cạnh nhỏ cho cửa/cửa sổ. Đã thử ngưỡng 0,3m và **số liệu thật bác bỏ**:
 * 67/221 "cửa" trên "KT.dwg" có cạnh nhỏ < 0,3m nhưng là **CỬA THẬT VẼ MỎNG** —
 * `1050×200`, `800×200`, `1500×200`, `200×900` mm, trong đó 200mm chính là BỀ DÀY TƯỜNG
 * (cửa vẽ dạng khối chữ nhật cắt ngang tường, không vẽ cung quét). Ngưỡng đó xoá cửa thật.
 * Cột/dầm khác hẳn: chúng là MẶT CẮT nên cạnh nhỏ = tiết diện thật ⇒ ngưỡng có nghĩa.
 */
/**
 * Cấu kiện KC vẽ bằng NÉT ĐƠN (rawType LINE) trên layer đã KHẲNG ĐỊNH type — netDAM/netMONG.
 *
 * detector để `ambiguous` cho những nét này vì LINE không có mặt cắt kín để lấy tiết diện;
 * NHƯNG tên layer là bằng chứng đủ mạnh: tier 1b chỉ gán beam/footing cho một LINE khi
 * layer chứa token DAM/BEAM/MONG… (hình học LINE đơn không tự suy ra type KC). Ta TIN type
 * đó và đo dầm giống hệt cách đo tường: tổng chiều dài nét × tiết diện GIẢ ĐỊNH.
 *
 * - beam: mỗi nét coi = 1 TIM dầm (giả định công khai trong ghi chú — nếu bản vẽ dùng nét
 *   đôi/mép thì số ra gấp đôi, QS thấy và sửa) → L×D×W (BT), L×(2D+W) (ván khuôn).
 * - footing/pile: một nét đơn KHÔNG cho biết diện tích đáy móng / tiết diện cọc ⇒ KHÔNG đo,
 *   chỉ đếm để liệt kê. Thà thiếu còn hơn bịa (đúng bài học "12 móng thật hoá ra toàn LINE").
 *
 * Chỉ nhận rawType==='LINE': mặt cắt kín (LWPOLYLINE/HATCH) đã được `computeTakeoffRows` đo;
 * beam suy từ HÌNH HỌC (LWPOLYLINE aspect cao trên layer KHÔNG khẳng định) cũng không lọt
 * vào đây, tránh đo trùng. PURE.
 */
export function kcLinearRows(
  objects: EngineDrawingObject[],
  factor: number,
  assumptions: TakeoffAssumptions,
  allowedKeys?: Set<TakeoffRowKey> | null,
): { rows: TakeoffEngineRow[]; measured: Set<EngineDrawingObject>; unmeasuredLinear: Record<string, number> } {
  const isLine = (o: EngineDrawingObject) => (o.rawType ?? '').toUpperCase() === 'LINE';
  const allow = (k: TakeoffRowKey) => !allowedKeys || allowedKeys.has(k);
  const rows: TakeoffEngineRow[] = [];
  const measured = new Set<EngineDrawingObject>();
  const unmeasuredLinear: Record<string, number> = {};

  // CHỈ lấy nét đơn AMBIGUOUS — dầm nét đơn non-ambiguous (tiết diện đủ lớn) đã được
  // computeTakeoffRows đo rồi; lấy lại ở đây = đếm trùng (đo thật: 17 dầm "Thay Dam"
  // countable + 12 dầm "netDAM" ambiguous → nếu không lọc sẽ cộng cả 29).
  const beams = objects.filter((o) => o.type === 'beam' && isLine(o) && o.ambiguous === true);
  if (beams.length > 0) {
    const totalLen = beams.reduce((s, o) => s + measure(o, factor).length, 0);
    const D = assumptions.beamDepth;
    const W = ASSUMED_BEAM_WIDTH;
    const mk = (key: TakeoffRowKey, unit: string, q: number, note: string) => {
      const quantity = round3(q);
      if (!allow(key) || quantity <= 0) return;
      rows.push({ key, group: 'beam', boqGroup: BOQ_GROUP[key], code: '', name: DEFAULT_NAMES[key], unit, quantity, note, source: '—' });
    };
    const lead = `${beams.length} nét dầm trên layer khẳng định (netDAM…), tổng dài ${f3(totalLen)}m`;
    mk('beam_concrete', 'm3', totalLen * D * W,
      `${lead} × ${f3(D)}×${f3(W)}m = ${f3(round3(totalLen * D * W))} m³ (giả định mỗi nét = 1 tim dầm)`);
    mk('beam_formwork', 'm2', totalLen * (D * 2 + W),
      `${lead} × (${f3(D)}×2 + ${f3(W)})m = ${f3(round3(totalLen * (D * 2 + W)))} m² (giả định mỗi nét = 1 tim dầm)`);
    if (rows.length) for (const b of beams) measured.add(b);
  }

  // Móng/cọc vẽ nét đơn AMBIGUOUS: đếm để liệt kê "cần bổ sung tiết diện", KHÔNG đo.
  // (non-ambiguous có mặt cắt kín thì computeTakeoffRows đã đo.)
  for (const o of objects) {
    if (!isLine(o) || o.ambiguous !== true) continue;
    if (o.type === 'footing' || o.type === 'pile') {
      unmeasuredLinear[o.type] = (unmeasuredLinear[o.type] ?? 0) + 1;
    }
  }
  return { rows, measured, unmeasuredLinear };
}

/**
 * Gộp các dòng CÙNG rowKey thành một — cộng khối lượng, nối diễn giải. Cần vì cùng một
 * công tác (vd `beam_concrete`) có thể đến từ 2 nguồn đo khác nhau: mặt cắt kín
 * (computeTakeoffRows) và nét đơn theo layer (kcLinearRows). Không gộp thì hai dòng cùng
 * rowKey → cùng id action `tk_engine_<drawingId>_<rowKey>` → dòng sau đè dòng trước, MẤT
 * khối lượng. rowKey là đơn vị 1 dòng BOQ nên gộp theo key là đúng ngữ nghĩa. PURE.
 */
export function mergeRowsByKey(rows: TakeoffEngineRow[]): TakeoffEngineRow[] {
  const byKey = new Map<string, TakeoffEngineRow>();
  for (const r of rows) {
    const prev = byKey.get(r.key);
    if (!prev) {
      byKey.set(r.key, { ...r });
      continue;
    }
    prev.quantity = round3(prev.quantity + r.quantity);
    prev.note = `${prev.note}; + ${r.note}`;
  }
  return [...byKey.values()];
}

/**
 * CỘT TRÒN ambiguous trên bản KC — cột vẽ bằng CIRCLE/ARC (mặt cắt tròn) mà detector để
 * ambiguous (vòng tròn lớn: cột? cọc? móng? ký hiệu? — 0.35/0.30/0.20/0.15, không tự chốt).
 *
 * KHÔNG tự đo (đoán type = bịa) — chỉ đo khi QS XÁC NHẬN qua cờ `confirmed`. Khi đó:
 *   · ĐẾM theo TÂM, không theo cung: 1 cột tròn thường vẽ 2-3 cung ARC đồng tâm (đo thật:
 *     76 cung → 62 tâm). Đếm cung = phồng số cột. Gom cung cùng tâm (lưới nhỏ) → 1 cột,
 *     bán kính = cung LỚN NHẤT tại tâm đó.
 *   · Diện tích = πr² (KHÔNG phải bbox w×h = d² — thừa 4/π ≈ 27%). Chu vi = πd.
 *   · column_concrete = Σ πr² × H; column_formwork = Σ πd × H.
 *
 * Số là hình học THẬT; chỉ TYPE do QS khẳng định → note ghi rõ "QS xác nhận". PURE.
 */
/** Cột tròn ambiguous (CIRCLE/ARC, bbox ~vuông) — đối tượng roundColumnRows sẽ đo khi QS xác nhận. */
export function isRoundColumnSection(o: EngineDrawingObject): boolean {
  if (o.type !== 'column' || !o.ambiguous) return false;
  const rt = (o.rawType ?? '').toUpperCase();
  if (rt !== 'CIRCLE' && rt !== 'ARC') return false;
  const { w, h } = o.boundingBox;
  if (!(w > 0) || !(h > 0)) return false;
  const ratio = w / h;
  return ratio >= 0.7 && ratio <= 1.43; // bbox ~vuông = tiết diện tròn
}

export function roundColumnGroups(
  objects: EngineDrawingObject[],
  factor: number,
): { count: number; totalArea: number; totalPerimeter: number } {
  // Gom cung theo tâm (lưới ~ nửa cạnh cột nhỏ nhất; 200 đơn vị vẽ đủ tách 2 cột kề, gộp
  // cung đồng tâm). Giữ bán kính LỚN NHẤT mỗi tâm.
  const cellVU = 200;
  const byCenter = new Map<string, number>(); // tâm → r (đơn vị vẽ) lớn nhất
  for (const o of objects) {
    if (!isRoundColumnSection(o)) continue;
    const b = o.boundingBox;
    const cx = Math.round(((b.x ?? 0) + b.w / 2) / cellVU);
    const cy = Math.round(((b.y ?? 0) + b.h / 2) / cellVU);
    const r = Math.min(b.w, b.h) / 2;
    const k = `${cx},${cy}`;
    byCenter.set(k, Math.max(byCenter.get(k) ?? 0, r));
  }
  let totalArea = 0;
  let totalPerimeter = 0;
  for (const r of byCenter.values()) {
    const rm = r * factor;
    totalArea += Math.PI * rm * rm;
    totalPerimeter += 2 * Math.PI * rm;
  }
  return { count: byCenter.size, totalArea: round3(totalArea), totalPerimeter: round3(totalPerimeter) };
}

/** Sinh dòng BT + ván khuôn cột tròn — CHỈ khi QS xác nhận. PURE. */
export function roundColumnRows(
  objects: EngineDrawingObject[],
  factor: number,
  assumptions: TakeoffAssumptions,
  allowedKeys?: Set<TakeoffRowKey> | null,
): { rows: TakeoffEngineRow[]; count: number } {
  const g = roundColumnGroups(objects, factor);
  if (g.count === 0) return { rows: [], count: 0 };
  const H = assumptions.floorHeight;
  const allow = (k: TakeoffRowKey) => !allowedKeys || allowedKeys.has(k);
  const rows: TakeoffEngineRow[] = [];
  const mk = (key: TakeoffRowKey, unit: string, q: number, note: string) => {
    const quantity = round3(q);
    if (!allow(key) || quantity <= 0) return;
    rows.push({ key, group: 'column', boqGroup: BOQ_GROUP[key], code: '', name: DEFAULT_NAMES[key], unit, quantity, note, source: '—' });
  };
  const lead = `${g.count} cột tròn (QS xác nhận — gộp cung đồng tâm), Σπr²=${f3(g.totalArea)}m²`;
  mk('column_concrete', 'm3', g.totalArea * H, `${lead} × ${f3(H)}m cao = ${f3(round3(g.totalArea * H))} m³`);
  mk('column_formwork', 'm2', g.totalPerimeter * H, `${g.count} cột tròn, Σ chu vi ${f3(g.totalPerimeter)}m × ${f3(H)}m = ${f3(round3(g.totalPerimeter * H))} m²`);
  return { rows, count: g.count };
}

/** true nếu object là cấu kiện KC có tiết diện đủ lớn để đo (không phải ký hiệu). */
export function isRealSection(obj: EngineDrawingObject, factor: number): boolean {
  if (!SECTION_TYPES.has(obj.type)) return true;
  return Math.min(obj.boundingBox.w, obj.boundingBox.h) * factor >= MIN_SECTION_M;
}

/**
 * Cấu kiện KC (cột/dầm/móng/cọc) ĐÃ được detector nhận ra nhưng KHÔNG đo được — vì
 * `ambiguous` (vd vòng tròn radial: cột? cọc? ký hiệu? — không đoán) hoặc vẽ bằng nét
 * đơn (LINE, không có mặt cắt kín để lấy tiết diện). Gom theo type để BÁO RÕ cho QS,
 * KHÔNG lặng lẽ bỏ.
 *
 * Vì sao cần: đo thật trên "KC BENH XA": detector ra 76 cột, 38 dầm, 12 móng, 1116 thép
 * nhưng engine chỉ bóc được 1 dòng sàn — nếu chỉ báo "chưa nhận diện được" thì SAI sự
 * thật (đã nhận diện), và QS mất trắng thông tin 126 cấu kiện đã tìm thấy. PURE.
 */
export function unmeasuredSections(
  objects: EngineDrawingObject[],
  factor: number,
): { byType: Record<string, number>; total: number } {
  const byType: Record<string, number> = {};
  for (const o of objects) {
    if (!SECTION_TYPES.has(o.type)) continue;
    // Đã đo được (countable + tiết diện thật) → không tính vào "bỏ sót".
    if (isCountableObject(o) && isRealSection(o, factor)) continue;
    byType[o.type] = (byType[o.type] ?? 0) + 1;
  }
  return { byType, total: Object.values(byType).reduce((a, b) => a + b, 0) };
}

const TYPE_LABELS_VI: Record<string, string> = {
  wall: 'tường', column: 'cột', beam: 'dầm', door: 'cửa', window: 'cửa sổ',
  slab: 'sàn', footing: 'móng', hatch: 'hatch', text: 'text', block: 'block', pile: 'cọc',
  dimension: 'dimension', unknown: 'chưa phân loại',
};

/** Các loại đã bóc được (trực tiếp, qua hatch→sàn, hoặc opening/slab-typed). */
const TAKEN_TYPES = new Set<string>([...MEASURED_TYPES, 'hatch', 'opening', 'slab', 'pile']);

/**
 * Phụ lục CỐT THÉP (callout) — KHÔNG phải công tác, KHÔNG có kg. Bản KC thường vẽ
 * móng/dầm bằng nét đơn (không mặt cắt kín để đo hình học) nhưng LUÔN có callout Ø
 * trên bản vẽ — đây là nguồn thật QS dùng để bóc thép, không phải suy từ hình học.
 * `computeRebarWeight` cần CHIỀU DÀI (bảng thống kê thép hoặc QS xác nhận) nên
 * dừng ở mức đếm theo Ø — không bịa kg khi chưa có chiều dài.
 */
export function renderRebarSummary(agg: RebarTakeoff): string {
  if (agg.totalCallouts === 0) return '';
  const lines = agg.diameters.map((d) => {
    const parts: string[] = [];
    if (d.mainBarCount > 0) parts.push(`${d.mainBarCount} thanh chính đếm được`);
    if (d.stirrupCalloutCount > 0) {
      const sp = d.spacings.length ? ` (khoảng cách ${d.spacings.join('/')}mm)` : '';
      parts.push(`${d.stirrupCalloutCount} callout đai/phân bố${sp}`);
    }
    return `- Ø${d.diameter}: ${parts.join('; ')} — đơn trọng ${d.unitWeightKgM} kg/m`;
  });
  return [
    `PHỤ LỤC CỐT THÉP (từ callout bản vẽ, ${agg.totalCallouts} callout — KHÔNG có trong bảng công tác trên):`,
    ...lines,
    `⚠ ${agg.note}`,
  ].join('\n');
}

/**
 * 1 dòng thống kê (KHÔNG phải công tác) để user biết bản vẽ còn gì chưa bóc,
 * thay vì tưởng chỉ có mấy nhóm ít ỏi trong bảng.
 */
export function summarizeDetectedObjects(objects: EngineDrawingObject[], factor?: number): string {
  const counts: Record<string, number> = {};
  const symbolLike: Record<string, number> = {}; // cấu kiện KC nghi ký hiệu (tiết diện quá nhỏ)
  let ambiguous = 0;
  for (const o of objects) {
    if (o.ambiguous) { ambiguous += 1; continue; }
    counts[o.type] = (counts[o.type] ?? 0) + 1;
    if (factor != null && SECTION_TYPES.has(o.type) && !isRealSection(o, factor)) {
      symbolLike[o.type] = (symbolLike[o.type] ?? 0) + 1;
    }
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`);
  const notTaken = entries
    .filter(([t]) => !TAKEN_TYPES.has(t) && t !== 'ignored')
    .map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`);
  const suffix = notTaken.length
    ? ` Chưa bóc: ${notTaken.join(', ')} — cần khoanh vùng/gán loại thủ công.`
    : '';
  const symParts = Object.entries(symbolLike)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n}/${counts[t]} ${TYPE_LABELS_VI[t] ?? t}`);
  const symSuffix = symParts.length
    ? ` ${symParts.join(', ')} nghi KÝ HIỆU (tiết diện < ${MIN_SECTION_M * 100}cm) — KHÔNG đo khối lượng, cần khoanh vùng/gán mặt cắt thật.`
    : '';
  const ambSuffix = ambiguous ? ` ${ambiguous} đối tượng chưa chốt loại (không tính khối lượng).` : '';
  return `Đối tượng nhận diện: ${parts.join(', ')}.${suffix}${symSuffix}${ambSuffix}`;
}

/**
 * Đo đạc + công thức khối lượng cố định + gán mã định mức từ candidates.
 * factor = unitsPerDrawingUnit (vd bản vẽ mm → factor 0.001 → mét).
 */
export function computeTakeoffRows(
  objects: EngineDrawingObject[],
  factor: number,
  assumptions: TakeoffAssumptions,
  normCandidates: NormCandidateMap,
  /** Lọc theo bộ môn: chỉ sinh rowKey trong tập này. null/undefined = tất cả. */
  allowedKeys?: Set<TakeoffRowKey> | null,
): TakeoffEngineRow[] {
  // Ngoài MEASURED_TYPES, còn gom 'opening' (lỗ mở/cửa sổ) và 'slab' (sàn vẽ
  // dạng polygon) để có nhánh đo — tăng coverage cho type đã nhận diện.
  const AGG_TYPES = new Set<string>([...MEASURED_TYPES, 'opening', 'slab', 'footing', 'pile']);
  // Cửa/cửa sổ thường vẽ bằng BLOCK (INSERT) — dwg-insert-expand.ts khôi phục
  // kích thước thật, nhưng vẫn có thể dính DỮ LIỆU NGUỒN lỗi (block chứa 1
  // sub-block phần cứng — bản lề/tay nắm — mang toạ độ world tuyệt đối thay vì
  // cục bộ, xác nhận thật trên file "KT.dwg": 1/221 cửa phồng lên hàng km²).
  // Loại theo median (cùng pattern hatchSlabStats) — CHỈ 2 type dễ dính lỗi
  // này; không đụng wall/column/beam/footing/slab/pile (không qua block).
  const OUTLIER_PRONE_TYPES = new Set(['door', 'window']);
  const perType = new Map<string, { area: number; length: number; perimeter: number }[]>();
  for (const obj of objects) {
    if (!isCountableObject(obj)) continue;
    if (!AGG_TYPES.has(obj.type)) continue;
    if (!isRealSection(obj, factor)) continue; // ký hiệu, không phải tiết diện cấu kiện — không đo
    const m = measure(obj, factor);
    (perType.get(obj.type) ?? perType.set(obj.type, []).get(obj.type)!).push(m);
  }
  const totals = new Map<string, GroupTotals>();
  for (const [type, items] of perType) {
    let kept = items;
    let dropped = 0;
    if (OUTLIER_PRONE_TYPES.has(type) && items.length >= 3) {
      const areas = items.map((i) => i.area).filter((a) => a > 0).sort((a, b) => a - b);
      const median = areas[Math.floor(areas.length / 2)] ?? 0;
      if (median > 0) {
        kept = items.filter((i) => i.area <= median * 20);
        dropped = items.length - kept.length;
      }
    }
    const g: GroupTotals = { count: 0, length: 0, area: 0, perimeter: 0, outliersDropped: dropped || undefined };
    for (const m of kept) {
      g.count += 1;
      g.length += m.length;
      g.area += m.area;
      g.perimeter += m.perimeter;
    }
    totals.set(type, g);
  }

  const { floorHeight: H, wallThickness: T, beamDepth: D } = assumptions;
  const rows: TakeoffEngineRow[] = [];

  const push = (key: TakeoffRowKey, group: string, unit: string, quantity: number, formula: string) => {
    if (allowedKeys && !allowedKeys.has(key)) return;
    const q = round3(quantity);
    if (q <= 0) return;
    const cand = normCandidates[key];
    // Diễn giải = CHỈ công thức truy vết. KHÔNG gắn token `[nhóm:x]` (token máy, từng rò
    // ra cho QS đọc: "…= 132.182 m² [nhóm:wall]") — nhận diện dòng engine nay dùng id
    // `tk_engine_<drawingId>_<rowKey>`, xem planEngineTakeoffMerge.
    let note = formula;
    let code = '';
    let name = DEFAULT_NAMES[key];
    let source = '—';
    let webSourced: boolean | undefined;
    if (cand && cand.code && cand.webSource) {
      // Mã tra từ web: tên hiển thị LUÔN dùng tên chuẩn engine; tên web chỉ để đối
      // chiếu (ghi ngắn trong Nguồn). Nguồn "Web: …" — KHÔNG BAO GIỜ 'government'.
      code = cand.code;
      name = DEFAULT_NAMES[key];
      source = `Web: ${cand.webSource.title ?? cand.webSource.uri ?? 'nguồn web'}`;
      // ⚠ không lặp vào Diễn giải — đã có finding tổng + cột Nguồn "Web: …".
      webSourced = true;
    } else if (cand && cand.code) {
      // Mã DB: giữ tên DB nếu gọn, chuẩn hoá về tên engine nếu lộn xộn/viết hoa dài.
      code = cand.code;
      name = standardDisplayName(key, cand.name);
      source = cand.sourceDoc || 'định mức import';
    }
    // KHÔNG nhắc "cần chọn mã" trên TỪNG dòng: cột Mã hiệu trống đã nói điều đó, và đã có
    // finding gộp ("N công tác chưa chốt mã" + danh sách ứng viên). Lặp ở mọi dòng chỉ làm
    // cột Diễn giải dài gấp đôi và che mất công thức — thứ QS thật sự cần đọc.
    rows.push({ key, group, boqGroup: BOQ_GROUP[key], code, name, unit, quantity: q, note, source, ...(webSourced && { webSourced }) });
  };

  // RULE ENGINE: mỗi nhóm hình học chạy bảng công tác dẫn xuất (DERIVE_RULES).
  // Móng (đơn/băng/đài): chỉ chạy khi có diện tích mặt bằng — chiều cao giả định
  // công khai trong ghi chú. Cọc: chỉ chạy khi có mặt cắt KÍN (isRealSection chặn
  // nét đơn/ký hiệu) — chiều dài giả định công khai, giống móng.
  const resolved: ResolvedAssumptions = {
    H, T, D, W: ASSUMED_BEAM_WIDTH,
    FD: assumptions.footingDepth ?? DEFAULT_FOOTING_DEPTH,
    PL: assumptions.pileLength ?? DEFAULT_PILE_LENGTH,
  };
  for (const grp of DERIVE_GROUP_ORDER) {
    const t = totals.get(grp);
    if (!t) continue;
    if (grp === 'footing' && !(t.area > 0)) continue; // móng cần diện tích mặt bằng
    if (grp === 'pile' && !(t.area > 0)) continue; // cọc cần tiết diện mặt cắt kín
    for (const rule of DERIVE_RULES[grp]) {
      push(rule.key, rule.group, rule.unit, rule.qty(t, resolved), rule.note(t, resolved));
    }
  }

  // Cửa sổ + lỗ mở (opening): ĐẾM THEO CÁI, không suy m² — cùng lý do như cửa đi
  // (xem DERIVE.door), và ở cửa sổ còn rõ hơn: trên MẶT BẰNG cửa sổ là vệt mỏng cắt
  // ngang tường ⇒ bbox = bề rộng × BỀ DÀY TƯỜNG, không liên quan gì tới diện tích cửa
  // sổ. Đo thật "KT.dwg": 37 cửa sổ ra 18,08 m² = 0,49 m²/cái — vô nghĩa (cửa sổ thật
  // ~1,5-2 m²). Chiều cao cửa sổ + cao bệ chỉ có ở mặt đứng/bảng thống kê.
  const window = totals.get('window');
  const opening = totals.get('opening');
  const winCount = (window?.count ?? 0) + (opening?.count ?? 0);
  if (winCount > 0) {
    const openNote = opening?.count ? ` (gồm ${opening.count} lỗ mở)` : '';
    const dropNote = window?.outliersDropped ? ` (đã loại ${window.outliersDropped} block lỗi kích thước bất thường)` : '';
    // Diễn giải NGẮN — lý do không có m² nằm ở finding gộp, không nhét vào ô.
    push('window', 'window', 'cái', winCount, `đếm ${winCount} cửa sổ/lỗ mở${openNote}${dropNote}`);
  }

  // Sàn/nền: ưu tiên đo từ hatch (lọc outlier). Nếu không có hatch đủ tin cậy
  // nhưng có object type 'slab' (sàn vẽ dạng polygon) → dùng diện tích slab làm
  // nguồn thay thế. KHÔNG cộng cả hai để tránh đếm trùng cùng một mặt sàn.
  const hs = hatchSlabStats(objects, factor);
  const slabTyped = totals.get('slab');
  let slabArea = 0;
  let slabSrc = '';
  if (hs.used >= 1 && hs.area > 0) {
    slabArea = hs.area;
    slabSrc = `${hs.used} mảng hatch (bỏ ${hs.dropped} ngoài ngưỡng ${HATCH_MIN_AREA}m²–${HATCH_MAX_SHARE * 100}%)`;
  } else if (slabTyped && slabTyped.area > 0) {
    slabArea = round3(slabTyped.area);
    slabSrc = `${slabTyped.count} polygon sàn (type=slab)`;
  }
  if (slabArea > 0) {
    // Hai dòng bản chất khác nhau → diễn giải RIÊNG, không lặp nguyên văn.
    push('slab', 'slab', 'm2', slabArea, `Diện tích sàn từ ${slabSrc} = ${f3(slabArea)} m² (BT sàn/mái)`);
    push('floor_screed', 'slab', 'm2', slabArea, `cán nền theo diện tích sàn = ${f3(slabArea)} m²`);
    push('floor_finish', 'slab', 'm2', slabArea, `Lát nền theo diện tích sàn (${slabSrc}) = ${f3(slabArea)} m²`);
    // Trần + sơn trần: diện tích trần ≈ diện tích sàn (suy ra, cần đối chiếu).
    push('ceiling', 'slab', 'm2', slabArea, `trần theo diện tích sàn = ${f3(slabArea)} m²`);
    push('ceiling_paint', 'slab', 'm2', slabArea, `sơn trần theo diện tích trần = ${f3(slabArea)} m²`);
  }

  // Sắp theo nhóm BOQ (thô → hoàn thiện → khác) để reducer/sheet hiển thị header
  // phân nhóm; trong nhóm giữ nguyên thứ tự phát sinh (ổn định để STT phân cấp).
  rows.sort((x, y) => BOQ_GROUP_ORDER.indexOf(x.boqGroup) - BOQ_GROUP_ORDER.indexOf(y.boqGroup));

  return rows;
}

/** Bảng markdown 9 cột chuẩn: STT/Mã hiệu/Tên công tác/Đơn vị/Khối lượng/Đơn giá/Thành tiền/Nguồn/Diễn giải. */
export function rowsToMarkdownTable(rows: TakeoffEngineRow[]): string {
  // Hiện Đơn giá/Thành tiền/Nguồn: có giá thì show (từ price_set tỉnh hoặc web grounded),
  // TRỐNG (—) khi chưa có giá — KHÔNG bịa. Nguồn để QS truy vết tới công bố giá.
  const vnd = (n?: number) => (n != null ? Math.round(n).toLocaleString('vi-VN') : '—');
  const lines = [
    '| STT | Mã hiệu | Tên công tác | Nhóm đối tượng | Đơn vị | Khối lượng | Đơn giá | Thành tiền | Nguồn | Diễn giải |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  rows.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.code} | ${r.name} | ${OBJECT_GROUP_LABEL[r.group] ?? r.group} | ${r.unit} | ${r.quantity} | ${vnd(r.unitPrice)} | ${vnd(r.totalPrice)} | ${r.source ?? '—'} | ${r.note} |`,
    );
  });
  return lines.join('\n');
}

/** 1 dòng chú thích giả định (gom về cuối bảng — không lặp mỗi dòng). */
/**
 * SANITY QS: số engine tự sinh phải qua nổi kiểm tra vật lý sơ đẳng TRƯỚC khi
 * đưa cho QS. Cửa + cửa sổ KHÔNG THỂ chiếm diện tích lớn hơn sàn của chính công
 * trình đó — vượt = gần như chắc chắn ĐẾM TRÙNG, vì file DWG thực tế đặt mặt
 * bằng + mặt đứng + bảng thống kê cửa CÙNG một model space, nên 1 cửa vật lý
 * xuất hiện (và bị đếm) nhiều lần.
 *
 * Xác nhận thật trên "F550-BENH XA LD - Thdinh.dwg": cửa 405 m² > sàn 314 m²
 * (median mỗi cửa 0.90×2.20m = 1.98 m² — kích thước cửa THẬT, nên lỗi nằm ở SỐ
 * LƯỢNG đếm trùng, không phải ở phép đo).
 *
 * KHÔNG tự sửa số: engine không biết cửa nào là bản trùng → sửa = đoán. Chỉ cảnh
 * báo + chỉ đúng cách khắc phục (Bóc trong vùng). "Thà thiếu còn hơn sai" —
 * nhưng số SAI đã lỡ sinh ra thì tối thiểu phải tự tố cáo, không im lặng.
 */
const qtyOfRow = (rows: TakeoffEngineRow[], key: TakeoffRowKey) =>
  rows.find((r) => r.key === key)?.quantity ?? 0;

/**
 * Diện tích sàn công trình suy từ rows. KHÔNG chỉ tra 'slab': bản KT bị
 * DISCIPLINE_ROWKEYS lọc mất 'slab' (đó là rowKey của KC) nên sàn xuất hiện dưới
 * dạng floor_screed/floor_finish/ceiling — tất cả cùng suy từ MỘT diện tích hatch.
 * Lấy MAX để chạy đúng trên CẢ bản KT lẫn KC (chỉ tra 'slab' → bản KT luôn = 0 →
 * im lặng, đúng ca F550 thật đã bỏ sót).
 */
function floorAreaOf(rows: TakeoffEngineRow[]): number {
  return Math.max(
    qtyOfRow(rows, 'slab'),
    qtyOfRow(rows, 'floor_screed'),
    qtyOfRow(rows, 'floor_finish'),
    qtyOfRow(rows, 'ceiling'),
  );
}

export function openingVsFloorFinding(
  rows: TakeoffEngineRow[],
  clusters?: number,
): ValidationFinding | null {
  const qtyOf = (key: TakeoffRowKey) => qtyOfRow(rows, key);
  const opening = qtyOf('door') + qtyOf('window');
  const floor = floorAreaOf(rows);
  if (floor <= 0 || opening <= floor) return null;
  const clusterHint =
    clusters && clusters >= 2
      ? ` Model space có ~${clusters} cụm bản vẽ — nhiều khả năng cửa bị đếm ở CẢ mặt bằng lẫn mặt đứng/bảng thống kê.`
      : '';
  return {
    id: 'takeoff-engine-opening-gt-floor',
    severity: 'warn',
    area: 'quantity',
    title: `Diện tích cửa/cửa sổ (${f3(opening)} m²) VƯỢT diện tích sàn (${f3(floor)} m²) — số không hợp lý`,
    detail:
      `Công trình không thể có cửa nhiều hơn sàn → gần như chắc chắn ĐẾM TRÙNG.${clusterHint}` +
      ` Khắc phục: dùng "Bóc trong vùng" — kéo chọn riêng phần mặt bằng rồi bóc lại.` +
      ` Engine KHÔNG tự loại dòng trùng (không xác định được cái nào là bản sao) — cần QS khoanh vùng.`,
  };
}

/**
 * SANITY QS (chiều NGƯỢC LẠI với openingVsFloorFinding): tường quá THIẾU.
 *
 * Giới hạn vật lý: hình bao diện tích A nhỏ nhất có thể là HÌNH TRÒN → chu vi tối
 * thiểu tuyệt đối = 2√(πA). Không hình dạng nào bao được A m² với chu vi nhỏ hơn.
 * Tường ngắn hơn ngưỡng này = KHÔNG THỂ bao nổi công trình → chắc chắn thiếu.
 * (Nhà thật là đa giác + có tường ngăn trong → thực tế còn dài hơn nhiều; dùng
 * chu vi hình tròn làm ngưỡng để KHÔNG báo động giả.)
 *
 * Xác nhận thật trên "F550-BENH XA LD - Thdinh.dwg": tường 40.1m / sàn 314.7 m²
 * (min tròn = 62.9m, min vuông = 71.0m) → bất khả thi. Gốc: tường thật nằm trên
 * layer "5- Cắt tường" (445 entity) nhưng detector không match layer có DẤU tiếng
 * Việt; chỉ layer "Tuong" (18 entity) lọt qua.
 *
 * KHÔNG tự bịa thêm tường — chỉ tố cáo số thiếu và chỉ đúng chỗ cần sửa.
 */
export function wallVsFloorFinding(rows: TakeoffEngineRow[]): ValidationFinding | null {
  // wall_area = length × H → suy ngược ra chiều dài tường thực đo.
  const wallArea = qtyOfRow(rows, 'wall_area');
  const skirting = qtyOfRow(rows, 'skirting'); // = chiều dài tường (cùng nguồn t.length)
  const wallLen = skirting > 0 ? skirting : 0;
  const floor = floorAreaOf(rows);
  if (floor <= 0 || wallLen <= 0) return null; // không đo được tường → checklist QS lo, không đoán
  const minPerimeter = 2 * Math.sqrt(Math.PI * floor); // chu vi hình tròn — chặn dưới tuyệt đối
  if (wallLen >= minPerimeter) return null;
  return {
    id: 'takeoff-engine-wall-lt-perimeter',
    severity: 'warn',
    area: 'quantity',
    title: `Tường (${f3(wallLen)}m) KHÔNG ĐỦ bao sàn ${f3(floor)} m² — tối thiểu ${f3(round3(minPerimeter))}m`,
    detail:
      `Không hình dạng nào bao được ${f3(floor)} m² bằng ${f3(wallLen)}m tường (chu vi nhỏ nhất khả dĩ = ` +
      `${f3(round3(minPerimeter))}m, chưa kể tường ngăn trong) → tường đang bị BỎ SÓT, mọi số liên quan ` +
      `(xây/trát/sơn/len chân tường${wallArea > 0 ? ` — hiện ${f3(wallArea)} m²` : ''}) đều thiếu theo.` +
      ` Nguyên nhân thường gặp: layer tường đặt tên không chuẩn nên không nhận ra được.` +
      ` Khắc phục: gán layer rule cho đúng layer tường, rồi bóc lại. Engine KHÔNG suy thêm tường (sẽ là số bịa).`,
  };
}

/**
 * Điểm tin cậy + finding khi bóc ra 0 DÒNG.
 *
 * BUG ĐÃ XÁC NHẬN TRÊN PRODUCTION: thang điểm cũ
 *   `missingCode>0 ? 55 : softCode>0 ? 70 : missingPrice>0 ? 75 : 90`
 * KHÔNG có mệnh đề nào kiểm `rows.length === 0` → bản DIEN bóc **0 dòng** rơi thẳng
 * xuống nhánh cuối = **90 điểm / "reasonable"**, trong khi bản KT bóc 13 dòng thật
 * = 70. Tức CÀNG BÓC ĐƯỢC ÍT CÀNG ĐÁNG TIN — QS nhìn 90 tưởng sạch lỗi, thực ra
 * chẳng có gì. Rỗng KHÔNG BAO GIỜ là "đáng tin"; nó là "chưa làm được việc".
 *
 * Trả null khi có dòng → caller dùng thang điểm thường.
 */
export function emptyResultVerdict(
  rowCount: number,
  ctx: { objectCount: number; discipline?: string; disciplineSupported: boolean },
): { score: number; finding: ValidationFinding } | null {
  if (rowCount > 0) return null;
  const disc = ctx.discipline || 'chưa gắn';
  // Phân biệt 2 ca RẤT khác nhau — gộp chung sẽ chỉ sai chỗ cho QS:
  const detail = !ctx.disciplineSupported
    ? `Bộ môn "${disc}" chưa có nhóm công tác nào trong engine (DISCIPLINE_ROWKEYS rỗng) — bản vẽ có ` +
      `${ctx.objectCount} đối tượng nhưng engine CHƯA biết bóc gì cho bộ môn này. Đây KHÔNG phải bản vẽ ` +
      `sạch lỗi, mà là tính năng chưa có. Khối lượng bộ môn này phải bóc thủ công.`
    : `Engine không nhận ra cấu kiện nào đo được trong ${ctx.objectCount} đối tượng của bản vẽ — có thể ` +
      `layer đặt tên không chuẩn, hoặc bản vẽ chỉ có nét/ghi chú. Khắc phục: gán layer rule cho đúng ` +
      `layer cấu kiện, hoặc khoanh vùng rồi bóc lại.`;
  return {
    score: 30,
    finding: {
      id: 'takeoff-engine-empty',
      severity: 'warn',
      area: 'missing',
      title: `Không bóc được dòng nào — KHÔNG dùng được (bộ môn: ${disc})`,
      detail,
    },
  };
}

/**
 * Dòng BOQ cho MEP — khối lượng do `mep-takeoff.ts` tính (module PURE đã hoàn chỉnh
 * từ trước: đếm thiết bị / đo chiều dài tuyến). Engine chỉ ĐÓNG GÓI lại thành
 * TakeoffEngineRow, KHÔNG tự tính lại, KHÔNG tự đặt tên/đơn vị (dùng `MEP_LABEL`/
 * `MEP_UNIT` sẵn có).
 *
 * KHÔNG có mã, KHÔNG có giá: chưa có định mức/đơn giá MEP trong DB → để trống + để
 * finding "thiếu mã" sẵn có lo. Thà thiếu còn hơn bịa.
 * PURE (nhận objects đã lọc) để test không cần Mongo.
 */
export function computeMepRows(
  objects: { type: string; geometry?: number[][]; ambiguous?: boolean }[],
  factor: number,
  allowedKeys?: Set<TakeoffRowKey> | null,
): TakeoffEngineRow[] {
  return mepTakeoff(objects, factor)
    .map((m) => {
      const key = mepRowKeyOf(m.type);
      if (allowedKeys && !allowedKeys.has(key)) return null;
      const q = round3(m.quantity);
      if (q <= 0) return null;
      const how =
        m.kind === 'count'
          ? `đếm ${m.quantity} ${m.unit} từ block/thiết bị nhận diện trên layer MEP`
          : `tổng chiều dài tuyến = ${f3(q)} ${m.unit} (đo polyline × tỉ lệ)`;
      return {
        key,
        group: m.type,
        boqGroup: BOQ_GROUP_MEP,
        code: '',
        name: m.label,
        unit: m.unit,
        quantity: q,
        note: how,
        source: '—',
      } as TakeoffEngineRow;
    })
    .filter((r): r is TakeoffEngineRow => r !== null);
}

export function assumptionFootnote(a: TakeoffAssumptions): string {
  return `Thông số áp dụng (người dùng xác nhận khi bóc): cao tầng ${a.floorHeight}m · dày tường ${a.wallThickness}m · sâu dầm ${a.beamDepth}m · bề rộng dầm ${ASSUMED_BEAM_WIDTH}m`;
}

// ===== NestJS service (Mongo + proposal assembly) =====

export interface TakeoffEngineInput {
  drawingId: string;
  unitsPerDrawingUnit: number;
  assumptions: TakeoffAssumptions;
  rejectedObjectIds?: string[];
  /** Vùng bóc (world coords): chỉ đo đối tượng có tâm bbox nằm trong vùng. */
  region?: { x: number; y: number; w: number; h: number };
  /** Edit bật → dòng vẫn thiếu mã sau web lookup được gán mã phổ thông mặc định. */
  editPermission?: boolean;
  /** QS xác nhận vòng tròn ambiguous trên bản KC LÀ cột tròn → đo πr²×H (xem roundColumnRows). */
  confirmRoundColumns?: boolean;
  /** Nhãn vùng do FE đặt ("Cụm 1", "Tầng 1"…) — lưu vào dòng, hiện cột "Khu vực". */
  regionLabel?: string;
}

@Injectable()
export class TakeoffEngineService {
  constructor(
    @InjectModel(DrawingObject.name) private readonly drawingObjectModel: Model<DrawingObjectDocument>,
    @InjectModel(Drawing.name) private readonly drawingModel: Model<DrawingDocument>,
    @InjectModel(NormItem.name) private readonly normModel: Model<NormItem>,
    private readonly estimates: EstimateService,
    private readonly catalog: CatalogService,
    private readonly webLookup: NormWebLookupService,
    private readonly priceWeb: PriceWebLookupService,
    /** Đơn giá tỉnh THẬT (unit_prices) — nguồn mã + giá trọn gói có sourceDoc. */
    private readonly unitPrices: UnitPriceService,
  ) {}

  /**
   * RÀO DUY NHẤT cho MỌI nguồn mã (mã phổ thông hardcode, mã LLM tra web, sau này là
   * mã agent gán): một mã chỉ dùng được khi ĐỦ CẢ HAI —
   *   (a) TỒN TẠI trong sách đơn giá thật của tỉnh (`unit_prices`), và
   *   (b) TÊN của mã đó KHỚP NGHĨA với công tác đang bóc.
   *
   * (a) một mình là KHÔNG ĐỦ — bài học đo được trên production: mã phổ thông
   * `AK.57110` CÓ tồn tại trong bộ Đơn giá Hà Nội nhưng tên thật là "Bó vỉa hè,
   * đường bằng tấm bê tông đúc sẵn", trong khi engine dán nhãn "Ốp/len chân tường"
   * → hiện ra "Ốp/len chân tường — 74.248đ — TT 13/2021/TT-BXD": mã sai + giá thật +
   * nguồn chính thống = SAI MỘT CÁCH TỰ TIN, tệ hơn hẳn để trống. Tương tự
   * `AK.98110` ("Loại đá Dmax ≤ 4") bị dán nhãn "Cán nền vữa xi măng".
   *
   * (b) cũng chặn luôn mã LLM tự chế: `AE.00000`, `AH.30000` (dùng chung cho cả cửa
   * đi lẫn cửa sổ) — 4/5 mã web đo được KHÔNG tồn tại trong sách.
   *
   * Không tra được sách của tỉnh (chưa import) → trả null: KHÔNG cho mã đi tiếp vô
   * điều kiện. Thà thiếu còn hơn sai.
   */
  private async verifyCodeInBook(
    code: string,
    expectedWorkName: string,
    province?: string,
  ): Promise<{ ok: true; hit: UnitPrice } | { ok: false; reason: 'not_in_book' | 'name_mismatch'; actualName?: string }> {
    const hit = await this.unitPrices.byCode(code, province).catch(() => null);
    if (!hit) return { ok: false, reason: 'not_in_book' };
    // Ngưỡng >0: nameMatchScore trả 0 khi không có ≥2 từ khoá chung và không chứa
    // nhau — đã kiểm trên đúng các ca thật ở trên (bó vỉa/cốt liệu đá → 0 → loại;
    // "Ván khuôn cột" ↔ "VÁN KHUÔN CỘT vuông" → 103 → giữ). Thiên về thận trọng.
    if (nameMatchScore(expectedWorkName, hit.name) <= 0) {
      return { ok: false, reason: 'name_mismatch', actualName: hit.name };
    }
    return { ok: true, hit };
  }

  /** Tra norm_items theo keyword — KHÔNG hardcode mã; không có DB match → undefined. */
  /**
   * Tra định mức theo MÃ CHÍNH XÁC (mã QS đã chốt / mã web đã qua `verifyCodeInBook`).
   *
   * ⚠ ĐÃ BỎ đường tra theo TÊN (`NORM_KEYWORDS` + `$regex` trên `name`). Lý do đã đo
   * trên chính 4305 dòng đơn giá Hà Nội: khớp tên tiếng Việt SAI NGỮ NGHĨA —
   * `"bê tông cột"` → `"Thi công cọc tiêu bê tông cốt thép, cột km"` (cọc tiêu đường bộ),
   * `"sơn tường"` → `"Miết mạch tường đá"`. Trước đây vô hại vì `norm_items` RỖNG nên
   * luôn trả undefined; nạp định mức vào là nó bắt đầu tự gán mã sai kèm hao phí thật —
   * sai một cách rất chính thống. Mã do QS chốt từ `NORM_FAMILIES` (đúng họ), engine
   * chỉ tra HAO PHÍ của mã đó. Không có mã → không có định mức, để trống.
   */
  private async normComponentsByCode(codes: string[]): Promise<Map<string, NormCandidate>> {
    const out = new Map<string, NormCandidate>();
    const uniq = [...new Set(codes.filter((c) => c?.trim()))];
    if (uniq.length === 0) return out;
    const hits = await this.normModel.find({ code: { $in: uniq } }).lean();
    for (const hit of hits) {
      out.set(hit.code, {
        code: hit.code,
        name: hit.name,
        unit: hit.unit,
        sourceDoc: hit.sourceDoc,
        components: (hit.components ?? []) as NormComponent[],
      });
    }
    return out;
  }

  async run(userId: string, estimateId: string, input: TakeoffEngineInput) {
    const doc = await this.estimates.getOwned(userId, estimateId);
    const state: EstimateState = this.estimates.stateForPrompt(doc);

    // Bộ môn của bản vẽ đang bóc → lọc rowKey; và tập bộ môn đã có trong
    // estimate → checklist phản ánh đúng cái còn thiếu thật.
    const drawingDoc = await this.drawingModel.findById(input.drawingId).select('discipline').lean();
    const discipline = drawingDoc?.discipline;
    const allowedKeys = rowKeysForDiscipline(discipline);
    const estDrawings = await this.drawingModel.find({ estimateId }).select('discipline name').lean();
    // TRUY VẾT: dòng khối lượng ← bản vẽ nào. id takeoff đã mang drawingId
    // (`tk_engine_<drawingId>_<rowKey>`) nên chỉ cần map id → tên.
    const drawingNameById = new Map<string, string>(
      estDrawings.map((d) => [String((d as any)._id), String((d as any).name ?? '')]),
    );
    const existingDisciplines = new Set(estDrawings.map((d) => d.discipline).filter(Boolean) as string[]);

    const rejected = new Set(input.rejectedObjectIds ?? []);
    const rawObjects = await this.drawingObjectModel.find({ drawingId: input.drawingId }).lean();
    if (rawObjects.length === 0) throw new NotFoundException('Bản vẽ chưa có đối tượng nhận diện');
    let objects = rawObjects.filter(
      (o) => !rejected.has(String((o as any)._id)) && !rejected.has(o.stableId),
    );

    // Bóc theo vùng: file DWG thực tế chứa nhiều bản vẽ con (mặt bằng các
    // tầng, mặt đứng, chi tiết) trong cùng model space — đo tất sẽ phồng khối
    // lượng. Chỉ giữ đối tượng có TÂM bbox nằm trong vùng user kéo chọn.
    const regionTotal = objects.length;
    let regionKept: number | null = null;
    if (input.region) {
      const r = input.region;
      objects = objects.filter((o) => {
        const b = (o as any).boundingBox ?? {};
        const cx = Number(b.x ?? 0) + Number(b.w ?? 0) / 2;
        const cy = Number(b.y ?? 0) + Number(b.h ?? 0) / 2;
        return (
          isFinite(cx) && isFinite(cy) &&
          cx >= r.x && cx <= r.x + r.w &&
          cy >= r.y && cy <= r.y + r.h
        );
      });
      regionKept = objects.length;
      if (objects.length === 0) {
        throw new BadRequestException(
          'Vùng bóc đã chọn không chứa đối tượng nào — kéo chọn lại vùng bao quanh phần bản vẽ cần bóc, hoặc xoá vùng để bóc toàn bộ.',
        );
      }
    }

    // Sanity guard: với factor đã cho, kích thước tổng thể công trình phải nằm
    // trong 2m–5km. Factor sai (calibration rác, header khai láo) → tự thử
    // mm/m/inch; có factor hợp lý → dùng + cảnh báo; không có → từ chối tính
    // thay vì nhả ra "119 km tường".
    let factor = input.unitsPerDrawingUnit;
    let factorOverridden = false;
    {
      // Robust span: only the object types we actually measure, with
      // median+MAD outlier rejection — DWG files routinely contain stray
      // hatches/dimensions parked hundreds of km from the building, which
      // would otherwise inflate the span and wrongly reject a good factor.
      const measured = objects.filter((o: any) =>
        (MEASURED_TYPES as readonly string[]).includes(o.type),
      );
      const pool = measured.length >= 4 ? measured : objects;
      const centers = pool
        .map((o: any) => {
          const b = o.boundingBox ?? {};
          return {
            cx: Number(b.x ?? 0) + Number(b.w ?? 0) / 2,
            cy: Number(b.y ?? 0) + Number(b.h ?? 0) / 2,
          };
        })
        .filter((c) => isFinite(c.cx) && isFinite(c.cy));
      const median = (vals: number[]) => {
        const s = [...vals].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)] ?? 0;
      };
      const mx = median(centers.map((c) => c.cx));
      const my = median(centers.map((c) => c.cy));
      const mad =
        median(centers.map((c) => Math.max(Math.abs(c.cx - mx), Math.abs(c.cy - my)))) || 1;
      const kept = centers.filter(
        (c) => Math.abs(c.cx - mx) <= 12 * mad && Math.abs(c.cy - my) <= 12 * mad,
      );
      const use = kept.length >= centers.length * 0.5 ? kept : centers;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of use) {
        if (c.cx < minX) minX = c.cx;
        if (c.cx > maxX) maxX = c.cx;
        if (c.cy < minY) minY = c.cy;
        if (c.cy > maxY) maxY = c.cy;
      }
      const span = Math.max(maxX - minX, maxY - minY);
      const plausible = (f: number) => span * f >= 2 && span * f <= 5000;
      if (isFinite(span) && span > 0 && !plausible(factor)) {
        // mm, m, cm, inch, ft — thứ tự phổ biến với bản vẽ VN
        const guess = [0.001, 1, 0.01, 0.0254, 0.3048].find(plausible);
        if (guess != null) {
          factor = guess;
          factorOverridden = true;
        } else {
          throw new BadRequestException(
            `Tỉ lệ bản vẽ không hợp lý (kích thước tổng thể ra ${(span * factor).toFixed(0)}m). Hiệu chỉnh 2 điểm trên một đoạn đã biết kích thước rồi bóc lại.`,
          );
        }
      }
    }
    input = { ...input, unitsPerDrawingUnit: factor };

    // ===== CHỌN CỤM (chặn trước khi cộng dồn) =====
    //
    // File DWG dân dụng đặt nhiều bản vẽ con trong 1 model space. "Bóc toàn bộ" cộng hết
    // các cụm lại → số phồng. Trước đây engine chỉ CẢNH BÁO rồi vẫn xuất số tổng ra
    // Workbook; QS apply nhầm là hỏng bảng. Nay: nhiều cụm mà chưa chọn vùng ⇒ KHÔNG sinh
    // action nào, trả preview từng cụm kèm `region` để chọn rồi bóc lại.
    //
    // Chặn ở ĐÂY (ngay sau khi chốt factor, trước norm/web/price lookup) vì preview không
    // cần mã cũng không cần giá — chạy tiếp sẽ đốt quota grounding cho một kết quả sắp bị
    // vứt đi.
    const preClusters = input.region
      ? { clusters: [] as ObjectCluster[], spanM: 0 }
      : objectClusters(objects as unknown as EngineDrawingObject[], factor);
    if (!input.region && preClusters.clusters.length >= 2) {
      const previews = clusterPreviews(
        objects as unknown as EngineDrawingObject[],
        preClusters.clusters,
        factor,
        input.assumptions,
        allowedKeys,
      );
      // V6: KHÔNG lọc theo "lines rỗng" — cụm cột tròn/cấu kiện chờ xác nhận có preview lines
      // rỗng nhưng VẪN có ý nghĩa (QS confirm để đo). Sau V1/V2 các cụm rỗng thật (do cấu kiện
      // giả) đã hết, nên lọc thêm dễ ẩn nhầm hơn là lợi.
      return {
        needsClusterPick: true,
        clusters: previews,
        clusterCount: preClusters.clusters.length,
        spanM: Math.round(preClusters.spanM),
        // Không action nào: số tổng của nhiều cụm KHÔNG được phép chạm Workbook.
        actions: [] as Action[],
        message: [
          `Bản vẽ này có ${preClusters.clusters.length} cụm trong model space (trải ~${Math.round(preClusters.spanM)}m) — thường là mặt bằng các tầng, mặt đứng và chi tiết đặt cạnh nhau.`,
          `Bóc gộp tất cả sẽ cộng dồn thành số vô nghĩa, nên CHƯA ghi gì vào Workbook. Chọn cụm cần bóc rồi bóc lại:`,
          '',
          describeClusters(preClusters.clusters, factor),
          '',
          `Khối lượng nếu bóc riêng từng cụm (hình học thuần, chưa tra mã/giá):`,
          ...previews.map((p) =>
            `· Cụm ${p.id} (~${p.widthM}×${p.heightM}m): ` +
            (p.lines.length
              ? p.lines.map((l) => `${l.name} ${l.quantity} ${l.unit}`).join(' · ')
              : 'không đo được dòng nào'),
          ),
        ].join('\n'),
        thinking: [
          `Đọc ${objects.length} đối tượng, gom được ${preClusters.clusters.length} cụm rời nhau (eps 25m).`,
          `Bóc thử riêng từng cụm để so sánh — chưa tra mã, chưa tra giá, chưa sinh action.`,
        ],
        sources: [],
        trace: [],
        preview: { counts: [], costBefore: 0, costAfter: 0, costDelta: 0, diffs: [] },
        validation: {
          status: 'warning' as const,
          score: 50,
          findings: [
            {
              id: 'takeoff-engine-cluster-pick',
              severity: 'warn' as const,
              area: 'missing' as const,
              title: `Cần chọn cụm bản vẽ (${preClusters.clusters.length} cụm)`,
              detail:
                `Model space chứa ${preClusters.clusters.length} cụm rời nhau. Engine không đoán cụm nào là mặt bằng cần bóc — ` +
                `chọn 1 cụm (hoặc kéo vùng thủ công) rồi bóc lại. Chưa có dòng nào được ghi.`,
            },
          ],
          consistency: [],
        },
      };
    }

    // Bắt đầu RỖNG: engine KHÔNG tự chọn mã. Mã chỉ đến từ (a) web lookup đã qua
    // `verifyCodeInBook`, hoặc (b) QS chốt từ gợi ý `NORM_FAMILIES`. Hao phí định mức
    // tra sau, theo MÃ CHÍNH XÁC (xem normComponentsByCode).
    const normCandidates: NormCandidateMap = {};

    // ĐƠN GIÁ TỈNH (unit_prices) — nguồn mã + giá THẬT, có sourceDoc (vd TT 13/2021).
    // Chỉ nhận mã phổ thông khi mã đó TỒN TẠI THẬT trong bộ đơn giá của tỉnh; khi đó
    // lấy luôn giá trọn gói. Mã không có thật trong sách đơn giá nào = mã bịa → BỎ.
    //
    // Vì sao không tự tra theo TÊN rồi gán: đã đo trên production, `$text` tiếng Việt
    // sai ngữ nghĩa (query "sơn tường" → "Miết mạch tường đá"; "bê tông cột" → "cọc
    // tiêu bê tông... cột km"). Auto-gán = mã SAI + giá THẬT + nguồn TT 13/2021 trông
    // rất chính thống = sai một cách tự tin, tệ hơn hẳn để trống. Nên: chỉ GỢI Ý
    // ứng viên cho QS/agent chốt (suggestions), engine KHÔNG tự chọn.
    /** Mã web bị LOẠI vì không có trong sách đơn giá (LLM tự chế, vd AE.00000). */
    const rejectedWebCodes: string[] = [];
    const suggestions = new Map<TakeoffRowKey, UnitPriceSuggestion[]>();
    const province = state.projectInfo?.location;
    if (input.editPermission) {
      const probe = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates, allowedKeys);
      for (const r of probe.filter((row) => !row.code)) {
        // KHÔNG auto-gán mã. Một họ có tới 48 biến thể chỉ khác mác bê tông/tiết diện —
        // thông số nằm ở thuyết minh, không có trong hình học ⇒ máy chọn = đoán (xem
        // NORM_FAMILIES). Thay vào đó thu hẹp về ĐÚNG HỌ rồi để QS chốt biến thể.
        const fam = NORM_FAMILIES[r.key];
        const found = fam
          ? (
              await Promise.all(
                // `search()` đã tự nhận prefix mã hiệu (`^[A-Z]{2}\.\d`) → lọc theo mã,
                // KHÔNG dùng $text theo tên (đã đo: sai ngữ nghĩa).
                fam.prefixes.map((p) => this.unitPrices.search(p, province, 6).catch(() => [])),
              )
            ).flat()
          : [];
        if (found.length > 0) {
          suggestions.set(
            r.key,
            found.map((u) => ({ code: u.code, name: u.name, unit: u.unit, unitPrice: u.unitPrice, sourceDoc: u.sourceDoc })),
          );
        }
      }
    }

    // Tầng web: CHỈ tra cho dòng VẪN thiếu mã sau DB → grounded search, chống bịa 3
    // rào. Tránh đốt quota.
    let webLookedUp = 0;
    let webHitCount = 0;
    if (this.webLookup.enabled) {
      const probe = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates, allowedKeys);
      const missingKeys = probe.filter((r) => !r.code).map((r) => r.key);
      if (missingKeys.length > 0) {
        webLookedUp = missingKeys.length;
        const hits = await this.webLookup.lookupCodes(
          missingKeys.map((key) => ({ key, hintKey: key, workName: DEFAULT_NAMES[key].toLowerCase() })),
        );
        for (const key of missingKeys) {
          const hit = hits.get(key);
          if (!hit) continue;
          // Mã web phải QUA CÙNG RÀO như mã phổ thông. LLM chế mã rất giỏi trông thật:
          // đo trên production 4/5 mã web KHÔNG tồn tại trong sách đơn giá — `AE.00000`,
          // `AH.30000` (dùng CHUNG cho cả "Cửa đi" lẫn "Cửa sổ"), nguồn hiển thị lại là
          // "Web: phuckhanggroup.com" (trang doanh nghiệp) → càng dễ tin nhầm.
          const v = await this.verifyCodeInBook(hit.code, DEFAULT_NAMES[key], province);
          if (!v.ok) {
            rejectedWebCodes.push(`${hit.code} (${DEFAULT_NAMES[key]})`);
            continue; // KHÔNG cho mã web vào BOQ — để trống + ứng viên, QS chốt.
          }
          // Qua rào → mã đã được sách đơn giá xác nhận ⇒ nguồn là ĐƠN GIÁ TỈNH
          // (government), không phải trang web; và lấy luôn giá trọn gói.
          webHitCount++;
          normCandidates[key] = {
            code: v.hit.code,
            name: hit.name,
            unit: v.hit.unit ?? '',
            sourceDoc: v.hit.sourceDoc,
            directPrice: { unitPrice: v.hit.unitPrice, sourceDoc: v.hit.sourceDoc },
          };
        }
      }
    }

    // Hình học (KT/KC) + MEP (đếm thiết bị / đo tuyến). MEP đi đường riêng vì cách đo
    // khác hẳn: không suy từ bbox/hatch mà đếm block + đo polyline (mep-takeoff.ts).
    // Cấu kiện KC vẽ bằng nét đơn (netDAM/netMONG) — computeTakeoffRows bỏ qua vì ambiguous.
    // Tin theo TÊN LAYER: đo dầm nét đơn, đếm móng/cọc nét đơn để liệt kê (xem kcLinearRows).
    const kcLinear = kcLinearRows(objects as any, input.unitsPerDrawingUnit, input.assumptions, allowedKeys);
    // Cột tròn ambiguous: CHỈ đo khi QS xác nhận (confirmRoundColumns) — nếu không, để panel
    // "chưa đo được" liệt kê. Không tự đoán type.
    const roundCol = input.confirmRoundColumns
      ? roundColumnRows(objects as any, input.unitsPerDrawingUnit, input.assumptions, allowedKeys)
      : { rows: [] as TakeoffEngineRow[], count: 0 };
    const bareRows = mergeRowsByKey([
      ...computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates, allowedKeys),
      ...computeMepRows(objects as any, input.unitsPerDrawingUnit, allowedKeys),
      ...kcLinear.rows,
      ...roundCol.rows,
    ]);

    // Giá THẬT từ price_set tỉnh mới nhất khớp projectInfo.location — không có thì cột giá trống.
    const priceCtxRaw = await this.catalog
      .priceContextForLocation(state.projectInfo?.location)
      .catch(() => null);
    const priceCtx: PriceContextLite | null = priceCtxRaw
      ? {
          province: priceCtxRaw.set.province,
          sourceDoc: priceCtxRaw.set.sourceDoc || 'Công bố giá',
          effectiveDate: new Date(priceCtxRaw.set.effectiveDate).toISOString().slice(0, 10),
          prices: priceCtxRaw.prices.map((p) => ({ refCode: p.refCode, name: p.name, price: p.price })),
        }
      : null;
    // KHÔNG auto-fill giá từ unit_prices theo mã đoán (COMMON_FALLBACK_CODES) — mã
    // đơn giá tỉnh đánh số KHÁC, dễ gán nhầm (vd AF.61120 = thép chứ không phải BT móng).
    // Đơn giá tỉnh được dùng như NGUỒN TRA CỨU cho agent (referenceBlock) để chọn đúng
    // mã + giá có nguồn, KHÔNG điền tự động mù.
    let rows = applyPricingToRows(bareRows, normCandidates, priceCtx);

    // ── PHÂN TÍCH ĐƠN GIÁ (Unit Rate Analysis) ──────────────────────────────────────
    // Dòng ĐÃ CÓ MÃ → tra hao phí VL/NC/Máy trong `norm_items` theo MÃ CHÍNH XÁC (không
    // đoán theo tên). Trước khi dùng: đối chiếu MÁC giữa định mức và đơn giá tỉnh — hai
    // nguồn đang lệch 1 bậc trên họ AF.122 (xem macConflict). Lệch → KHÔNG sinh phân tích,
    // chỉ báo; thà thiếu còn hơn ra cấp phối sai kèm dấu TT12/2021.
    const codedRows = rows.filter((r) => r.code);
    const normByCode = await this.normComponentsByCode(codedRows.map((r) => r.code));
    /** Mã bị chặn vì định mức ↔ đơn giá tỉnh lệch mác. */
    const macConflicts: string[] = [];
    const analyses: { code: string; name: string; unit: string; components: NormComponent[] }[] = [];
    for (const r of codedRows) {
      const norm = normByCode.get(r.code);
      if (!norm?.components?.length) continue;
      const priceName = (await this.unitPrices.byCode(r.code, province).catch(() => null))?.name;
      const conflict = priceName ? macConflict(norm.name, priceName) : null;
      if (conflict) {
        macConflicts.push(`${r.code}: định mức M${conflict.normMac} ≠ đơn giá Mác ${conflict.priceMac}`);
        continue;
      }
      analyses.push({ code: r.code, name: norm.name, unit: norm.unit, components: norm.components as NormComponent[] });
    }

    // Tra ĐƠN GIÁ từ web cho các dòng CHƯA có giá tỉnh chính thống (grounded search,
    // chống bịa 3 rào, gắn cờ "cần kiểm chứng" + link nguồn). Chỉ khi Edit bật.
    let webPricedCount = 0;
    const webPriceHits: WebPriceHit[] = [];
    // Tra giá web (grounded, 3 rào chống bịa, gắn nguồn). BẬT mặc định; tắt qua env
    // PRICE_WEB=off nếu hết quota Gemini. Cần API key có billing để grounding ổn định.
    const PRICE_WEB_ON = process.env.PRICE_WEB !== 'off';
    if (PRICE_WEB_ON && input.editPermission && this.priceWeb.enabled) {
      const need = rows.filter((r) => r.code && r.unitPrice == null);
      if (need.length > 0) {
        // BATCH: 1 research + 1 extract cho TẤT CẢ công tác thiếu giá (2 call tổng)
        // → tránh 429 quota, điền được nhiều dòng cùng lúc.
        const hits = await this.priceWeb.lookupPricesBatch(
          need.map((r) => ({ key: r.key, workName: r.name, unit: r.unit })),
          state.projectInfo?.location,
        );
        rows = rows.map((r) => {
          const h = r.unitPrice == null ? hits.get(r.key) : null;
          if (h) {
            webPricedCount++;
            webPriceHits.push(h);
            return {
              ...r,
              unitPrice: h.unitPrice,
              totalPrice: Math.round(h.unitPrice * r.quantity),
              source: `${h.sourceTitle ? `Web: ${h.sourceTitle}` : 'Giá web'}${h.date ? ` (${h.date})` : ''} — cần kiểm chứng`,
              pricedFromWeb: true,
            };
          }
          return r;
        });
      }
    }

    // ===== TIER 2 — mượn giá CÙNG MÃ từ tỉnh khác =====
    // Dòng ĐÃ có mã hợp lệ nhưng tỉnh dự án chưa nạp giá → tra mã đó ở BẤT KỲ tỉnh nào trong
    // unit_prices. Giá vẫn có nguồn thật (sourceDoc), chỉ khác vùng → đánh dấu "giá tỉnh X,
    // KHÔNG phải tỉnh dự án — cần đối chiếu". Không nhân hệ số bịa (DB không có bảng CPI).
    let borrowedProvinceCount = 0;
    {
      const need = rows.filter((r) => r.code && r.unitPrice == null);
      if (need.length > 0) {
        const borrowed = await Promise.all(
          need.map(async (r) => {
            const hit = await this.unitPrices.byCode(r.code, undefined).catch(() => null);
            // Bỏ nếu chính là tỉnh dự án (đã thử ở Tier 1) hoặc lệch đơn vị không quy đổi được.
            if (!hit || (province && hit.province === province)) return null;
            const scale = unitPriceScale(hit.unit, r.unit);
            if (scale == null || !(hit.unitPrice > 0)) return null;
            return { key: r.key, unitPrice: Math.round(hit.unitPrice * scale), prov: hit.province, doc: hit.sourceDoc };
          }),
        );
        const byKey = new Map(borrowed.filter(Boolean).map((b) => [b!.key, b!]));
        rows = rows.map((r) => {
          const b = r.unitPrice == null ? byKey.get(r.key) : undefined;
          if (!b) return r;
          borrowedProvinceCount++;
          return {
            ...r,
            unitPrice: b.unitPrice,
            totalPrice: Math.round(b.unitPrice * r.quantity),
            source: `${b.doc} — giá tỉnh ${b.prov} (KHÔNG phải tỉnh dự án), cần đối chiếu`,
          };
        });
      }
    }

    // ===== TIER 3.5 — giá ĐẠI DIỆN họ mã từ đơn giá tỉnh (giá THẬT, trước LLM) =====
    // `suggestions` đã tra sẵn đơn giá tỉnh theo NORM_FAMILIES (đúng họ, có nguồn). Thay vì chỉ
    // gợi ý rồi bỏ mặc rơi Tier 5, áp giá đại diện (median) → dùng được 4305 giá thật ngay cả
    // khi web-lookup fail. Đánh dấu familyRep "cần chọn biến thể".
    const familyOptions = new Map<TakeoffRowKey, FamilyPriceOption[]>();
    for (const [key, list] of suggestions) {
      familyOptions.set(key, list.map((s) => ({ code: s.code, name: s.name, unit: s.unit, unitPrice: s.unitPrice, sourceDoc: s.sourceDoc })));
    }
    const familyRes = applyFamilyRepresentative(rows, familyOptions);
    rows = familyRes.rows;
    const familyRepCount = familyRes.familyRepCount;

    // ===== TIER 5 — ước lượng LLM (phao cuối "luôn có giá") =====
    // Áp cho MỌI dòng vẫn null sau Tier 1-4 (kể cả dòng CHƯA có mã — khác web lookup vốn
    // chỉ tra dòng đã có mã). Cờ PRICE_ESTIMATE_FALLBACK (mặc định bật) + editPermission.
    // Số ước lượng KHÔNG nguồn → applyEstimatedFallback dán nhãn ƯỚC LƯỢNG + hạ trần điểm.
    let estimatedCount = 0;
    const PRICE_ESTIMATE_ON = process.env.PRICE_ESTIMATE_FALLBACK !== 'off';
    if (PRICE_ESTIMATE_ON && input.editPermission && this.priceWeb.estimateEnabled) {
      const need = rows.filter((r) => r.unitPrice == null);
      if (need.length > 0) {
        const est = await this.priceWeb.estimatePricesBatch(
          need.map((r) => ({ key: r.key, workName: r.name, unit: r.unit })),
          state.projectInfo?.location,
        );
        const estMap = new Map<TakeoffRowKey, EstimatedPrice>();
        for (const r of need) {
          const e = est.get(r.key);
          if (e) estMap.set(r.key, { key: r.key, unitPrice: e.unitPrice, basis: e.basis });
        }
        const applied = applyEstimatedFallback(rows, estMap);
        rows = applied.rows;
        estimatedCount = applied.estimatedCount;
      }
    }

    // Tới được đây thì chắc chắn KHÔNG còn ca nhiều cụm chưa chọn — nhánh đó đã return
    // sớm ở trên (needsClusterPick). Còn lại: bóc theo vùng, hoặc bản vẽ chỉ có 1 cụm.
    // `openingVsFloorFinding` vẫn cần số cụm để không báo động giả.
    const clusterInfo = input.region
      ? { clusters: 1, spanM: 0 }
      : { clusters: preClusters.clusters.length, spanM: preClusters.spanM };

    // Id deterministic theo bản vẽ + VÙNG + dòng → bóc lại cùng vùng thay đúng vùng đó, vùng
    // khác cộng thêm (chống bóc đè). Vùng suy từ region bbox; toàn bản = '00000000'.
    const regionId = regionIdOf(input.region);
    const regionLabel = input.regionLabel;
    // Toàn bản (không region) → id CŨ `tk_engine_<bản>_<key>` (tương thích ngược, upsert tại
    // chỗ trên estimate cũ). Bóc theo VÙNG → chèn mã vùng để các vùng không đè nhau.
    const engineTakeoffId = (key: string) =>
      regionId === WHOLE_DRAWING_REGION
        ? `tk_engine_${input.drawingId}_${key}`
        : `tk_engine_${input.drawingId}_${regionId}_${key}`;
    // Gắn vùng vào từng dòng để render cột "Khu vực" + gộp giữ đúng vùng.
    rows = rows.map((r) => ({ ...r, regionId, regionLabel }));
    // GỘP nhiều bản/vùng: xoá dòng CÙNG (bản, vùng) đang bóc; giữ bản khác + vùng khác.
    const { staleIds, mergedRows } = planEngineTakeoffMerge(state.takeoff ?? [], input.drawingId, rows, regionId);
    const cleanupActions: Action[] = staleIds.map((id) => ({ type: 'delete_takeoff', id }));

    // PHÂN TÍCH ĐƠN GIÁ vào state → `analyses` (model đã có sẵn) → sheet 03 + compute()
    // tính Cost Summary. `ref` phải là refCode tài nguyên để nối được bảng giá VL/NC/Máy.
    const analysisActions: Action[] = analyses.map((a) => ({
      type: 'upsert_analysis',
      id: `an_engine_${a.code}`,
      code: a.code,
      name: a.name,
      unit: a.unit,
      components: a.components.map((c) => ({
        kind: (c.kind ?? 'material') as any,
        ref: c.refCode ?? c.name,
        name: c.name,
        unit: c.unit,
        norm: c.norm,
      })),
    })) as Action[];

    const takeoffActions: Action[] = rows.map((r) => ({
      type: 'upsert_takeoff',
      id: engineTakeoffId(r.key),
      group: r.boqGroup,
      code: r.code,
      name: r.name,
      unit: r.unit,
      quantity: r.quantity,
      note: r.note,
      // Lưu giá vào state → bóc gộp render lại được giá của bản này ở lần bóc bản khác.
      unitPrice: r.unitPrice,
      source: r.source,
      ...(r.estimated ? { estimated: true } : {}),
      ...(r.familyRep ? { familyRep: true } : {}),
      ...(r.regionLabel ? { regionLabel: r.regionLabel } : {}),
    }));
    const a = input.assumptions;

    // Route mỗi dòng vào sheet công tác của nó (structure/finishing/openings/mep) —
    // STT khởi động lại theo từng sheet, header màu riêng. Chú thích giả định chỉ
    // ghi ở sheet cuối cùng có dữ liệu để tránh lặp.
    const rowsBySheet = new Map<string, TakeoffEngineRow[]>();
    for (const r of mergedRows) {
      const sk = ROWKEY_SHEET[r.key] ?? BOQ_SHEETS[0].key;
      (rowsBySheet.get(sk) ?? rowsBySheet.set(sk, []).get(sk)!).push(r);
    }
    const filledSheets = BOQ_SHEETS.filter((s) => (rowsBySheet.get(s.key)?.length ?? 0) > 0);
    const mirrorActions: Action[] = [];
    filledSheets.forEach((sheetDef, si) => {
      const sheetRows = rowsBySheet.get(sheetDef.key)!;
      const isLast = si === filledSheets.length - 1;
      // Ghi SỐ THÔ, KHÔNG format sẵn. Reducer ép kiểu bằng
      // `isFinite(Number(v)) ? Number(v) : v` → "1500000" thành SỐ, còn "1.500.000"
      // (toLocaleString) thành NaN → giữ nguyên CHUỖI ⇒ Excel không cộng/sort được
      // cột Thành tiền = BOQ vô dụng. Hiển thị "1.500.000" do number format
      // (`n.pattern` trong format_sheet) lo, không phải do chuỗi.
      // Ô giá thiếu → "" (KHÔNG "0"/"—"): đúng convention sheet, không bịa số chưa có nguồn.
      const cellVnd = (n?: number) => (n != null ? String(Math.round(n)) : '');
      const mirror = rowsToUpdateCells(
        sheetRows.map((r, i) => ({
          stt: String(i + 1),
          // Cột "Bản vẽ" = TRUY VẾT: tên bản + NHÃN VÙNG ("F550 · Cụm 1") để phân biệt các vùng/
          // cụm cùng bản (mỗi vùng nhóm dòng riêng). Ghép ở đây thay vì thêm cột mới → KHÔNG
          // đổi số cột layout (tránh phá probe header + sheet cũ — bài học vision).
          drawing:
            (drawingNameById.get(r.drawingId ?? input.drawingId) ?? '') +
            (r.regionLabel ? ` · ${r.regionLabel}` : ''),
          code: r.code,
          name: r.name,
          objectGroup: OBJECT_GROUP_LABEL[r.group] ?? r.group,
          unit: r.unit,
          quantity: String(r.quantity),
          note: r.note,
          unitPrice: cellVnd(r.unitPrice),
          totalPrice: cellVnd(r.totalPrice),
          source: r.source ?? '',
        })),
        state,
        sheetDef.name,
        {
          title: sheetDef.name.toUpperCase(),
          theme: { tint: sheetDef.tint, accent: sheetDef.accent },
          // 3 sheet BOQ này DO ENGINE tạo (BOQ_SHEETS) → được phép dựng lại layout.
          // Mọi sheet khác (Workbook công ty) mặc định KHÔNG — xem rowsToUpdateCells.
          engineOwnedSheet: true,
          // Tô nền ô Đơn giá/Nguồn cho dòng giá ước lượng (amber) / đại diện họ mã (sky) —
          // QS nhìn thấy ngay số chưa chắc, khớp chip nguồn giá bên FE.
          priceFlags: sheetRows.map((r) => (r.estimated ? 'estimated' : r.familyRep ? 'familyRep' : undefined)),
          ...(isLast ? { footnote: assumptionFootnote(a) } : {}),
        },
      );
      if (mirror) mirrorActions.push(...mirror.actions, mirror.formatAction);
    });
    // format_sheet đi SAU block update_cells: widths + header + border + căn số + chú thích italic.
    const actions: Action[] = [
      ...cleanupActions,
      ...takeoffActions,
      ...analysisActions,
      ...mirrorActions,
    ];

    // Phụ lục thép: dùng text của TẤT CẢ đối tượng trong phạm vi đang bóc (đã lọc
    // rejected/region) — callout Ø không phụ thuộc classification hình học.
    const rebarTexts = objects.map((o) => (o as any).text).filter((t): t is string => !!t);
    const rebarSummary = renderRebarSummary(aggregateRebar(rebarTexts));

    const groups = [...new Set(rows.map((r) => r.group))];
    const missingCode = rows.filter((r) => !r.code);
    const webCode = rows.filter((r) => r.webSourced);
    const missingPrice = rows.filter((r) => r.unitPrice == null);
    const pricedCount = rows.length - missingPrice.length;
    // Cấu kiện KC đã nhận ra nhưng chưa đo được + nhãn bộ môn — dùng ở CẢ message lẫn
    // findings, nên tính 1 lần ở đây (trước message).
    // Dầm nét đơn đã đo (kcLinearRows) → hết "chưa đo được". Cột tròn: chỉ hết khi QS ĐÃ
    // xác nhận (confirmRoundColumns) — lúc đó roundColumnRows đã đo, không liệt kê nữa.
    const unmeasured = unmeasuredSections(
      (objects as unknown as EngineDrawingObject[]).filter(
        (o) => !kcLinear.measured.has(o) && !(input.confirmRoundColumns && isRoundColumnSection(o)),
      ),
      input.unitsPerDrawingUnit,
    );
    // Cột tròn ambiguous CHƯA xác nhận → gợi ý QS bật confirmRoundColumns để đo (đếm theo tâm).
    const roundColPending = input.confirmRoundColumns ? { count: 0 } : roundColumnGroups(objects as any, input.unitsPerDrawingUnit);
    const discLabel =
      discipline === 'KC' ? 'bản kết cấu' :
      discipline === 'DIEN' || discipline === 'NUOC' ? 'bản MEP' :
      discipline === 'KT' ? 'bản kiến trúc' : 'bản vẽ này';
    const message = [
      `Đã bóc khối lượng ${rows.length} dòng từ ${groups.length} nhóm cấu kiện (${groups.join(', ')}) — ${objects.length} đối tượng hình học${rejected.size ? `, đã loại ${rejected.size} đối tượng bị từ chối` : ''}${regionKept != null ? `. Bóc TRONG VÙNG CHỌN: chỉ tính ${regionKept}/${regionTotal} đối tượng nằm trong vùng` : ''}.`,
      `Giả định: cao tầng ${a.floorHeight}m, dày tường ${a.wallThickness}m, cao dầm ${a.beamDepth}m, bề rộng dầm ${ASSUMED_BEAM_WIDTH}m, tỷ lệ ${input.unitsPerDrawingUnit} m/đơn vị vẽ. (Sửa giả định ở nút ⚙ cạnh "Bóc toàn bộ" rồi bóc lại.)`,
      `Khối lượng do máy tính từ hình học bản vẽ — không phải AI ước lượng.`,
      ...(webCode.length > 0
        ? [
            `Mã hiệu: ${webCode.length} công tác không có trong norm_items — đã tra từ web (grounded search, chậm hơn bình thường); mã web CẦN KIỂM CHỨNG trước khi dùng.`,
          ]
        : []),
      ...(rejectedWebCodes.length > 0
        ? [
            `Đã CHẶN ${rejectedWebCodes.length} mã web không có trong sách đơn giá — thà để trống còn hơn gán mã sai kèm giá thật. Chi tiết ở "Điểm cần kiểm tra".`,
          ]
        : []),
      ...(suggestions.size > 0
        ? [
            `${suggestions.size} công tác chưa có mã: engine KHÔNG tự chế mã — đã liệt kê mã CÓ THẬT trong đơn giá tỉnh ở phần "Điểm cần kiểm tra" để bạn chọn (chọn xong giá tự áp).`,
          ]
        : []),
      `(Đơn giá/Thành tiền hiện khi CÓ nguồn giá — công bố giá tỉnh (Sở XD) hoặc web grounded có trích nguồn; ô "—" là chưa có giá, KHÔNG bịa.)`,
      ...(unmeasured.total > 0
        ? [`Đã nhận ra ${unmeasured.total} cấu kiện KC (cột/dầm/móng) nhưng chưa đo được vì vẽ nét đơn/ký hiệu — xem "Điểm cần kiểm tra" để khoanh vùng.`]
        : []),
      `BOQ mới từ ${discLabel} — còn ${CHECKLIST_QS.length} nhóm cần bản vẽ/khoanh vùng khác để đủ.`,
      '',
      rowsToMarkdownTable(rows),
      '',
      renderChecklistQs(existingDisciplines),
      ...(rebarSummary ? ['', rebarSummary] : []),
      '',
      summarizeDetectedObjects(objects as unknown as EngineDrawingObject[], input.unitsPerDrawingUnit),
    ].join('\n');

    const hs = hatchSlabStats(objects as unknown as EngineDrawingObject[], input.unitsPerDrawingUnit);

    // GỘP 1 finding thay vì mỗi dòng 1 warn: 9 warn "Thiếu mã: X" + 1 warn giá + 1 finding
    // gợi ý = 11 mục nói cùng một chuyện ⇒ nhiễu. Danh sách dòng đủ để QS biết thiếu ở đâu;
    // ứng viên mã nằm ở finding gợi ý ngay dưới.
    const findings: ValidationFinding[] = [];
    if (missingCode.length > 0) {
      findings.push({
        id: 'takeoff-engine-code',
        severity: 'warn',
        area: 'missing',
        title: `${missingCode.length} công tác chưa chốt mã định mức`,
        // KHÔNG bảo "cần import bộ định mức": mã ĐÃ có sẵn trong bộ đơn giá tỉnh (engine
        // đang gợi ý chính nó ở finding dưới). Lý do để trống là QS chưa chốt QUY CÁCH
        // (mác bê tông/vữa…), không phải thiếu dữ liệu.
        detail:
          `Engine không tự chọn mã vì mỗi công tác có nhiều biến thể chỉ khác quy cách (mác bê tông, ` +
          `mác vữa, tiết diện…) — không suy được từ bản vẽ. Chọn mã ở mục gợi ý bên dưới, giá sẽ tự áp:\n` +
          missingCode.map((r) => `· ${r.name} (${r.quantity} ${r.unit})`).join('\n'),
      });
    }
    if (missingPrice.length > 0) {
      findings.push({
        id: 'takeoff-engine-price',
        severity: 'warn',
        area: 'unitPrice',
        title: `Chưa có đơn giá cho ${missingPrice.length} công tác`,
        // Nguyên nhân THẬT thường là chưa chốt mã, không phải thiếu bộ đơn giá — bảo QS
        // "import công bố giá tỉnh" khi bộ đơn giá đã nạp là chỉ dẫn cụt, sai nguyên nhân.
        detail: priceCtx
          ? `${missingPrice.length}/${rows.length} công tác chưa có đơn giá. Đã nạp bộ đơn giá ${priceCtx.province} ` +
            `(${priceCtx.sourceDoc} ${priceCtx.effectiveDate}) — giá sẽ tự áp ngay khi chốt mã. Engine KHÔNG ước lượng giá.`
          : `${missingPrice.length}/${rows.length} công tác chưa có đơn giá — chưa khớp công bố giá tỉnh nào. ` +
            `Kiểm tra tỉnh của dự án, hoặc import công bố giá tỉnh tại /settings. Engine KHÔNG ước lượng giá.`,
      });
    } else if (priceCtx) {
      findings.push({
        id: 'takeoff-engine-price',
        severity: 'info',
        area: 'unitPrice',
        title: `Đơn giá theo ${priceCtx.sourceDoc} — ${priceCtx.province}`,
        detail: `Toàn bộ ${rows.length} công tác gán đơn giá từ công bố giá ${priceCtx.province}, hiệu lực ${priceCtx.effectiveDate}.`,
      });
    }
    // Engine tự soi số của chính mình, CẢ 2 CHIỀU: thừa (cửa > sàn = đếm trùng)
    // và thiếu (tường < chu vi tối thiểu = bỏ sót layer).
    const sanityOver = openingVsFloorFinding(rows, clusterInfo.clusters);
    if (sanityOver) findings.push(sanityOver);
    const sanityUnder = wallVsFloorFinding(rows);
    if (sanityUnder) findings.push(sanityUnder);
    // TRUNG THỰC về cấu kiện KC đã NHẬN RA nhưng KHÔNG đo được — báo rõ số + lý do, để
    // QS biết mà khoanh vùng/xác nhận, KHÔNG lặng lẽ bỏ rồi nói "chưa nhận diện được".
    if (unmeasured.total > 0) {
      const parts = Object.entries(unmeasured.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`)
        .join(', ');
      findings.push({
        id: 'takeoff-engine-unmeasured-sections',
        severity: 'warn',
        area: 'missing',
        title: `Đã nhận ra ${unmeasured.total} cấu kiện KC nhưng CHƯA đo được — cần xác nhận`,
        detail:
          `Detector nhận ra ${parts} nhưng engine KHÔNG đo vì chúng vẽ bằng NÉT ĐƠN (LINE, không có ` +
          `mặt cắt kín để lấy tiết diện) hoặc là VÒNG TRÒN/KÝ HIỆU chưa rõ (cột? cọc? ký hiệu?) — engine ` +
          `không đoán để tránh tạo số khống. Để bóc: khoanh vùng đúng cấu kiện rồi bóc lại, hoặc mở bản ` +
          `mặt cắt/chi tiết có tiết diện. (Đây KHÔNG phải "chưa nhận diện" — đã tìm thấy, chỉ chưa đủ hình học để đo.)`,
      });
    }
    // Cột tròn: đo được nếu QS xác nhận đó LÀ cột (đếm theo tâm, πr²×H). Gợi ý bật cờ.
    if (roundColPending.count > 0) {
      findings.push({
        id: 'takeoff-engine-round-columns',
        severity: 'warn',
        area: 'missing',
        title: `${roundColPending.count} cột tròn — xác nhận để đo`,
        detail:
          `Phát hiện ${roundColPending.count} vòng tròn (gộp cung đồng tâm) trên bản KC nghi là CỘT TRÒN, ` +
          `nhưng type còn nhập nhằng (cột/cọc/móng/ký hiệu) nên engine KHÔNG tự đo. Nếu đúng là cột, bóc lại ` +
          `với xác nhận "cột tròn" → engine đo πr²×H (đường kính đo từ bản vẽ, chiều cao theo giả định).`,
      });
    }
    // Cửa/cửa sổ đếm theo CÁI — nói rõ 1 LẦN ở đây vì sao không có m² (thay vì nhét cả
    // đoạn vào cột Diễn giải của từng dòng, làm bảng không đọc nổi).
    const openingRows = rows.filter((r) => (r.key === 'door' || r.key === 'window') && r.quantity > 0);
    if (openingRows.length > 0) {
      findings.push({
        id: 'takeoff-engine-openings-count',
        severity: 'info',
        area: 'quantity',
        title: `Cửa/cửa sổ đếm theo CÁI — m² cần bảng thống kê cửa`,
        detail:
          `${openingRows.map((r) => `${r.name}: ${r.quantity} cái`).join(' · ')}. Engine KHÔNG suy m² từ mặt bằng: ` +
          `bbox cửa trên mặt bằng là bề rộng × cung quét cánh (hoặc × bề dày tường), không phải diện tích cánh; ` +
          `m² = rộng × cao mà CHIỀU CAO không có trong mặt bằng. Điền m² từ bảng thống kê cửa của bản vẽ.`,
      });
    }
    // PHÂN TÍCH ĐƠN GIÁ: báo cái sinh được…
    if (analyses.length > 0) {
      findings.push({
        id: 'takeoff-engine-unit-rate-analysis',
        severity: 'info',
        area: 'unitPrice',
        title: `Đã lập phân tích đơn giá cho ${analyses.length} công tác (hao phí VL/NC/Máy)`,
        detail:
          `Hao phí lấy theo MÃ CHÍNH XÁC từ định mức TT12/2021 (không đoán theo tên):\n` +
          analyses
            .map((a) => {
              const by = (k: string) => a.components.filter((c) => (c.kind ?? 'material') === k).length;
              return `· ${a.code} ${a.name.slice(0, 48)} — ${by('material')} vật liệu, ${by('labor')} nhân công, ${by('machine')} máy`;
            })
            .join('\n'),
      });
    }
    // …và cái CHẶN vì hai nguồn mâu thuẫn (không tự chọn bên nào).
    if (macConflicts.length > 0) {
      findings.push({
        id: 'takeoff-engine-mac-conflict',
        severity: 'warn',
        area: 'unitPrice',
        title: `⚠ ${macConflicts.length} mã: định mức và đơn giá tỉnh ghi MÁC khác nhau — chưa lập phân tích đơn giá`,
        detail:
          `Cùng một mã nhưng hai nguồn ghi mác lệch nhau, engine KHÔNG tự chọn bên nào (chọn sai = ra sai ` +
          `cấp phối mà vẫn đóng dấu "TT12/2021"):\n${macConflicts.map((s) => `· ${s}`).join('\n')}\n` +
          `Cần QS đối chiếu văn bản gốc rồi chốt. Khối lượng và đơn giá trọn gói của các dòng này VẪN dùng được.`,
      });
    }
    // Minh bạch phạm vi: liệt kê nhóm công tác còn thiếu so với checklist QS.
    // Ghi chú (info), KHÔNG sinh action/số cho các mục cần bổ sung. Tiêu đề dùng discLabel
    // (tính ở trên) để phản ánh ĐÚNG bộ môn — gọi bản KC là "bản kiến trúc" là sai sự thật.
    findings.push({
      id: 'takeoff-engine-checklist-qs',
      severity: 'info',
      area: 'missing',
      title: `BOQ mới từ ${discLabel} — còn ${CHECKLIST_QS.length} nhóm cần bản vẽ/khoanh vùng khác`,
      detail: `${renderChecklistQs(existingDisciplines)}`,
    });
    if (webPricedCount > 0) {
      findings.push({
        id: 'takeoff-engine-web-price',
        severity: 'warn',
        area: 'unitPrice',
        title: `${webPricedCount} đơn giá tra từ web — cần kiểm chứng`,
        detail: `${webPricedCount} công tác được điền đơn giá từ tra cứu web (grounded search)${state.projectInfo?.location ? ` tại ${state.projectInfo.location}` : ''} — có link nguồn ở cột Nguồn. Giá web mang tính tham khảo, CẦN KIỂM CHỨNG/đối chiếu công bố giá tỉnh trước khi dùng chính thức.`,
      });
    }
    if (factorOverridden) {
      findings.push({
        id: 'takeoff-engine-factor-override',
        severity: 'warn',
        area: 'quantity',
        title: 'Tỉ lệ bản vẽ được tự sửa lại',
        detail: `Tỉ lệ gửi lên cho kích thước công trình không hợp lý — engine đã dùng ${factor} m/đơn vị (suy từ kích thước tổng thể). Hiệu chỉnh 2 điểm để xác nhận.`,
      });
    }
    if (webCode.length > 0) {
      findings.push({
        id: 'takeoff-engine-web-code',
        severity: 'warn',
        area: 'missing',
        title: `${webCode.length} mã tra từ web — cần kiểm chứng`,
        detail: `${webCode.length} mã tra từ web — kiểm chứng trước khi dùng; import bộ định mức để có nguồn chính thống.`,
      });
    }
    // MINH BẠCH RÀO MÃ: cho QS thấy engine đã CHẶN cái gì — quan trọng để tin được
    // những dòng CÓ mã.
    if (rejectedWebCodes.length > 0) {
      findings.push({
        id: 'takeoff-engine-web-code-rejected',
        severity: 'info',
        area: 'missing',
        title: `Đã loại ${rejectedWebCodes.length} mã tra từ web vì KHÔNG có trong đơn giá tỉnh`,
        detail:
          `Mã do AI tra web không tìm thấy trong bộ đơn giá của tỉnh → nhiều khả năng là mã tự chế ` +
          `(đã gặp thật: AE.00000, AH.30000 dùng chung cho cả cửa đi lẫn cửa sổ). Engine KHÔNG đưa vào ` +
          `BOQ:\n${rejectedWebCodes.map((s) => `· ${s}`).join('\n')}`,
      });
    }
    // ỨNG VIÊN MÃ THẬT: dòng chưa có mã → liệt kê mã CÓ THẬT trong đơn giá tỉnh kèm
    // giá + nguồn để QS/agent CHỌN. Engine KHÔNG tự chọn: khớp theo tên tiếng Việt
    // không đáng tin (đo thật: "sơn tường" → "Miết mạch tường đá"), tự chọn = mã sai
    // + giá thật = sai một cách tự tin.
    if (suggestions.size > 0) {
      const lines = [...suggestions.entries()].map(([key, list]) => {
        const opts = list
          .map((s) => `${s.code} "${s.name}" — ${Math.round(s.unitPrice).toLocaleString('vi-VN')}đ/${s.unit || '?'}`)
          .join('  |  ');
        // Nêu rõ THÔNG SỐ phải quyết: tên trong đơn giá là tên con (vd "Tiết diện gạch
        // ≤0,023m2") nên đứng một mình vô nghĩa — QS cần biết mình đang chốt cái gì.
        const spec = NORM_FAMILIES[key]?.spec;
        return `· ${DEFAULT_NAMES[key]}${spec ? ` — chọn theo: ${spec}` : ''}\n    ${opts}`;
      });
      const doc = [...suggestions.values()][0]?.[0]?.sourceDoc;
      findings.push({
        id: 'takeoff-engine-code-suggestions',
        severity: 'info',
        area: 'missing',
        title: `Có ${suggestions.size} công tác tra được mã thật trong đơn giá tỉnh — chọn để ra giá`,
        detail:
          `Các mã dưới đây CÓ THẬT trong bộ đơn giá${doc ? ` (${doc})` : ''}, kèm giá + nguồn, và đã lọc về ` +
          `ĐÚNG họ mã định mức TT12/2021 của từng công tác. Engine KHÔNG tự chọn vì các biến thể trong họ chỉ ` +
          `khác nhau ở quy cách (mác bê tông, mác vữa, tiết diện…) — những thông số này nằm ở thuyết minh/chỉ ` +
          `dẫn kỹ thuật, KHÔNG suy được từ hình học bản vẽ; máy chọn hộ = đoán. QS chốt biến thể (hoặc bảo ` +
          `agent "điền mã cho dòng X là <mã>"), giá sẽ tự áp theo đơn giá tỉnh:\n${lines.join('\n')}`,
      });
    }
    if (hs.count > 0 && hs.used === 0) {
      findings.push({
        id: 'takeoff-engine-hatch-untrusted',
        severity: 'warn',
        area: 'quantity',
        title: `Phát hiện ${hs.count} hatch nhưng không đủ tin cậy để bóc diện tích sàn`,
        detail: `${hs.count} hatch đều bị loại (quá nhỏ < ${HATCH_MIN_AREA}m² là pattern ký hiệu, hoặc chiếm > ${HATCH_MAX_SHARE * 100}% tổng) — cần khoanh vùng nền thủ công rồi bóc lại. Engine KHÔNG bịa diện tích sàn.`,
      });
    } else if (hs.used > 0) {
      findings.push({
        id: 'takeoff-engine-hatch-slab',
        severity: 'info',
        area: 'quantity',
        title: `Bóc diện tích sàn/nền từ ${hs.used} mảng hatch`,
        detail: `Dùng ${hs.used}/${hs.count} hatch (bỏ ${hs.dropped} ngoài ngưỡng), tổng diện tích ${hs.area} m² — đo bằng shoelace từ hình học, không ước lượng.`,
      });
    }
    // RỖNG xét TRƯỚC mọi thang điểm: 0 dòng = 0 lỗi = điểm cao nhất là phi lý
    // (đã xảy ra thật: DIEN bóc 0 dòng được 90đ "reasonable", KT bóc 13 dòng được 70đ).
    const empty = emptyResultVerdict(rows.length, {
      objectCount: objects.length,
      discipline,
      disciplineSupported: allowedKeys == null || allowedKeys.size > 0,
    });
    if (empty) findings.push(empty.finding);
    // Tier 5: dự toán có giá ƯỚC LƯỢNG → cảnh báo rõ + CAP điểm để số không nguồn không trôi.
    if (estimatedCount > 0) {
      findings.push({
        id: 'takeoff-engine-estimated-price',
        severity: 'warn',
        area: 'unitPrice',
        title: `${estimatedCount} đơn giá là ƯỚC LƯỢNG (chưa kiểm chứng)`,
        detail:
          `${estimatedCount}/${rows.length} công tác không tra được công bố giá tỉnh/định mức/web nên đơn giá do AI ` +
          `ƯỚC LƯỢNG theo mặt bằng thị trường — cột Nguồn ghi "${ESTIMATED_PRICE_SOURCE}". Số CHỈ để tham khảo, ` +
          `PHẢI đối chiếu công bố giá Sở Xây dựng tỉnh trước khi dùng chính thức.`,
      });
    }
    // Tier 3.5: giá đại diện họ mã (THẬT, chưa chốt biến thể) → gợi ý chọn biến thể.
    if (familyRepCount > 0) {
      findings.push({
        id: 'takeoff-engine-family-price',
        severity: 'warn',
        area: 'unitPrice',
        title: `${familyRepCount} đơn giá đại diện họ mã — cần chọn biến thể`,
        detail:
          `${familyRepCount}/${rows.length} công tác đã áp đơn giá THẬT từ công bố giá tỉnh nhưng lấy giá ĐẠI DIỆN ` +
          `(median) của họ mã vì chưa chốt biến thể (mác bê tông/vữa, tiết diện). Chọn đúng mã ở mục gợi ý để giá chính xác.`,
      });
    }
    // đủ mã DB + đủ giá → 90; có mã web/mã phổ thông → 70; đủ mã DB thiếu giá → 75; thiếu mã hẳn → 55
    const softCode = webCode.length;
    const baseScore =
      empty ? empty.score
      : missingCode.length > 0 ? 55 : softCode > 0 ? 70 : missingPrice.length > 0 ? 75 : 90;
    // Giá ước lượng KHÔNG nguồn hạ trần điểm — không được trông "đáng tin" hơn giá thật thiếu.
    const score = estimatedCount > 0 ? Math.min(baseScore, ESTIMATED_PRICE_SCORE_CAP) : baseScore;
    const validation: ValidationReport = {
      status: score === 90 ? 'reasonable' : 'warning',
      score,
      findings,
      consistency: [],
    };

    const sources: { title?: string; uri?: string; type?: string }[] =
      priceCtx && pricedCount > 0
        ? [{ title: `${priceCtx.sourceDoc} — ${priceCtx.province}`, type: 'government' }]
        : [];
    // Nguồn ĐƠN GIÁ TỈNH (unit_prices): giá trọn gói lấy thẳng từ bộ đơn giá — nguồn
    // chính thống thật (vd "TT 13/2021/TT-BXD"). Trước đây `sources` chỉ đọc priceCtx
    // (price_sets) nên dù có giá vẫn trả 0 nguồn — đúng lỗi đo trên production.
    const seenDoc = new Set<string>();
    for (const key of Object.keys(normCandidates) as TakeoffRowKey[]) {
      const dp = normCandidates[key]?.directPrice;
      if (!dp?.sourceDoc || seenDoc.has(dp.sourceDoc)) continue;
      seenDoc.add(dp.sourceDoc);
      sources.push({ title: `${dp.sourceDoc}${province ? ` — ${province}` : ''}`, type: 'government' });
    }
    // Mã web: type 'web' — KHÔNG BAO GIỜ 'government'. Dedupe theo uri/title.
    const seenWeb = new Set<string>();
    for (const key of Object.keys(normCandidates) as TakeoffRowKey[]) {
      const ws = normCandidates[key]?.webSource;
      if (!ws) continue;
      const dedupe = ws.uri ?? ws.title ?? '';
      if (seenWeb.has(dedupe)) continue;
      seenWeb.add(dedupe);
      sources.push({ title: ws.title, uri: ws.uri, type: 'web' });
    }
    // Nguồn GIÁ web — type 'web', dedupe theo uri/title.
    for (const h of webPriceHits) {
      const dedupe = h.sourceUri ?? h.sourceTitle ?? '';
      if (!dedupe || seenWeb.has(dedupe)) continue;
      seenWeb.add(dedupe);
      sources.push({ title: h.date ? `${h.sourceTitle ?? 'Giá web'} (${h.date})` : h.sourceTitle, uri: h.sourceUri, type: 'web' });
    }

    return {
      thinking: [
        `Đọc ${rawObjects.length} đối tượng của bản vẽ, giữ ${objects.length} sau khi loại từ chối/không đo được.`,
        ...(allowedKeys
          ? [`Bộ môn bản vẽ = ${discipline} → chỉ sinh nhóm công tác của bộ môn này (${[...allowedKeys].join(', ') || 'không có rowKey — chỉ checklist'}); tất cả ghi chung sheet Khối lượng.`]
          : [`Bản vẽ chưa gắn bộ môn (hoặc KHÁC) → giữ toàn bộ nhóm công tác.`]),
        ...(regionKept != null
          ? [`Bóc trong vùng chọn: giữ ${regionKept}/${regionTotal} đối tượng có tâm nằm trong vùng.`]
          : []),
        `Đo hình học (polyline/shoelace/bbox) × ${input.unitsPerDrawingUnit} m/đơn vị.`,
        `Áp công thức cố định (tường/cột/dầm/cửa) với giả định người dùng.`,
        ...(regionKept != null
          ? [`Bóc theo vùng đã chọn: ${regionKept}/${regionTotal} đối tượng nằm trong vùng — các cụm khác trong model space không tính.`]
          : []),
        ...(hs.count > 0
          ? [`Hatch: ${hs.used}/${hs.count} mảng đủ tin cậy → diện tích sàn/nền ${hs.area} m² (bỏ ${hs.dropped} ngoài ngưỡng).`]
          : []),
        `Tra mã định mức trong norm_items: ${rows.length - missingCode.length - webCode.length}/${rows.length} dòng có mã DB.`,
        ...(cleanupActions.length > 0 ? [`Thay thế ${cleanupActions.length} dòng bóc cũ của bản này.`] : []),
        ...(webLookedUp > 0
          ? [
              `Tra mã từ web (grounded search) cho ${webLookedUp} công tác thiếu mã DB: ${webHitCount} mã tìm thấy (đã qua 3 rào chống bịa — grounding, regex format, khớp nguyên văn).`,
            ]
          : []),
        priceCtx
          ? `Gán đơn giá từ công bố giá ${priceCtx.province} (${priceCtx.sourceDoc}, hiệu lực ${priceCtx.effectiveDate}): ${pricedCount}/${rows.length} dòng có giá.`
          : 'Không có công bố giá tỉnh khớp địa điểm dự án — cột đơn giá để trống (không ước lượng).',
      ],
      message,
      actions,
      sources,
      preview: previewActions(state, actions),
      validation,
      trace: [],
    };
  }
}
