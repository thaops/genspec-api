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

// Traceable price provenance (data transparency)
export interface PriceSource {
  name?: string; // tên nguồn, e.g. "Steel Online", "Thông báo giá Bình Dương"
  date?: string; // ngày cập nhật, e.g. "Q2/2026" hoặc "22/06/2026"
  region?: string; // khu vực
  confidence?: number; // độ tin cậy 0–100
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

export interface EstimateState {
  projectInfo: ProjectInfo;
  takeoff: TakeoffItem[];
  analyses: UnitPriceAnalysis[];
  materials: Material[];
  labor: Labor[];
  equipment: Equipment[];
  markups: Markups;
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

export interface Confidence {
  boq?: number;
  materials?: number;
  labor?: number;
  equipment?: number;
  overall?: number;
}

/** Effect of applying a batch of actions (dry-run, for the change preview). */
export interface ProposalPreview {
  counts: { kind: string; added: number; updated: number; removed: number }[];
  costBefore: number;
  costAfter: number;
  costDelta: number;
  diffs: { ref: string; field: string; from: string; to: string }[];
}
