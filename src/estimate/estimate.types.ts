// ===== Resource-based QS estimate model (F1/G8 style, 9 sheets) =====

export interface ProjectInfo {
  name?: string;
  location?: string;
  investor?: string; // chủ đầu tư
  dateCreated?: string;
  preparedBy?: string; // người lập
  normVersion?: string; // phiên bản định mức, e.g. "1776/BXD"
  priceVersion?: string; // phiên bản giá, e.g. "Q2/2026"
  buildingType?: string;
  floors?: number;
  area?: string;
  note?: string;
}

// Kind of price source — drives reliability deterministically (Source Ranking Engine).
export type SourceType =
  | 'government' // thông báo giá Sở/Bộ Xây dựng, định mức nhà nước
  | 'supplier' // báo giá nhà cung cấp/đại lý
  | 'market' // khảo sát thị trường, sàn TMĐT
  | 'forum' // diễn đàn, hỏi đáp
  | 'ai_estimate' // AI tự suy luận, không nguồn
  | 'manual'; // người dùng nhập tay

// Traceable price provenance (data transparency)
export interface PriceSource {
  name?: string; // tên nguồn, e.g. "Steel Online", "Thông báo giá Bình Dương"
  date?: string; // ngày cập nhật, e.g. "Q2/2026" hoặc "22/06/2026"
  region?: string; // khu vực
  type?: SourceType; // loại nguồn — backend chấm reliability theo loại
  confidence?: number; // độ tin cậy 0–100 (DERIVED từ type, không để AI tự bịa)
  url?: string; // link nguồn
}

// Sheet 05 — giá vật liệu
export interface Material {
  id: string;
  code: string; // mã vật tư, e.g. "VL.XM"
  name: string;
  unit: string;
  price: number; // đơn giá (VND)
  source?: PriceSource; // nguồn giá truy vết được
}

// Sheet 06 — giá nhân công
export interface Labor {
  id: string;
  grade: string; // bậc thợ, e.g. "3.5/7"
  name: string;
  dayRate: number; // lương ngày (VND/công)
  source?: PriceSource;
}

// Sheet 07 — giá ca máy
export interface Equipment {
  id: string;
  code: string;
  name: string;
  unit: string; // "ca"
  shiftRate: number; // đơn giá ca (VND/ca)
  source?: PriceSource;
}

export type ResourceKind = 'material' | 'labor' | 'equipment';

// One định mức line inside a unit-price analysis (Sheet 04)
export interface AnalysisComponent {
  kind: ResourceKind;
  ref: string; // resource code (Material.code / Labor.grade / Equipment.code)
  name?: string; // display fallback
  unit?: string;
  norm: number; // định mức hao phí / đơn vị công tác
}

// Sheet 04 — phân tích đơn giá (per work code)
export interface UnitPriceAnalysis {
  id: string;
  code: string; // mã hiệu công tác, e.g. "AF.61120"
  name: string;
  unit: string;
  components: AnalysisComponent[];
}

// Sheet 02 — bóc tách khối lượng
export interface TakeoffItem {
  id: string;
  group?: string; // hạng mục/công trình (Móng, Thân, Nhà chính…)
  code: string; // mã hiệu công tác (links to analysis)
  name: string;
  unit: string;
  length?: number;
  width?: number;
  height?: number;
  count?: number; // số lượng/số cấu kiện
  formula?: string; // công thức (text, để truy vết)
  note?: string; // diễn giải dòng bóc tách (vd "Sàn tầng 1", "Dầm biên trục A")
  quantity: number; // khối lượng kết quả
}

// Sheet 09 — hệ số chi phí
export interface Markups {
  overheadPct: number; // chi phí chung (%)
  profitPct: number; // thu nhập chịu thuế tính trước (%)
  vatPct: number; // VAT (%)
  contingencyPct: number; // dự phòng (%)
}

export interface Sheet {
  id: string;
  name: string;
  metadata?: Record<string, any>;
  data: any;
}

export interface EntityMap {
  entityId: string;
  sheetId: string;
  semanticPath: string;
}

export interface Workbook {
  id: string;
  userId: string;
  name: string;
  sheets: Sheet[];
  entityMaps?: EntityMap[];
  activityLog?: ActivityEntry[];
}

export interface EstimateState {
  projectInfo: ProjectInfo;
  takeoff: TakeoffItem[];
  analyses: UnitPriceAnalysis[];
  materials: Material[];
  labor: Labor[];
  equipment: Equipment[];
  markups: Markups;
  sheets?: Sheet[];
  entityMaps?: EntityMap[];
  patchHistory?: Patch[];
}

export const DEFAULT_MARKUPS: Markups = {
  overheadPct: 6.5,
  profitPct: 5.5,
  vatPct: 8,
  contingencyPct: 5,
};

// ===== Copilot action vocabulary (reducer) =====
export type Action =
  | { type: 'set_project_info'; patch: Partial<ProjectInfo> }
  | { type: 'set_markups'; patch: Partial<Markups> }
  | { type: 'upsert_material'; id?: string; code: string; name: string; unit: string; price: number; source?: PriceSource }
  | { type: 'delete_material'; id: string }
  | { type: 'upsert_labor'; id?: string; grade: string; name: string; dayRate: number; source?: PriceSource }
  | { type: 'delete_labor'; id: string }
  | { type: 'upsert_equipment'; id?: string; code: string; name: string; unit: string; shiftRate: number; source?: PriceSource }
  | { type: 'delete_equipment'; id: string }
  | {
      type: 'upsert_analysis';
      id?: string;
      code: string;
      name: string;
      unit: string;
      components: AnalysisComponent[];
    }
  | { type: 'delete_analysis'; id: string }
  | {
      type: 'upsert_takeoff';
      id?: string;
      group?: string;
      code: string;
      name: string;
      unit: string;
      length?: number;
      width?: number;
      height?: number;
      count?: number;
      formula?: string;
      note?: string;
      quantity?: number;
    }
  | { type: 'delete_takeoff'; id: string }
  | {
      type: 'update_cells';
      sheetId: string;
      cell: string;
      oldValue: string;
      newValue: string;
      entityId?: string;
    }
  | {
      // Định dạng trình bày sheet (độ rộng cột + style ô inline theo shape Univer).
      type: 'format_sheet';
      sheetId: string;
      /** colIndex ("0"-based, dạng string) → độ rộng px. */
      columnWidths?: Record<string, number>;
      /** Style object Univer gắn inline vào cell.s (giữ nguyên v/f hiện có). */
      cells?: { cell: string; s: Record<string, any> }[];
      /** Vùng merge (0-based, Univer IRange) — vd thanh tiêu đề trải hết cột. */
      merges?: { startRow: number; startColumn: number; endRow: number; endColumn: number }[];
    }
  | { type: 'set_sheets'; sheets: Sheet[] }
  | { type: 'clear' };

// ===== Computed (DTO only) =====
export interface BoqRow {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  material: number; // đơn giá VL
  labor: number; // đơn giá NC
  machine: number; // đơn giá máy
  unitPrice: number;
  total: number;
}

export interface MaterialSummaryRow {
  kind: ResourceKind;
  ref: string;
  name: string;
  unit: string;
  quantity: number; // tổng hao phí
  price: number;
  amount: number;
}

export interface CostSummary {
  directMaterial: number;
  directLabor: number;
  directMachine: number;
  directTotal: number; // A
  overhead: number; // B
  profit: number; // C
  preTax: number; // A+B+C
  vat: number; // D
  contingency: number; // E
  total: number; // F
}

export interface Costs {
  material: number;
  labor: number;
  machine: number;
  total: number;
}

// ===== Data transparency =====

/** One entry in the AI/manual change log (replaces "đã áp dụng N thay đổi"). */
export interface ActivityEntry {
  at: string; // ISO timestamp
  source: 'ai' | 'manual';
  kind: string; // action type
  label: string; // human-readable, e.g. "Cập nhật giá thép"
  detail?: string; // e.g. "17.000 → 22.000"
}

export interface PatchChange {
  op: 'update' | 'insert' | 'delete';
  sheetId?: string;
  cell?: string;
  path?: string; // e.g. "materials", "takeoff", "projectInfo"
  entityId?: string;
  oldValue: any;
  newValue: any;
}

export interface Patch {
  id: string;
  actor: 'ai' | 'manual';
  timestamp: string;
  description: string;
  changes: PatchChange[];
}

export interface Confidence {
  boq?: number;
  materials?: number;
  labor?: number;
  equipment?: number;
  overall?: number;
  reasons?: string[]; // căn cứ cho điểm tin cậy (vd "Diện tích sàn đầy đủ")
  missing?: string[]; // dữ liệu còn thiếu (vd "Bản vẽ kết cấu")
  uncertaintyPct?: number; // sai số ước lượng ±%
}

// ===== Trace engine (auditable derivation per BOQ item) =====

/** One take-off line feeding a BOQ quantity (with its dimensions & formula). */
export interface QuantityTraceLine {
  takeoffId: string;
  note?: string;
  group?: string;
  formula?: string;
  dims?: { length?: number; width?: number; height?: number; count?: number };
  quantity: number;
}

/** One định mức component of a unit price, fully resolved to its source. */
export interface UnitPriceComponentTrace {
  kind: ResourceKind;
  ref: string;
  name: string;
  unit?: string;
  norm: number; // định mức
  price: number; // đơn giá tài nguyên
  amount: number; // norm × price
  source?: PriceSource;
}

/** Full audit trail for a BOQ line: Source → Assumption → Formula → Quantity → Unit price → Cost. */
export interface TraceItem {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  material: number;
  labor: number;
  machine: number;
  total: number;
  assumptions: string[]; // diễn giải từ note bóc tách
  quantityTrace: QuantityTraceLine[];
  components: UnitPriceComponentTrace[];
}

// ===== Validation & consistency (AI self-check) =====

/** Market benchmark to sanity-check the estimate total (AI-provided or static table). */
export interface Benchmark {
  metric: 'total' | 'perM2';
  low: number;
  high: number;
  mid?: number;
  source?: { name?: string; url?: string; date?: string };
  basis?: string; // diễn giải cách suy ra (vd "Suất đầu tư nhà phố 6–8 tr/m²")
}

export type ValidationStatus = 'reasonable' | 'warning' | 'unrealistic';

export type ValidationArea =
  | 'quantity'
  | 'unitPrice'
  | 'total'
  | 'missing'
  | 'benchmark'
  | 'source';

/** One sanity/benchmark finding from the validation engine. */
export interface ValidationFinding {
  id: string;
  severity: 'info' | 'warn' | 'error';
  area: ValidationArea;
  title: string;
  detail: string;
  refCode?: string;
  expected?: string;
  actual?: string;
  deviationPct?: number;
}

export type ConsistencyKind =
  | 'orphan_takeoff' // công tác có KL nhưng thiếu phân tích đơn giá
  | 'unresolved_ref' // component trỏ tới tài nguyên không tồn tại
  | 'empty_analysis' // phân tích đơn giá rỗng / đơn giá = 0
  | 'zero_price' // tài nguyên đang dùng nhưng giá ≤ 0
  | 'sum_mismatch'; // tổng mức không khớp tái dựng A→F

/** One cross-sheet consistency issue. */
export interface ConsistencyIssue {
  id: string;
  severity: 'warn' | 'error';
  kind: ConsistencyKind;
  message: string;
  refCode?: string;
}

/** Full self-check report — computed live in the DTO and embedded in proposals. */
export interface ValidationReport {
  status: ValidationStatus;
  score: number; // 0-100 mức độ "đáng tin"
  benchmark?: Benchmark;
  deviationPct?: number; // lệch của total so với benchmark mid
  findings: ValidationFinding[];
  consistency: ConsistencyIssue[];
}

/** Effect of applying a batch of actions (dry-run, for the change preview). */
export interface ProposalPreview {
  counts: { kind: string; added: number; updated: number; removed: number }[];
  costBefore: number;
  costAfter: number;
  costDelta: number;
  diffs: { ref: string; field: string; from: string; to: string }[];
}
