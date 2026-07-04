// Deterministic Takeoff Engine — khối lượng tính bằng CODE từ hình học bản vẽ,
// mã hiệu tra từ DB norm_items thật. KHÔNG có LLM call nào ở đây.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NormItem } from '../catalog/catalog-db.schemas';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { EstimateService } from './estimate.service';
import { Action, EstimateState, ValidationFinding, ValidationReport } from './estimate.types';
import { rowsToUpdateCells } from './markdown-table-actions';
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
  note: string;
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
    if (cand && cand.code) {
      code = cand.code;
      name = cand.name || name;
      note += ` — mã từ ${cand.sourceDoc || 'import'}`;
    } else {
      note += ' ⚠ cần chọn mã định mức (chưa import bộ định mức)';
    }
    rows.push({ key, group, code, name, unit, quantity: q, note });
  };

  const wall = totals.get('wall');
  if (wall) {
    const m2 = round3(wall.length * H);
    push('wall_area', 'wall', 'm2', m2, `${f3(wall.length)}m × ${f3(H)}m = ${f3(m2)} m² (cao tầng giả định ${f3(H)}m)`);
    push(
      'wall_volume',
      'wall',
      'm3',
      m2 * T,
      `${f3(m2)} m² × ${f3(T)}m = ${f3(m2 * T)} m³ (dày tường giả định ${f3(T)}m)`,
    );
  }

  const column = totals.get('column');
  if (column) {
    push(
      'column_concrete',
      'column',
      'm3',
      column.area * H,
      `${f3(column.area)} m² tiết diện (${column.count} cột) × ${f3(H)}m = ${f3(column.area * H)} m³ (cao tầng giả định ${f3(H)}m)`,
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
      `${f3(beam.length)}m × ${f3(D)}m × ${f3(W)}m = ${f3(beam.length * D * W)} m³ (cao dầm giả định ${f3(D)}m, bề rộng giả định ${f3(W)}m)`,
    );
    const fw = D * 2 + W;
    push(
      'beam_formwork',
      'beam',
      'm2',
      beam.length * fw,
      `${f3(beam.length)}m × (${f3(D)}×2 + ${f3(W)})m = ${f3(beam.length * fw)} m² (bề rộng dầm giả định ${f3(W)}m)`,
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

/** Bảng markdown 6 cột chuẩn (STT/Mã/Tên/ĐV/KL/Ghi chú). */
export function rowsToMarkdownTable(rows: TakeoffEngineRow[]): string {
  const lines = [
    '| STT | Mã hiệu định mức | Tên công tác | Đơn vị | Khối lượng | Ghi chú |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.code} | ${r.name} | ${r.unit} | ${r.quantity} | ${r.note} |`);
  });
  return lines.join('\n');
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
            map[key] = { code: hit.code, name: hit.name, unit: hit.unit, sourceDoc: hit.sourceDoc };
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

    const rows = computeTakeoffRows(objects, input.unitsPerDrawingUnit, input.assumptions, normCandidates);

    const takeoffActions: Action[] = rows.map((r) => ({
      type: 'upsert_takeoff',
      group: r.group,
      code: r.code,
      name: r.name,
      unit: r.unit,
      quantity: r.quantity,
      note: r.note,
    }));
    const mirror = rowsToUpdateCells(
      rows.map((r, i) => ({
        stt: String(i + 1),
        code: r.code,
        name: r.name,
        unit: r.unit,
        quantity: String(r.quantity),
        note: r.note,
      })),
      state,
      'Khối lượng',
    );
    const actions: Action[] = [...takeoffActions, ...(mirror?.actions ?? [])];

    const a = input.assumptions;
    const groups = [...new Set(rows.map((r) => r.group))];
    const missingCode = rows.filter((r) => !r.code);
    const message = [
      `Đã bóc khối lượng ${rows.length} dòng từ ${groups.length} nhóm cấu kiện (${groups.join(', ')}) — ${objects.length} đối tượng hình học${rejected.size ? `, đã loại ${rejected.size} đối tượng bị từ chối` : ''}.`,
      `Giả định: cao tầng ${a.floorHeight}m, dày tường ${a.wallThickness}m, cao dầm ${a.beamDepth}m, bề rộng dầm ${ASSUMED_BEAM_WIDTH}m, tỷ lệ ${input.unitsPerDrawingUnit} m/đơn vị vẽ.`,
      `Khối lượng do máy tính từ hình học bản vẽ — không phải AI ước lượng.`,
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
    findings.push({
      id: 'takeoff-engine-price',
      severity: 'info',
      area: 'unitPrice',
      title: 'Chưa gán đơn giá',
      detail: 'Engine chỉ bóc khối lượng từ hình học; đơn giá/phân tích vật tư cần bước tiếp theo.',
    });
    const validation: ValidationReport = {
      status: missingCode.length === 0 ? 'reasonable' : 'warning',
      score: missingCode.length === 0 ? 80 : 55,
      findings,
      consistency: [],
    };

    return {
      thinking: [
        `Đọc ${rawObjects.length} đối tượng của bản vẽ, giữ ${objects.length} sau khi loại từ chối/không đo được.`,
        `Đo hình học (polyline/shoelace/bbox) × ${input.unitsPerDrawingUnit} m/đơn vị.`,
        `Áp công thức cố định (tường/cột/dầm/cửa) với giả định người dùng.`,
        `Tra mã định mức trong norm_items: ${rows.length - missingCode.length}/${rows.length} dòng có mã.`,
      ],
      message,
      actions,
      sources: [] as { title?: string; uri?: string; type?: string }[],
      preview: previewActions(state, actions),
      validation,
      trace: [],
    };
  }
}
