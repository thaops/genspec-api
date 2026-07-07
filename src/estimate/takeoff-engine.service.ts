// Deterministic Takeoff Engine — khối lượng tính bằng CODE từ hình học bản vẽ,
// mã hiệu tra từ DB norm_items thật. KHÔNG có LLM call nào ở đây.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NormComponent, NormItem } from '../catalog/catalog-db.schemas';
import { CatalogService, lookupComponentPrice } from '../catalog/catalog.service';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { Discipline, isDiscipline } from '../drawing/discipline';
import { EstimateService } from './estimate.service';
import { Action, EstimateState, ValidationFinding, ValidationReport } from './estimate.types';
import { rowsToUpdateCells } from './markdown-table-actions';
import { NormWebLookupService } from './norm-web-lookup.service';
import { PriceWebLookupService, WebPriceHit } from './price-web-lookup.service';
import { previewActions } from './transparency';

// ===== Pure core (không Mongo — verify script gọi trực tiếp từ dist) =====

export interface TakeoffAssumptions {
  floorHeight: number; // m
  wallThickness: number; // m
  beamDepth: number; // m
}

export interface EngineDrawingObject {
  type: string;
  geometry?: number[][];
  boundingBox: { x?: number; y?: number; w: number; h: number };
  /** Tier 1/2.5: classification unresolved (multi-candidate) — must not be counted. */
  ambiguous?: boolean;
}

/**
 * A detected object may become a real BOQ quantity only when its class is settled.
 * Excludes: ambiguous (unresolved candidates), 'ignored' (non-plotting/excluded),
 * 'unknown' (undetected). Keeps every quantity defensible in front of an owner.
 */
export function isCountableObject(o: EngineDrawingObject): boolean {
  return !o.ambiguous && o.type !== 'ignored' && o.type !== 'unknown';
}

export interface NormCandidate {
  code: string;
  name: string;
  unit: string;
  sourceDoc?: string;
  /** Hao phí VL/NC/M từ norm_items — nguồn tính đơn giá thật. */
  components?: { kind?: string; refCode?: string; name: string; unit?: string; norm: number }[];
  /** Có mặt = mã tra từ WEB (grounded search) chứ không phải DB — cần kiểm chứng. */
  webSource?: { title?: string; uri?: string };
  /** Mã phổ thông mặc định (COMMON_FALLBACK_CODES) khi Edit bật — cần kiểm chứng, KHÔNG có giá. */
  fallback?: boolean;
}

/**
 * Mã phổ thông mặc định theo TT12/2021 — dùng khi Edit bật và dòng vẫn thiếu mã
 * (không có DB, không tra được web) để "hoàn thiện bảng" 1 lệnh. Chỉ mã + tên
 * chuẩn, KHÔNG kèm giá; nguồn ghi rõ "AI đề xuất mã phổ thông — cần kiểm chứng".
 */
export const COMMON_FALLBACK_CODES: Record<TakeoffRowKey, { code: string; name: string }> = {
  wall_area: { code: 'AK.21110', name: 'Trát tường' },
  wall_volume: { code: 'AE.62210', name: 'Xây tường gạch' },
  column_concrete: { code: 'AF.61520', name: 'Bê tông cột đá 1x2 M250' },
  column_formwork: { code: 'AF.86411', name: 'Ván khuôn cột' },
  beam_concrete: { code: 'AF.61620', name: 'Bê tông dầm đá 1x2 M250' },
  beam_formwork: { code: 'AF.86511', name: 'Ván khuôn dầm' },
  wall_paint: { code: 'AK.84210', name: 'Bả + sơn tường' },
  door: { code: 'AH.11120', name: 'Cửa đi' },
  window: { code: 'AH.12110', name: 'Cửa sổ' },
  slab: { code: 'AF.61720', name: 'Bê tông sàn đá 1x2 M250' },
  floor_finish: { code: 'AK.51110', name: 'Lát nền gạch' },
  ceiling: { code: 'AK.64110', name: 'Trần thạch cao khung xương' },
  ceiling_paint: { code: 'AK.84330', name: 'Sơn trần' },
  skirting: { code: 'AK.57110', name: 'Ốp/len chân tường' },
};

export type TakeoffRowKey =
  | 'wall_area'
  | 'wall_volume'
  | 'wall_paint'
  | 'column_concrete'
  | 'column_formwork'
  | 'beam_concrete'
  | 'beam_formwork'
  | 'door'
  | 'window'
  | 'slab'
  | 'floor_finish'
  | 'ceiling'         // trần (= diện tích sàn) — suy ra
  | 'ceiling_paint'   // sơn trần (= diện tích trần)
  | 'skirting';       // len/chân tường (= chiều dài tường)

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
  KT: ['wall_area', 'wall_volume', 'wall_paint', 'door', 'window', 'floor_finish', 'ceiling', 'ceiling_paint', 'skirting'],
  KC: ['column_concrete', 'column_formwork', 'beam_concrete', 'beam_formwork', 'slab'],
  DIEN: [],
  NUOC: [],
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
  /** true = mã phổ thông mặc định (COMMON_FALLBACK_CODES) — cần kiểm chứng, không có giá. */
  fallback?: boolean;
  /** true = ĐƠN GIÁ tra từ web (không phải công bố giá tỉnh) — cần kiểm chứng. */
  pricedFromWeb?: boolean;
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
 * Gán đơn giá/thành tiền vào rows từ price_set tỉnh. Mutate-free: trả rows mới.
 * Thiếu giá → giữ nguyên dòng (cột giá trống), caller sinh finding warn.
 */
export function applyPricingToRows(
  rows: TakeoffEngineRow[],
  candidates: NormCandidateMap,
  ctx: PriceContextLite | null,
): TakeoffEngineRow[] {
  if (!ctx) return rows;
  return rows.map((r) => {
    if (!r.code) return r;
    const cand = candidates[r.key];
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

/** Keyword tra norm_items theo từng dòng khối lượng (regex, thử theo thứ tự). */
export const NORM_KEYWORDS: Record<TakeoffRowKey, string[]> = {
  wall_area: ['trát tường', 'xây tường'],
  wall_volume: ['xây tường', 'xây.*gạch'],
  wall_paint: ['sơn.*tường', 'bả.*tường', 'sơn'],
  column_concrete: ['bê tông.*cột'],
  column_formwork: ['ván khuôn.*cột'],
  beam_concrete: ['bê tông.*dầm'],
  beam_formwork: ['ván khuôn.*dầm'],
  door: ['cửa đi', 'cửa'],
  window: ['cửa sổ', 'cửa'],
  slab: ['bê tông.*sàn'],
  floor_finish: ['lát nền', 'lát.*gạch', 'lát'],
  ceiling: ['trần thạch cao', 'trần.*khung', 'trần'],
  ceiling_paint: ['sơn.*trần'],
  skirting: ['len chân tường', 'len tường', 'ốp.*chân tường'],
};

/** Nhóm công tác BOQ chuẩn TT13/2021 cho mỗi dòng đo được. */
export const BOQ_GROUP_THO = 'PHẦN THÔ - KẾT CẤU';
export const BOQ_GROUP_FINISH = 'PHẦN HOÀN THIỆN';
export const BOQ_GROUP_OTHER = 'PHẦN KHÁC';

const BOQ_GROUP: Record<TakeoffRowKey, string> = {
  wall_volume: BOQ_GROUP_THO,
  column_concrete: BOQ_GROUP_THO,
  column_formwork: BOQ_GROUP_THO,
  beam_concrete: BOQ_GROUP_THO,
  beam_formwork: BOQ_GROUP_THO,
  slab: BOQ_GROUP_THO,
  wall_area: BOQ_GROUP_FINISH,
  wall_paint: BOQ_GROUP_FINISH,
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
] as const;

/** Tên 3 sheet (thứ tự) — FE dùng để tạo sheet trước khi bóc. */
export const BOQ_SHEET_NAMES = BOQ_SHEETS.map((s) => s.name);

/**
 * rowKey → sheet đích. Xây + trát (bao che) và cấu kiện chịu lực → sheet 1;
 * bả/sơn + lát nền → sheet 2; cửa đi/sổ → sheet 3.
 */
const ROWKEY_SHEET: Record<TakeoffRowKey, string> = {
  wall_volume: 'structure',
  wall_area: 'structure',
  column_concrete: 'structure',
  column_formwork: 'structure',
  beam_concrete: 'structure',
  beam_formwork: 'structure',
  slab: 'structure',
  wall_paint: 'finishing',
  floor_finish: 'finishing',
  ceiling: 'finishing',
  ceiling_paint: 'finishing',
  skirting: 'finishing',
  door: 'openings',
  window: 'openings',
};

/**
 * Tên hiển thị cột "Tên công tác": web/fallback LUÔN dùng tên chuẩn engine; tên DB
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
    haveReason: 'đã có bản KẾT CẤU — chưa nhận diện được thép/móng, cần khoanh vùng/gán loại',
  },
  {
    name: 'Đào đất, bê tông lót, móng',
    reason: 'cần bản kết cấu móng',
    need: ['KC'],
    haveReason: 'đã có bản KẾT CẤU — chưa nhận diện được móng, cần khoanh vùng/gán loại',
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
  return `CẦN BỔ SUNG (chưa bóc được từ bản kiến trúc — KHÔNG tạo số khống):\n${lines.join('\n')}`;
}

const DEFAULT_NAMES: Record<TakeoffRowKey, string> = {
  wall_area: 'Xây/trát tường',
  wall_volume: 'Xây tường',
  wall_paint: 'Bả + sơn tường',
  column_concrete: 'Bê tông cột',
  column_formwork: 'Ván khuôn cột',
  beam_concrete: 'Bê tông dầm',
  beam_formwork: 'Ván khuôn dầm',
  door: 'Cửa đi',
  window: 'Cửa sổ',
  slab: 'Sàn (bê tông)',
  floor_finish: 'Lát nền',
  ceiling: 'Trần',
  ceiling_paint: 'Sơn trần',
  skirting: 'Len/chân tường',
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
}

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
export function countObjectClusters(
  objects: EngineDrawingObject[],
  factor: number,
  epsMeters = 25,
): { clusters: number; spanM: number } {
  const cell = epsMeters / (factor || 1);
  const centers: [number, number][] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const o of objects) {
    if (!isCountableObject(o)) continue;
    if (!(MEASURED_TYPES as readonly string[]).includes(o.type)) continue;
    const b = o.boundingBox;
    const cx = (b.x ?? 0) + (b.w ?? 0) / 2;
    const cy = (b.y ?? 0) + (b.h ?? 0) / 2;
    if (!isFinite(cx) || !isFinite(cy)) continue;
    centers.push([cx, cy]);
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
  }
  if (centers.length < 8) return { clusters: centers.length ? 1 : 0, spanM: 0 };

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) { parent.set(r, parent.get(parent.get(r)!)!); r = parent.get(r)!; }
    return r;
  };
  const key = (ix: number, iy: number) => `${ix}:${iy}`;
  const cells = new Set<string>();
  for (const [x, y] of centers) {
    const k = key(Math.floor(x / cell), Math.floor(y / cell));
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
  const roots = new Set<string>();
  for (const c of cells) roots.add(find(c));
  return { clusters: roots.size, spanM: Math.max(maxX - minX, maxY - minY) * factor };
}

const TYPE_LABELS_VI: Record<string, string> = {
  wall: 'tường', column: 'cột', beam: 'dầm', door: 'cửa', window: 'cửa sổ',
  slab: 'sàn', hatch: 'hatch', text: 'text', block: 'block',
  dimension: 'dimension', unknown: 'chưa phân loại',
};

/** Các loại đã bóc được (trực tiếp, qua hatch→sàn, hoặc opening/slab-typed). */
const TAKEN_TYPES = new Set<string>([...MEASURED_TYPES, 'hatch', 'opening', 'slab']);

/**
 * 1 dòng thống kê (KHÔNG phải công tác) để user biết bản vẽ còn gì chưa bóc,
 * thay vì tưởng chỉ có mấy nhóm ít ỏi trong bảng.
 */
export function summarizeDetectedObjects(objects: EngineDrawingObject[]): string {
  const counts: Record<string, number> = {};
  let ambiguous = 0;
  for (const o of objects) {
    if (o.ambiguous) { ambiguous += 1; continue; }
    counts[o.type] = (counts[o.type] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`);
  const notTaken = entries
    .filter(([t]) => !TAKEN_TYPES.has(t) && t !== 'ignored')
    .map(([t, n]) => `${n} ${TYPE_LABELS_VI[t] ?? t}`);
  const suffix = notTaken.length
    ? ` Chưa bóc: ${notTaken.join(', ')} — cần khoanh vùng/gán loại thủ công.`
    : '';
  const ambSuffix = ambiguous ? ` ${ambiguous} đối tượng chưa chốt loại (không tính khối lượng).` : '';
  return `Đối tượng nhận diện: ${parts.join(', ')}.${suffix}${ambSuffix}`;
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
  const AGG_TYPES = new Set<string>([...MEASURED_TYPES, 'opening', 'slab']);
  const totals = new Map<string, GroupTotals>();
  for (const obj of objects) {
    if (!isCountableObject(obj)) continue;
    if (!AGG_TYPES.has(obj.type)) continue;
    const m = measure(obj, factor);
    const g = totals.get(obj.type) ?? { count: 0, length: 0, area: 0, perimeter: 0 };
    g.count += 1;
    g.length += m.length;
    g.area += m.area;
    g.perimeter += m.perimeter;
    totals.set(obj.type, g);
  }

  const { floorHeight: H, wallThickness: T, beamDepth: D } = assumptions;
  const rows: TakeoffEngineRow[] = [];

  const push = (key: TakeoffRowKey, group: string, unit: string, quantity: number, formula: string) => {
    if (allowedKeys && !allowedKeys.has(key)) return;
    const q = round3(quantity);
    if (q <= 0) return;
    const cand = normCandidates[key];
    let note = `${formula} [nhóm:${group}]`;
    let code = '';
    let name = DEFAULT_NAMES[key];
    let source = '—';
    let webSourced: boolean | undefined;
    let fallback: boolean | undefined;
    if (cand && cand.code && cand.fallback) {
      // Mã phổ thông mặc định (Edit bật) — badge vàng như web, KHÔNG có giá, KHÔNG 'government'.
      // Tên hiển thị LUÔN dùng tên chuẩn engine (không lấy tên web dài/viết hoa).
      code = cand.code;
      name = DEFAULT_NAMES[key];
      source = 'AI đề xuất mã phổ thông — cần kiểm chứng';
      note += ' ⚠ mã phổ thông mặc định — cần kiểm chứng';
      webSourced = true;
      fallback = true;
    } else if (cand && cand.code && cand.webSource) {
      // Mã tra từ web: tên hiển thị LUÔN dùng tên chuẩn engine; tên web chỉ để đối
      // chiếu (ghi ngắn trong Nguồn). Nguồn "Web: …" — KHÔNG BAO GIỜ 'government'.
      code = cand.code;
      name = DEFAULT_NAMES[key];
      source = `Web: ${cand.webSource.title ?? cand.webSource.uri ?? 'nguồn web'}`;
      note += ' ⚠ mã tra từ web — cần kiểm chứng';
      webSourced = true;
    } else if (cand && cand.code) {
      // Mã DB: giữ tên DB nếu gọn, chuẩn hoá về tên engine nếu lộn xộn/viết hoa dài.
      code = cand.code;
      name = standardDisplayName(key, cand.name);
      source = cand.sourceDoc || 'định mức import';
    } else {
      note += ' ⚠ cần chọn mã — chưa import định mức';
    }
    rows.push({ key, group, boqGroup: BOQ_GROUP[key], code, name, unit, quantity: q, note, source, ...(webSourced && { webSourced }), ...(fallback && { fallback }) });
  };

  const wall = totals.get('wall');
  if (wall) {
    const m2 = round3(wall.length * H);
    push('wall_area', 'wall', 'm2', m2, `${f3(wall.length)}m × ${f3(H)}m = ${f3(m2)} m²`);
    push(
      'wall_volume',
      'wall',
      'm3',
      m2 * T,
      `${f3(m2)} m² × ${f3(T)}m = ${f3(m2 * T)} m³`,
    );
    // Bả + sơn: cùng diện tích bề mặt trát (hệ số 1:1 ghi rõ, không nhân khống).
    push(
      'wall_paint',
      'wall',
      'm2',
      m2,
      `bả+sơn theo diện tích trát: ${f3(m2)} m² × 1 (hệ số 1:1) = ${f3(m2)} m²`,
    );
    // Len/chân tường: chạy dọc chân tường ≈ chiều dài tường (suy ra, cần đối chiếu).
    push(
      'skirting',
      'wall',
      'm',
      wall.length,
      `len/chân tường theo chiều dài tường = ${f3(wall.length)} m`,
    );
  }

  const column = totals.get('column');
  if (column) {
    push(
      'column_concrete',
      'column',
      'm3',
      column.area * H,
      `${f3(column.area)} m² tiết diện (${column.count} cột) × ${f3(H)}m = ${f3(column.area * H)} m³`,
    );
    push(
      'column_formwork',
      'column',
      'm2',
      column.perimeter * H,
      `chu vi ${f3(column.perimeter)}m (≈2×(w+h) bbox mỗi cột) × ${f3(H)}m = ${f3(column.perimeter * H)} m²`,
    );
  }

  const beam = totals.get('beam');
  if (beam) {
    const W = ASSUMED_BEAM_WIDTH;
    push(
      'beam_concrete',
      'beam',
      'm3',
      beam.length * D * W,
      `${f3(beam.length)}m × ${f3(D)}m × ${f3(W)}m = ${f3(beam.length * D * W)} m³`,
    );
    const fw = D * 2 + W;
    push(
      'beam_formwork',
      'beam',
      'm2',
      beam.length * fw,
      `${f3(beam.length)}m × (${f3(D)}×2 + ${f3(W)})m = ${f3(beam.length * fw)} m²`,
    );
  }

  const door = totals.get('door');
  if (door) {
    push('door', 'door', 'm2', door.area, `tổng diện tích ${door.count} cửa = ${f3(door.area)} m²`);
  }

  // Cửa sổ + lỗ mở (opening): gộp diện tích — opening trên mặt bằng không có cánh
  // thường là cửa sổ/ô thoáng. Đo m² như cửa.
  const window = totals.get('window');
  const opening = totals.get('opening');
  const winArea = (window?.area ?? 0) + (opening?.area ?? 0);
  const winCount = (window?.count ?? 0) + (opening?.count ?? 0);
  if (winArea > 0) {
    const openNote = opening?.count ? ` (gồm ${opening.count} lỗ mở)` : '';
    push('window', 'window', 'm2', winArea, `tổng diện tích ${winCount} cửa sổ/lỗ mở = ${f3(winArea)} m²${openNote}`);
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
  const vnd = (v?: number) => (v != null ? v.toLocaleString('vi-VN') : '');
  const lines = [
    '| STT | Mã hiệu | Tên công tác | Đơn vị | Khối lượng | Đơn giá | Thành tiền | Nguồn | Diễn giải |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  rows.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.code} | ${r.name} | ${r.unit} | ${r.quantity} | ${vnd(r.unitPrice)} | ${vnd(r.totalPrice)} | ${r.source ?? '—'} | ${r.note} |`,
    );
  });
  return lines.join('\n');
}

/** 1 dòng chú thích giả định (gom về cuối bảng — không lặp mỗi dòng). */
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
  ) {}

  /** Tra norm_items theo keyword — KHÔNG hardcode mã; không có DB match → undefined. */
  private async findNormCandidates(keys: TakeoffRowKey[]): Promise<NormCandidateMap> {
    const map: NormCandidateMap = {};
    await Promise.all(
      keys.map(async (key) => {
        for (const kw of NORM_KEYWORDS[key]) {
          const hit = await this.normModel
            .findOne({ name: { $regex: kw, $options: 'i' } })
            .sort({ code: 1 })
            .lean();
          if (hit) {
            map[key] = {
              code: hit.code,
              name: hit.name,
              unit: hit.unit,
              sourceDoc: hit.sourceDoc,
              components: (hit.components ?? []) as NormComponent[],
            };
            return;
          }
        }
      }),
    );
    return map;
  }

  async run(userId: string, estimateId: string, input: TakeoffEngineInput) {
    const doc = await this.estimates.getOwned(userId, estimateId);
    const state: EstimateState = this.estimates.stateForPrompt(doc);

    // Bộ môn của bản vẽ đang bóc → lọc rowKey; và tập bộ môn đã có trong
    // estimate → checklist phản ánh đúng cái còn thiếu thật.
    const drawingDoc = await this.drawingModel.findById(input.drawingId).select('discipline').lean();
    const discipline = drawingDoc?.discipline;
    const allowedKeys = rowKeysForDiscipline(discipline);
    const estDrawings = await this.drawingModel.find({ estimateId }).select('discipline').lean();
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

    const allKeys = Object.keys(NORM_KEYWORDS) as TakeoffRowKey[];
    const normCandidates = await this.findNormCandidates(allKeys);

    // Edit bật ("hoàn thiện bảng" 1 lệnh): dòng thiếu mã DB → gán mã phổ thông
    // chuẩn (COMMON_FALLBACK_CODES) TRƯỚC web — mã chuẩn của engine thắng mã web
    // lạc nhóm (vd web trả AF.12400 "BÊ TÔNG SÀN MÁI" cho slab chung). KHÔNG bịa giá.
    let fallbackCount = 0;
    if (input.editPermission) {
      const probe = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates, allowedKeys);
      for (const r of probe.filter((row) => !row.code)) {
        const fb = COMMON_FALLBACK_CODES[r.key];
        if (!fb) continue;
        normCandidates[r.key] = { code: fb.code, name: fb.name, unit: '', fallback: true };
        fallbackCount++;
      }
    }

    // Tầng web: CHỈ tra cho dòng VẪN thiếu mã sau DB + fallback (nhóm chuẩn đã có
    // fallback thắng ở trên) → grounded search, chống bịa 3 rào. Tránh đốt quota.
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
          if (hit) {
            webHitCount++;
            normCandidates[key] = {
              code: hit.code,
              name: hit.name,
              unit: '',
              webSource: { title: hit.sourceTitle, uri: hit.sourceUri },
            };
          }
        }
      }
    }

    const bareRows = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates, allowedKeys);

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
    let rows = applyPricingToRows(bareRows, normCandidates, priceCtx);

    // Tra ĐƠN GIÁ từ web cho các dòng CHƯA có giá tỉnh chính thống (grounded search,
    // chống bịa 3 rào, gắn cờ "cần kiểm chứng" + link nguồn). Chỉ khi Edit bật.
    let webPricedCount = 0;
    const webPriceHits: WebPriceHit[] = [];
    if (input.editPermission && this.priceWeb.enabled) {
      // Nhiều SWEEP: dòng thiếu giá ở lần 1 (thường do 429 quota tạm) được tra lại
      // ở lần sau → điền đầy đủ hơn. Miss THẬT (grounding có nhưng web không có giá)
      // đã cache nên sweep sau không tốn thêm quota cho nó.
      const SWEEPS = Number(input.editPermission ? 2 : 0);
      for (let sweep = 0; sweep < SWEEPS; sweep++) {
        const need = rows.filter((r) => r.code && r.unitPrice == null);
        if (need.length === 0) break;
        const hits = await this.priceWeb.lookupPrices(
          need.map((r) => ({ key: r.key, workName: r.name, unit: r.unit })),
          state.projectInfo?.location,
        );
        let filledThisSweep = 0;
        rows = rows.map((r) => {
          const h = r.unitPrice == null ? hits.get(r.key) : null;
          if (h) {
            webPricedCount++;
            filledThisSweep++;
            webPriceHits.push(h);
            return {
              ...r,
              unitPrice: h.unitPrice,
              totalPrice: Math.round(h.unitPrice * r.quantity),
              source: h.sourceTitle ? `Web: ${h.sourceTitle} — cần kiểm chứng` : 'Giá web — cần kiểm chứng',
              pricedFromWeb: true,
            };
          }
          return r;
        });
        // Không điền thêm được gì ở sweep này → dừng (miss THẬT, sweep nữa vô ích).
        if (filledThisSweep === 0) break;
      }
    }

    // Phát hiện DWG chứa nhiều bản vẽ con (nhiều mặt bằng/mặt đứng/chi tiết cạnh
    // nhau trong 1 model space). Chỉ cảnh báo khi KHÔNG bóc theo vùng — vì lúc đó
    // "bóc toàn bộ" cộng dồn tất cả cụm → khối lượng phồng.
    const clusterInfo = input.region
      ? { clusters: 1, spanM: 0 }
      : countObjectClusters(objects as unknown as EngineDrawingObject[], input.unitsPerDrawingUnit);
    const multiDrawing = clusterInfo.clusters >= 2;

    // Id deterministic theo bản vẽ + dòng → bóc lại N lần vẫn chỉ 1 bộ (reducer upsert theo id).
    const engineTakeoffId = (key: string) => `tk_engine_${input.drawingId}_${key}`;
    const newEngineIds = new Set(rows.map((r) => engineTakeoffId(r.key)));
    // Dọn bộ bóc cũ (engine/LLM đã nhân bản trước fix): item có token [nhóm:
    // mà không thuộc bộ id engine mới → delete để bộ MỚI NHẤT thay thế trọn.
    const staleTakeoffs = (state.takeoff ?? []).filter(
      (t) => typeof t.note === 'string' && t.note.includes('[nhóm:') && !newEngineIds.has(t.id),
    );
    const cleanupActions: Action[] = staleTakeoffs.map((t) => ({ type: 'delete_takeoff', id: t.id }));

    const takeoffActions: Action[] = rows.map((r) => ({
      type: 'upsert_takeoff',
      id: engineTakeoffId(r.key),
      group: r.boqGroup,
      code: r.code,
      name: r.name,
      unit: r.unit,
      quantity: r.quantity,
      note: r.note,
    }));
    const a = input.assumptions;
    // Route mỗi dòng vào sheet công tác của nó (structure/finishing/openings) —
    // STT khởi động lại theo từng sheet, header màu riêng. Chú thích giả định chỉ
    // ghi ở sheet cuối cùng có dữ liệu để tránh lặp.
    const rowsBySheet = new Map<string, TakeoffEngineRow[]>();
    for (const r of rows) {
      const sk = ROWKEY_SHEET[r.key] ?? BOQ_SHEETS[0].key;
      (rowsBySheet.get(sk) ?? rowsBySheet.set(sk, []).get(sk)!).push(r);
    }
    const filledSheets = BOQ_SHEETS.filter((s) => (rowsBySheet.get(s.key)?.length ?? 0) > 0);
    const mirrorActions: Action[] = [];
    filledSheets.forEach((sheetDef, si) => {
      const sheetRows = rowsBySheet.get(sheetDef.key)!;
      const isLast = si === filledSheets.length - 1;
      const mirror = rowsToUpdateCells(
        sheetRows.map((r, i) => ({
          stt: String(i + 1),
          code: r.code,
          name: r.name,
          unit: r.unit,
          quantity: String(r.quantity),
          note: r.note,
          unitPrice: r.unitPrice != null ? String(r.unitPrice) : '',
          total: r.totalPrice != null ? String(r.totalPrice) : '',
          source: r.source ?? '—',
        })),
        state,
        sheetDef.name,
        {
          title: sheetDef.name.toUpperCase(),
          theme: { tint: sheetDef.tint, accent: sheetDef.accent },
          ...(isLast ? { footnote: assumptionFootnote(a) } : {}),
        },
      );
      if (mirror) mirrorActions.push(...mirror.actions, mirror.formatAction);
    });
    // format_sheet đi SAU block update_cells: widths + header + border + căn số + chú thích italic.
    const actions: Action[] = [
      ...cleanupActions,
      ...takeoffActions,
      ...mirrorActions,
    ];

    const groups = [...new Set(rows.map((r) => r.group))];
    const missingCode = rows.filter((r) => !r.code);
    const fallbackRows = rows.filter((r) => r.fallback);
    const webCode = rows.filter((r) => r.webSourced && !r.fallback);
    const missingPrice = rows.filter((r) => r.unitPrice == null);
    const pricedCount = rows.length - missingPrice.length;
    const message = [
      `Đã bóc khối lượng ${rows.length} dòng từ ${groups.length} nhóm cấu kiện (${groups.join(', ')}) — ${objects.length} đối tượng hình học${rejected.size ? `, đã loại ${rejected.size} đối tượng bị từ chối` : ''}${regionKept != null ? `. Bóc TRONG VÙNG CHỌN: chỉ tính ${regionKept}/${regionTotal} đối tượng nằm trong vùng` : ''}.`,
      `Giả định: cao tầng ${a.floorHeight}m, dày tường ${a.wallThickness}m, cao dầm ${a.beamDepth}m, bề rộng dầm ${ASSUMED_BEAM_WIDTH}m, tỷ lệ ${input.unitsPerDrawingUnit} m/đơn vị vẽ.`,
      `Khối lượng do máy tính từ hình học bản vẽ — không phải AI ước lượng.`,
      ...(multiDrawing
        ? [
            `⚠ PHẠM VI: model space có ~${clusterInfo.clusters} cụm bản vẽ (trải ~${Math.round(clusterInfo.spanM)}m) — thường là nhiều mặt bằng/mặt đứng/chi tiết đặt cạnh nhau. Số trên là TỔNG tất cả các cụm. Để bóc riêng 1 mặt bằng, dùng "Bóc trong vùng" (kéo chọn vùng quanh mặt bằng) rồi bóc lại.`,
          ]
        : []),
      ...(webCode.length > 0
        ? [
            `Mã hiệu: ${webCode.length} công tác không có trong norm_items — đã tra từ web (grounded search, chậm hơn bình thường); mã web CẦN KIỂM CHỨNG trước khi dùng.`,
          ]
        : []),
      ...(fallbackRows.length > 0
        ? [
            `Đã điền mã phổ thông cho ${fallbackRows.length} dòng (cần kiểm chứng theo chỉ dẫn kỹ thuật) — chưa có đơn giá vì chưa import giá tỉnh.`,
          ]
        : []),
      priceCtx
        ? `Đơn giá: ${pricedCount}/${rows.length} công tác gán từ công bố giá ${priceCtx.province} (${priceCtx.sourceDoc}, hiệu lực ${priceCtx.effectiveDate})${missingPrice.length ? `; ${missingPrice.length} công tác chưa có giá — cột giá để trống` : ''}.`
        : `Đơn giá: chưa có công bố giá tỉnh khớp địa điểm dự án — cột giá để trống (import tại /settings).`,
      ...(webPricedCount > 0
        ? [
            `Đã tra ĐƠN GIÁ từ web (grounded search) cho ${webPricedCount} công tác${state.projectInfo?.location ? ` tại ${state.projectInfo.location}` : ''} — điền cột Đơn giá/Thành tiền kèm link nguồn; giá web CẦN KIỂM CHỨNG, KHÔNG phải giá chính thống.`,
          ]
        : []),
      `BOQ hiện chỉ từ bản kiến trúc — ${CHECKLIST_QS.length} nhóm công tác cần bản vẽ kết cấu/MEP để bóc đầy đủ.`,
      '',
      rowsToMarkdownTable(rows),
      '',
      renderChecklistQs(existingDisciplines),
      '',
      summarizeDetectedObjects(objects as unknown as EngineDrawingObject[]),
    ].join('\n');

    const hs = hatchSlabStats(objects as unknown as EngineDrawingObject[], input.unitsPerDrawingUnit);

    const findings: ValidationFinding[] = missingCode.map((r, i) => ({
      id: `takeoff-engine-code-${i + 1}`,
      severity: 'warn',
      area: 'missing',
      title: `Thiếu mã định mức: ${r.name}`,
      detail: `Dòng "${r.name}" (${r.quantity} ${r.unit}) chưa có mã trong norm_items — cần import bộ định mức hoặc chọn mã thủ công.`,
    }));
    if (missingPrice.length > 0) {
      findings.push({
        id: 'takeoff-engine-price',
        severity: 'warn',
        area: 'unitPrice',
        title: `Chưa có đơn giá cho ${missingPrice.length} công tác`,
        detail: `${missingPrice.length}/${rows.length} công tác chưa có đơn giá${priceCtx ? ` trong công bố giá ${priceCtx.province} (${priceCtx.sourceDoc} ${priceCtx.effectiveDate})` : ' — chưa khớp công bố giá tỉnh nào'} — import công bố giá tỉnh tại /settings. Engine KHÔNG ước lượng giá.`,
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
    // Minh bạch phạm vi: bản kiến trúc chỉ bóc được 1 phần BOQ — liệt kê nhóm còn thiếu.
    // Đây là ghi chú (info), KHÔNG sinh action/số cho các mục cần bổ sung.
    findings.push({
      id: 'takeoff-engine-checklist-qs',
      severity: 'info',
      area: 'missing',
      title: `BOQ chỉ từ bản kiến trúc — ${CHECKLIST_QS.length} nhóm cần bản vẽ kết cấu/MEP`,
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
    if (multiDrawing) {
      findings.push({
        id: 'takeoff-engine-multi-drawing',
        severity: 'warn',
        area: 'quantity',
        title: `Bản vẽ chứa ~${clusterInfo.clusters} cụm — khối lượng là TỔNG tất cả`,
        detail: `Model space có ~${clusterInfo.clusters} cụm đối tượng cách xa nhau (trải ~${Math.round(clusterInfo.spanM)}m) — thường là nhiều mặt bằng/mặt đứng/chi tiết đặt cạnh nhau trong cùng file. "Bóc toàn bộ" đã cộng dồn TẤT CẢ. Để bóc đúng 1 mặt bằng: dùng "Bóc trong vùng" — kéo chọn vùng bao quanh mặt bằng cần bóc rồi bóc lại.`,
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
    if (fallbackRows.length > 0) {
      findings.push({
        id: 'takeoff-engine-fallback-code',
        severity: 'warn',
        area: 'missing',
        title: `${fallbackRows.length} mã phổ thông mặc định — cần kiểm chứng`,
        detail: `${fallbackRows.length} công tác dùng mã phổ thông mặc định (TT12/2021) do chưa import định mức — cần kiểm chứng theo chỉ dẫn kỹ thuật; chưa có đơn giá.`,
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
    // đủ mã DB + đủ giá → 90; có mã web/mã phổ thông → 70; đủ mã DB thiếu giá → 75; thiếu mã hẳn → 55
    const softCode = webCode.length + fallbackRows.length;
    const score =
      missingCode.length > 0 ? 55 : softCode > 0 ? 70 : missingPrice.length > 0 ? 75 : 90;
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
      sources.push({ title: h.sourceTitle, uri: h.sourceUri, type: 'web' });
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
        ...(multiDrawing
          ? [`Phát hiện ~${clusterInfo.clusters} cụm bản vẽ trong model space (trải ~${Math.round(clusterInfo.spanM)}m) → cảnh báo khối lượng là TỔNG, nên bóc theo vùng.`]
          : []),
        ...(hs.count > 0
          ? [`Hatch: ${hs.used}/${hs.count} mảng đủ tin cậy → diện tích sàn/nền ${hs.area} m² (bỏ ${hs.dropped} ngoài ngưỡng).`]
          : []),
        `Tra mã định mức trong norm_items: ${rows.length - missingCode.length - webCode.length}/${rows.length} dòng có mã DB.`,
        ...(staleTakeoffs.length > 0 ? [`Thay thế ${staleTakeoffs.length} dòng bóc cũ.`] : []),
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
