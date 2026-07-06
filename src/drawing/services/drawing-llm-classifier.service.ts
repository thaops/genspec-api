import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../../ai/ai.service';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';

/** Types the model may assign — kept in sync with the FE DrawingObjectType union. */
const ALLOWED_TYPES = new Set([
  'beam', 'column', 'wall', 'slab', 'stair', 'roof', 'footing', 'pile',
  'door', 'window', 'opening', 'ramp', 'axis',
  'dimension', 'text', 'hatch', 'symbol', 'ignored', 'unknown',
]);

// Cost guard: never fan out more than this many objects to the LLM in one call.
const MAX_TARGETS = 400;
const BATCH_SIZE = 40;
const CONCURRENCY = 4;

const RESULT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          stableId: { type: 'STRING' },
          type: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          reason: { type: 'STRING' },
        },
        required: ['stableId', 'type'],
      },
    },
  },
  required: ['results'],
};

interface LlmResult {
  stableId: string;
  type: string;
  confidence?: number;
  reason?: string;
}

/**
 * Tier 3 — LLM resolver for the objects Tiers 1/2/2.5 could not settle
 * (ambiguous or 'unknown'). On-demand only: it costs tokens, so the user runs it
 * AFTER the free layer-mapping pass, and only the residual few hundred objects
 * are sent — never the full drawing.
 */
@Injectable()
export class DrawingLlmClassifierService {
  private readonly logger = new Logger(DrawingLlmClassifierService.name);

  constructor(
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly ai: AiService,
  ) {}

  async resolve(drawingId: string) {
    if (!this.ai.available) {
      return { drawingId, resolved: 0, message: 'AI backend chưa cấu hình (GEMINI_API_KEY)' };
    }

    const all = await this.objectModel.find({ drawingId }).lean();
    const targetsAll = all.filter((o) => o.ambiguous || o.type === 'unknown');
    if (!targetsAll.length) return { drawingId, resolved: 0, message: 'Không có đối tượng mơ hồ' };

    const capped = targetsAll.length > MAX_TARGETS;
    const targets = targetsAll.slice(0, MAX_TARGETS);
    const texts = this.buildTextIndex(all);

    const batches: (typeof targets)[] = [];
    for (let i = 0; i < targets.length; i += BATCH_SIZE) batches.push(targets.slice(i, i + BATCH_SIZE));

    const resultMap = new Map<string, LlmResult>();
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(slice.map((b) => this.classifyBatch(b, texts)));
      for (const s of settled) {
        if (s.status === 'fulfilled') for (const r of s.value) resultMap.set(r.stableId, r);
        else this.logger.warn(`LLM batch failed: ${s.reason}`);
      }
    }

    // Apply as a strong vote — boost the returned type in each object's candidate
    // set, never blind-overwrite. Low model confidence stays ambiguous.
    const ops: any[] = [];
    let resolved = 0;
    for (const obj of targets) {
      const r = resultMap.get(obj.stableId);
      if (!r || !ALLOWED_TYPES.has(r.type)) continue;
      const conf = clamp(r.confidence ?? 0.7, 0.3, 0.9);
      const updated = this.mergeVote(obj.candidates ?? [], r.type, conf);
      if (!updated) continue;
      resolved += 1;
      ops.push({
        updateOne: {
          filter: { drawingId, stableId: obj.stableId },
          update: {
            $set: {
              type: updated.type,
              confidence: updated.confidence,
              candidates: updated.candidates,
              ambiguous: updated.ambiguous,
              detectionReason: `AI: ${r.reason ?? r.type} (${Math.round(conf * 100)}%)`,
            },
          },
        },
      });
    }
    if (ops.length) await this.objectModel.bulkWrite(ops, { ordered: false });

    const objects = await this.objectModel.find({ drawingId }).lean();
    return {
      drawingId,
      resolved,
      considered: targets.length,
      skipped: capped ? targetsAll.length - MAX_TARGETS : 0,
      objects,
    };
  }

  /** Merge the LLM vote into the candidate distribution, re-derive argmax + ambiguity. */
  private mergeVote(candidates: { type: string; prob: number }[], type: string, conf: number) {
    const cands = candidates.map((c) => ({ ...c }));
    const hit = cands.find((c) => c.type === type);
    // LLM vote weight scales with its own confidence.
    if (hit) hit.prob = Math.max(hit.prob, conf) + conf * 0.5;
    else cands.push({ type, prob: conf });
    const sorted = cands.filter((c) => c.prob > 0).sort((a, b) => b.prob - a.prob);
    if (!sorted.length) return null;
    const [top, second] = sorted;
    const ambiguous = conf < 0.6 || (!!second && top.prob - second.prob < 0.15);
    return { type: top.type, confidence: Math.min(top.prob, 0.99), candidates: sorted, ambiguous };
  }

  private async classifyBatch(batch: any[], texts: TextIndex): Promise<LlmResult[]> {
    const items = batch.map((o) => {
      const g = geomSummary(o.geometry, o.boundingBox);
      return {
        stableId: o.stableId,
        layer: o.layer,
        entity: o.rawType ?? '',
        current: o.type,
        candidates: (o.candidates ?? []).map((c: any) => `${c.type}:${Math.round(c.prob * 100)}`).join(','),
        length_m: g.length,
        area_m2: g.area,
        aspect: g.aspect,
        closed: g.closed,
        nearbyText: texts.near(o.boundingBox).slice(0, 4),
      };
    });

    const prompt =
      'Bạn là kỹ sư bóc khối lượng (QS) đọc bản vẽ CAD kết cấu/kiến trúc Việt Nam. ' +
      'Với mỗi đối tượng mơ hồ dưới đây, chọn ĐÚNG một loại từ danh sách: ' +
      [...ALLOWED_TYPES].join(', ') + '. ' +
      'Dùng layer name, loại entity, hình học (dài/diện tích/tỉ lệ/khép kín) và text lân cận làm bằng chứng. ' +
      "Nếu là nét chú thích, trục, ký hiệu, khung tên → 'ignored'. Nếu thật sự không đủ bằng chứng → 'unknown' với confidence thấp. " +
      'Đơn vị length_m/area_m2 chỉ tương đối (chưa hiệu chỉnh tỉ lệ). ' +
      'Trả JSON {results:[{stableId,type,confidence(0..1),reason ngắn tiếng Việt}]}.\n\n' +
      JSON.stringify(items);

    const raw = await this.ai.generateJson([{ text: prompt }], RESULT_SCHEMA);
    const parsed = JSON.parse(raw) as { results?: LlmResult[] };
    return parsed.results ?? [];
  }

  /** Index text-type objects by grid cell for O(1) nearby-label lookup. */
  private buildTextIndex(all: any[]): TextIndex {
    const textObjs = all.filter(
      (o) => (o.type === 'text' || o.rawType === 'TEXT' || o.rawType === 'MTEXT') &&
        typeof o.properties?.text === 'string' && o.properties.text.trim(),
    );
    const sizes = all.map((o) => Math.max(o.boundingBox?.w ?? 0, o.boundingBox?.h ?? 0)).filter((v) => v > 0);
    const cell = Math.max(median(sizes) * 3, 1e-6);
    const grid = new Map<string, { cx: number; cy: number; text: string }[]>();
    const key = (cx: number, cy: number) => `${cx}:${cy}`;
    for (const t of textObjs) {
      const b = t.boundingBox;
      const cx = (b.x ?? 0) + (b.w ?? 0) / 2;
      const cy = (b.y ?? 0) + (b.h ?? 0) / 2;
      const k = key(Math.floor(cx / cell), Math.floor(cy / cell));
      (grid.get(k) ?? grid.set(k, []).get(k)!).push({ cx, cy, text: String(t.properties.text).trim() });
    }
    return {
      near: (bb: any) => {
        const px = (bb.x ?? 0) + (bb.w ?? 0) / 2;
        const py = (bb.y ?? 0) + (bb.h ?? 0) / 2;
        const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
        const found: { d: number; text: string }[] = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const t of grid.get(key(gx + dx, gy + dy)) ?? []) {
            found.push({ d: Math.hypot(t.cx - px, t.cy - py), text: t.text });
          }
        }
        return found.sort((a, b) => a.d - b.d).map((f) => f.text);
      },
    };
  }
}

interface TextIndex {
  near(bb: { x?: number; y?: number; w?: number; h?: number }): string[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rough length/area/aspect from geometry (relative units — no calibration here). */
function geomSummary(geometry: number[][] | undefined, bb: { w: number; h: number }) {
  const geo = geometry ?? [];
  let length = 0;
  for (let i = 1; i < geo.length; i++) length += Math.hypot(geo[i][0] - geo[i - 1][0], geo[i][1] - geo[i - 1][1]);
  if (geo.length < 2) length = Math.max(bb.w, bb.h);
  let area = 0;
  if (geo.length >= 3) {
    let a = 0;
    for (let i = 0, j = geo.length - 1; i < geo.length; j = i++) a += (geo[j][0] + geo[i][0]) * (geo[j][1] - geo[i][1]);
    area = Math.abs(a) / 2;
  }
  const closed = geo.length >= 3 && Math.hypot(geo[0][0] - geo[geo.length - 1][0], geo[0][1] - geo[geo.length - 1][1]) < 0.02 * (length || 1);
  const aspect = bb.w > 0 && bb.h > 0 ? Math.max(bb.w, bb.h) / Math.min(bb.w, bb.h) : 1;
  return { length: round2(length), area: round2(closed ? area : 0), aspect: round2(aspect), closed };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
