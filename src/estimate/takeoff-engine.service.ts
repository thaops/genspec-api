// Deterministic Takeoff Engine — khối lượng tính bằng CODE từ hình học bản vẽ,
// mã hiệu tra từ DB norm_items thật. KHÔNG có LLM call nào ở đây.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NormComponent, NormItem } from '../catalog/catalog-db.schemas';
import { CatalogService, lookupComponentPrice } from '../catalog/catalog.service';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { EstimateService } from './estimate.service';
import { Action, EstimateState, ValidationFinding, ValidationReport } from './estimate.types';
import { rowsToUpdateCells } from './markdown-table-actions';
import { NormWebLookupService } from './norm-web-lookup.service';
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
}

export type TakeoffRowKey =
  | 'wall_area'
  | 'wall_volume'
  | 'column_concrete'
  | 'column_formwork'
  | 'beam_concrete'
  | 'beam_formwork'
  | 'door'
  | 'window'
  | 'slab';

export type NormCandidateMap = Partial<Record<TakeoffRowKey, NormCandidate>>;

export interface TakeoffEngineRow {
  key: TakeoffRowKey;
  group: string; // wall | column | beam | door | window | slab
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

const MEASURED_TYPES = ['wall', 'column', 'beam', 'door', 'window', 'slab'] as const;

/** Keyword tra norm_items theo từng dòng khối lượng (regex, thử theo thứ tự). */
export const NORM_KEYWORDS: Record<TakeoffRowKey, string[]> = {
  wall_area: ['trát tường', 'xây tường'],
  wall_volume: ['xây tường', 'xây.*gạch'],
  column_concrete: ['bê tông.*cột'],
  column_formwork: ['ván khuôn.*cột'],
  beam_concrete: ['bê tông.*dầm'],
  beam_formwork: ['ván khuôn.*dầm'],
  door: ['cửa đi', 'cửa'],
  window: ['cửa sổ', 'cửa'],
  slab: ['bê tông.*sàn'],
};

const DEFAULT_NAMES: Record<TakeoffRowKey, string> = {
  wall_area: 'Xây/trát tường',
  wall_volume: 'Xây tường',
  column_concrete: 'Bê tông cột',
  column_formwork: 'Ván khuôn cột',
  beam_concrete: 'Bê tông dầm',
  beam_formwork: 'Ván khuôn dầm',
  door: 'Cửa đi',
  window: 'Cửa sổ',
  slab: 'Sàn (diện tích)',
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

/**
 * Đo đạc + công thức khối lượng cố định + gán mã định mức từ candidates.
 * factor = unitsPerDrawingUnit (vd bản vẽ mm → factor 0.001 → mét).
 */
export function computeTakeoffRows(
  objects: EngineDrawingObject[],
  factor: number,
  assumptions: TakeoffAssumptions,
  normCandidates: NormCandidateMap,
): TakeoffEngineRow[] {
  const totals = new Map<string, GroupTotals>();
  for (const obj of objects) {
    if (!(MEASURED_TYPES as readonly string[]).includes(obj.type)) continue;
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
    const q = round3(quantity);
    if (q <= 0) return;
    const cand = normCandidates[key];
    let note = `${formula} [nhóm:${group}]`;
    let code = '';
    let name = DEFAULT_NAMES[key];
    let source = '—';
    let webSourced: boolean | undefined;
    if (cand && cand.code && cand.webSource) {
      // Mã tra từ web: giữ tên chuẩn nếu web không có tên tốt hơn; nguồn "Web: …" — KHÔNG BAO GIỜ 'government'.
      code = cand.code;
      name = cand.name || name;
      source = `Web: ${cand.webSource.title ?? cand.webSource.uri ?? 'nguồn web'}`;
      note += ' ⚠ mã tra từ web — cần kiểm chứng';
      webSourced = true;
    } else if (cand && cand.code) {
      code = cand.code;
      name = cand.name || name;
      source = cand.sourceDoc || 'định mức import';
    } else {
      note += ' ⚠ cần chọn mã — chưa import định mức';
    }
    rows.push({ key, group, code, name, unit, quantity: q, note, source, ...(webSourced && { webSourced }) });
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

  const window = totals.get('window');
  if (window) {
    push('window', 'window', 'm2', window.area, `tổng diện tích ${window.count} cửa sổ = ${f3(window.area)} m²`);
  }

  const slab = totals.get('slab');
  if (slab) {
    push('slab', 'slab', 'm2', slab.area, `tổng diện tích ${slab.count} sàn = ${f3(slab.area)} m²`);
  }

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
}

@Injectable()
export class TakeoffEngineService {
  constructor(
    @InjectModel(DrawingObject.name) private readonly drawingObjectModel: Model<DrawingObjectDocument>,
    @InjectModel(NormItem.name) private readonly normModel: Model<NormItem>,
    private readonly estimates: EstimateService,
    private readonly catalog: CatalogService,
    private readonly webLookup: NormWebLookupService,
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

    const rejected = new Set(input.rejectedObjectIds ?? []);
    const rawObjects = await this.drawingObjectModel.find({ drawingId: input.drawingId }).lean();
    if (rawObjects.length === 0) throw new NotFoundException('Bản vẽ chưa có đối tượng nhận diện');
    const objects = rawObjects.filter(
      (o) => !rejected.has(String((o as any)._id)) && !rejected.has(o.stableId),
    );

    const allKeys = Object.keys(NORM_KEYWORDS) as TakeoffRowKey[];
    const normCandidates = await this.findNormCandidates(allKeys);

    // Tầng fallback: dòng thiếu mã DB → tra web (grounded search, chống bịa 3 rào).
    // Chỉ tra cho key thực sự sinh ra dòng (tính thử 1 lượt) — tránh đốt quota vô ích.
    let webLookedUp = 0;
    let webHitCount = 0;
    if (this.webLookup.enabled) {
      const probe = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates);
      const missingKeys = probe.filter((r) => !r.code).map((r) => r.key);
      if (missingKeys.length > 0) {
        webLookedUp = missingKeys.length;
        const hits = await this.webLookup.lookupCodes(
          missingKeys.map((key) => ({ key, workName: DEFAULT_NAMES[key].toLowerCase() })),
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

    const bareRows = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates);

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
    const rows = applyPricingToRows(bareRows, normCandidates, priceCtx);

    const takeoffActions: Action[] = rows.map((r) => ({
      type: 'upsert_takeoff',
      group: r.group,
      code: r.code,
      name: r.name,
      unit: r.unit,
      quantity: r.quantity,
      note: r.note,
    }));
    const a = input.assumptions;
    const mirror = rowsToUpdateCells(
      rows.map((r, i) => ({
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
      'Khối lượng',
      { footnote: assumptionFootnote(a) },
    );
    // format_sheet đi SAU block update_cells: widths + header + border + căn số + chú thích italic.
    const actions: Action[] = [
      ...takeoffActions,
      ...(mirror?.actions ?? []),
      ...(mirror ? [mirror.formatAction] : []),
    ];

    const groups = [...new Set(rows.map((r) => r.group))];
    const missingCode = rows.filter((r) => !r.code);
    const webCode = rows.filter((r) => r.webSourced);
    const missingPrice = rows.filter((r) => r.unitPrice == null);
    const pricedCount = rows.length - missingPrice.length;
    const message = [
      `Đã bóc khối lượng ${rows.length} dòng từ ${groups.length} nhóm cấu kiện (${groups.join(', ')}) — ${objects.length} đối tượng hình học${rejected.size ? `, đã loại ${rejected.size} đối tượng bị từ chối` : ''}.`,
      `Giả định: cao tầng ${a.floorHeight}m, dày tường ${a.wallThickness}m, cao dầm ${a.beamDepth}m, bề rộng dầm ${ASSUMED_BEAM_WIDTH}m, tỷ lệ ${input.unitsPerDrawingUnit} m/đơn vị vẽ.`,
      `Khối lượng do máy tính từ hình học bản vẽ — không phải AI ước lượng.`,
      ...(webCode.length > 0
        ? [
            `Mã hiệu: ${webCode.length} công tác không có trong norm_items — đã tra từ web (grounded search, chậm hơn bình thường); mã web CẦN KIỂM CHỨNG trước khi dùng.`,
          ]
        : []),
      priceCtx
        ? `Đơn giá: ${pricedCount}/${rows.length} công tác gán từ công bố giá ${priceCtx.province} (${priceCtx.sourceDoc}, hiệu lực ${priceCtx.effectiveDate})${missingPrice.length ? `; ${missingPrice.length} công tác chưa có giá — cột giá để trống` : ''}.`
        : `Đơn giá: chưa có công bố giá tỉnh khớp địa điểm dự án — cột giá để trống (import tại /settings).`,
      '',
      rowsToMarkdownTable(rows),
    ].join('\n');

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
    if (webCode.length > 0) {
      findings.push({
        id: 'takeoff-engine-web-code',
        severity: 'warn',
        area: 'missing',
        title: `${webCode.length} mã tra từ web — cần kiểm chứng`,
        detail: `${webCode.length} mã tra từ web — kiểm chứng trước khi dùng; import bộ định mức để có nguồn chính thống.`,
      });
    }
    // đủ mã DB + đủ giá → 90; có mã web → 70; đủ mã DB thiếu giá → 75; thiếu mã hẳn → 55
    const score =
      missingCode.length > 0 ? 55 : webCode.length > 0 ? 70 : missingPrice.length > 0 ? 75 : 90;
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

    return {
      thinking: [
        `Đọc ${rawObjects.length} đối tượng của bản vẽ, giữ ${objects.length} sau khi loại từ chối/không đo được.`,
        `Đo hình học (polyline/shoelace/bbox) × ${input.unitsPerDrawingUnit} m/đơn vị.`,
        `Áp công thức cố định (tường/cột/dầm/cửa) với giả định người dùng.`,
        `Tra mã định mức trong norm_items: ${rows.length - missingCode.length - webCode.length}/${rows.length} dòng có mã DB.`,
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
