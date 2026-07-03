import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingRevisionService } from './drawing-revision.service';
import { DrawingComparedEvent } from '../../events/domain-events';

interface BBox { x: number; y: number; w: number; h: number; page?: number }

/** Lean object shape used by the diff (schema fields + mongo _id). */
export interface CompareObject {
  _id?: unknown;
  stableId: string;
  drawingId: string;
  pageId?: string;
  layerId?: string;
  type: string;
  rawType?: string;
  geometry: number[][];
  confidence: number;
  detectionReason?: string;
  layer: string;
  boundingBox: BBox;
  properties: Record<string, string | number>;
  floor?: string;
}

export interface DiffObjectDto {
  id: string;
  stableId: string;
  drawingId: string;
  type: string;
  rawType?: string;
  layer: string;
  boundingBox: BBox;
  geometry: number[][];
  confidence: number;
  properties: Record<string, string | number>;
  floor?: string;
}

export interface ChangedPairDto {
  before: DiffObjectDto; // object in base (old) drawing
  after: DiffObjectDto;  // object in current (new) drawing
  changedFields: string[]; // property keys that differ; 'boundingBox' when bbox moved/resized
  iou: number;
  matchedBy: 'stableId' | 'iou';
}

export interface DrawingDiffV2 {
  drawingId: string;        // current (new) drawing
  againstDrawingId: string; // base (old) drawing
  added: DiffObjectDto[];   // in current, not matched in base
  removed: DiffObjectDto[]; // in base, not matched in current
  changed: ChangedPairDto[];
  unchangedCount: number;
  summary: { addedCount: number; removedCount: number; changedCount: number };
}

const IOU_MATCH_THRESHOLD = 0.7;
// Matched pairs with IoU below this (or any bbox delta beyond rounding)
// are reported as 'changed' with changedFields including 'boundingBox'.
const IOU_UNCHANGED_THRESHOLD = 0.98;

@Injectable()
export class DrawingCompareService {
  constructor(
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly revision: DrawingRevisionService,
    private readonly events: EventEmitter2,
  ) {}

  /** Legacy stableId-based diff (kept for POST /drawings/compare). */
  async compare(estimateId: string, drawingIdA: string, drawingIdB: string) {
    const [objectsA, objectsB] = await Promise.all([
      this.objectModel.find({ drawingId: drawingIdA }).lean() as unknown as DrawingObjectDocument[],
      this.objectModel.find({ drawingId: drawingIdB }).lean() as unknown as DrawingObjectDocument[],
    ]);
    return this.revision.diff(drawingIdA, estimateId, objectsA, objectsB);
  }

  /**
   * V2: compare current drawing against another drawing in the same estimate.
   * Matching: exact stableId first, then greedy same-type IoU > 0.7 fallback
   * (stableIds embed drawingId, so cross-drawing pairs only match via IoU).
   */
  async compareV2(
    estimateId: string,
    drawingId: string,
    againstDrawingId: string,
  ): Promise<DrawingDiffV2> {
    const [current, base] = await Promise.all([
      this.objectModel.find({ drawingId }).lean() as unknown as CompareObject[],
      this.objectModel.find({ drawingId: againstDrawingId }).lean() as unknown as CompareObject[],
    ]);

    const diff = this.diffObjects(drawingId, againstDrawingId, current, base);

    this.events.emit(
      DrawingComparedEvent.EVENT,
      new DrawingComparedEvent(
        drawingId,
        estimateId,
        diff.summary.addedCount,
        diff.summary.removedCount,
        diff.summary.changedCount,
      ),
    );
    return diff;
  }

  /** Pure diff — no I/O, unit-testable. base = old, current = new. */
  diffObjects(
    drawingId: string,
    againstDrawingId: string,
    current: CompareObject[],
    base: CompareObject[],
  ): DrawingDiffV2 {
    const unmatchedBase = new Set(base.map((_, i) => i));
    const unmatchedCurrent = new Set(current.map((_, i) => i));
    const pairs: Array<{ b: number; c: number; matchedBy: 'stableId' | 'iou' }> = [];

    // Pass 1: exact stableId (same-drawing revisions keep identical stableIds)
    const baseByStableId = new Map<string, number>();
    base.forEach((o, i) => baseByStableId.set(o.stableId, i));
    current.forEach((o, ci) => {
      const bi = baseByStableId.get(o.stableId);
      if (bi !== undefined && unmatchedBase.has(bi)) {
        pairs.push({ b: bi, c: ci, matchedBy: 'stableId' });
        unmatchedBase.delete(bi);
        unmatchedCurrent.delete(ci);
      }
    });

    // Pass 2: greedy best-IoU match among same-type unmatched objects
    const candidates: Array<{ b: number; c: number; iou: number }> = [];
    for (const bi of unmatchedBase) {
      for (const ci of unmatchedCurrent) {
        if (base[bi].type !== current[ci].type) continue;
        const iou = this.iou(base[bi].boundingBox, current[ci].boundingBox);
        if (iou > IOU_MATCH_THRESHOLD) candidates.push({ b: bi, c: ci, iou });
      }
    }
    candidates.sort((x, y) => y.iou - x.iou);
    for (const cand of candidates) {
      if (!unmatchedBase.has(cand.b) || !unmatchedCurrent.has(cand.c)) continue;
      pairs.push({ b: cand.b, c: cand.c, matchedBy: 'iou' });
      unmatchedBase.delete(cand.b);
      unmatchedCurrent.delete(cand.c);
    }

    // Classify pairs
    const changed: ChangedPairDto[] = [];
    let unchangedCount = 0;
    for (const p of pairs) {
      const before = base[p.b];
      const after = current[p.c];
      const iou = this.iou(before.boundingBox, after.boundingBox);
      const changedFields = this.diffProperties(before.properties ?? {}, after.properties ?? {});
      if (iou < IOU_UNCHANGED_THRESHOLD) changedFields.push('boundingBox');
      if (changedFields.length > 0) {
        changed.push({
          before: this.toDto(before),
          after: this.toDto(after),
          changedFields,
          iou: Math.round(iou * 1000) / 1000,
          matchedBy: p.matchedBy,
        });
      } else {
        unchangedCount++;
      }
    }

    const added = [...unmatchedCurrent].map((i) => this.toDto(current[i]));
    const removed = [...unmatchedBase].map((i) => this.toDto(base[i]));

    return {
      drawingId,
      againstDrawingId,
      added,
      removed,
      changed,
      unchangedCount,
      summary: {
        addedCount: added.length,
        removedCount: removed.length,
        changedCount: changed.length,
      },
    };
  }

  private iou(a: BBox, b: BBox): number {
    if ((a.page ?? 1) !== (b.page ?? 1)) return 0;
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  private diffProperties(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): string[] {
    const changed: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === 'handle') continue; // parser-internal, differs per file
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
    }
    return changed;
  }

  private toDto(o: CompareObject): DiffObjectDto {
    return {
      id: String(o._id ?? o.stableId),
      stableId: o.stableId,
      drawingId: o.drawingId,
      type: o.type,
      rawType: o.rawType,
      layer: o.layer,
      boundingBox: o.boundingBox,
      geometry: o.geometry ?? [],
      confidence: o.confidence,
      properties: o.properties ?? {},
      floor: o.floor,
    };
  }
}
