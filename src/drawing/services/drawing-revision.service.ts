import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingRevision, DrawingRevisionDocument } from '../schemas/drawing-revision.schema';
import { DrawingRevisionUploadedEvent, DrawingComparedEvent } from '../../events/domain-events';

export type RevisionStatus =
  | 'added'     // exists in B, not in A
  | 'removed'   // exists in A, not in B
  | 'changed'   // same stableId, properties differ
  | 'moved'     // same stableId, bounding box moved significantly
  | 'renamed'   // same stableId, label/text changed
  | 'split'     // one object in A became N objects in B (detected by proximity + type)
  | 'merged'    // N objects in A became one in B
  | 'unchanged';

export interface RevisionMapping {
  stableId: string;
  status: RevisionStatus;
  oldProperties?: Record<string, unknown>;
  newProperties?: Record<string, unknown>;
  changedFields?: string[];
  // For 'moved': distance moved
  moveDistance?: number;
  // For 'split'/'merged': related stableIds
  relatedStableIds?: string[];
}

export interface RevisionDiff {
  drawingId: string;
  revisionIdA: string;
  revisionIdB: string;
  mappings: RevisionMapping[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  // Summarized for AI proposal generation
  significantChanges: string[];
}

/**
 * Revision Engine — computes diff between two drawing versions.
 *
 * Uses stableId to match objects across revisions.
 * Identity preserved even when DXF coordinates shift ±grid.
 */
@Injectable()
export class DrawingRevisionService {
  private readonly logger = new Logger(DrawingRevisionService.name);

  constructor(
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    @InjectModel(DrawingRevision.name) private revisionModel: Model<DrawingRevisionDocument>,
    private readonly events: EventEmitter2,
  ) {}

  async list(drawingId: string) {
    return this.revisionModel
      .find({ drawingId })
      .sort({ version: -1 })
      .lean();
  }

  async upload(
    estimateId: string,
    drawingId: string,
    file: Express.Multer.File,
    label?: string,
  ) {
    const latest = await this.revisionModel
      .findOne({ drawingId })
      .sort({ version: -1 });
    const version = (latest?.version ?? 0) + 1;

    const revision = await this.revisionModel.create({
      drawingId,
      version,
      label: label ?? `Rev ${version}`,
      diff: { added: [], removed: [], changed: [] },
      uploadedBy: 'user',
    });

    this.events.emit(
      DrawingRevisionUploadedEvent.EVENT,
      new DrawingRevisionUploadedEvent(
        drawingId,
        estimateId,
        (revision as any)._id.toString(),
        version,
      ),
    );

    return revision;
  }

  /** Compute diff between two sets of objects (identified by stableId) */
  async diff(
    drawingId: string,
    estimateId: string,
    objectsA: DrawingObjectDocument[],
    objectsB: DrawingObjectDocument[],
  ): Promise<RevisionDiff> {
    const mapA = new Map(objectsA.map((o) => [o.stableId, o]));
    const mapB = new Map(objectsB.map((o) => [o.stableId, o]));

    const mappings: RevisionMapping[] = [];

    // Objects in B not in A → added
    for (const [stableId, objB] of mapB) {
      if (!mapA.has(stableId)) {
        mappings.push({ stableId, status: 'added', newProperties: objB.properties });
      }
    }

    // Objects in A not in B → removed
    for (const [stableId, objA] of mapA) {
      if (!mapB.has(stableId)) {
        mappings.push({ stableId, status: 'removed', oldProperties: objA.properties });
      }
    }

    // Objects in both → compare properties + position
    for (const [stableId, objA] of mapA) {
      const objB = mapB.get(stableId);
      if (!objB) continue;

      const changedFields = this.diffProperties(objA.properties, objB.properties);
      const moveDistance  = this.computeMoveDistance(objA.boundingBox, objB.boundingBox);
      const labelChanged  = objA.properties['label'] !== objB.properties['label'];

      if (labelChanged && changedFields.length === 1 && changedFields[0] === 'label') {
        mappings.push({
          stableId,
          status: 'renamed',
          oldProperties: objA.properties,
          newProperties: objB.properties,
          changedFields,
        });
      } else if (moveDistance > 50 && changedFields.length === 0) {
        // Significant position change with no property change → moved
        mappings.push({
          stableId,
          status: 'moved',
          oldProperties: objA.properties,
          newProperties: objB.properties,
          moveDistance,
        });
      } else if (changedFields.length > 0) {
        mappings.push({
          stableId,
          status: 'changed',
          oldProperties: objA.properties,
          newProperties: objB.properties,
          changedFields,
        });
      } else {
        mappings.push({ stableId, status: 'unchanged' });
      }
    }

    // Detect split: one A object → N B objects of same type nearby
    this.detectSplitMerge(mappings, mapA, mapB);

    const added   = mappings.filter((m) => m.status === 'added').length;
    const removed = mappings.filter((m) => m.status === 'removed').length;
    const changed = mappings.filter((m) => m.status === 'changed').length;

    const significantChanges = this.summarizeChanges(mappings, mapA, mapB);

    this.events.emit(
      DrawingComparedEvent.EVENT,
      new DrawingComparedEvent(drawingId, estimateId, added, removed, changed),
    );

    return {
      drawingId,
      revisionIdA: '',
      revisionIdB: '',
      mappings,
      addedCount: added,
      removedCount: removed,
      changedCount: changed,
      significantChanges,
    };
  }

  private computeMoveDistance(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): number {
    const aCx = a.x + a.w / 2, aCy = a.y + a.h / 2;
    const bCx = b.x + b.w / 2, bCy = b.y + b.h / 2;
    return Math.sqrt((aCx - bCx) ** 2 + (aCy - bCy) ** 2);
  }

  private detectSplitMerge(
    mappings: RevisionMapping[],
    mapA: Map<string, DrawingObjectDocument>,
    mapB: Map<string, DrawingObjectDocument>,
  ) {
    const addedIds = mappings.filter((m) => m.status === 'added').map((m) => m.stableId);
    const removedIds = mappings.filter((m) => m.status === 'removed').map((m) => m.stableId);

    // Simple heuristic: if 2+ added objects of same type are near a removed object → split
    for (const removedId of removedIds) {
      const removed = mapA.get(removedId);
      if (!removed) continue;
      const nearbyAdded = addedIds.filter((id) => {
        const added = mapB.get(id);
        if (!added || added.type !== removed.type) return false;
        return this.computeMoveDistance(removed.boundingBox, added.boundingBox) < 200;
      });
      if (nearbyAdded.length >= 2) {
        const idx = mappings.findIndex((m) => m.stableId === removedId);
        if (idx !== -1) {
          mappings[idx] = { ...mappings[idx], status: 'split', relatedStableIds: nearbyAdded };
        }
      }
    }
  }

  private diffProperties(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): string[] {
    const changed: string[] = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
    }
    return changed;
  }

  private summarizeChanges(
    mappings: RevisionMapping[],
    mapA: Map<string, DrawingObjectDocument>,
    mapB: Map<string, DrawingObjectDocument>,
  ): string[] {
    const summary: string[] = [];

    const added   = mappings.filter((m) => m.status === 'added');
    const removed = mappings.filter((m) => m.status === 'removed');
    const changed = mappings.filter((m) => m.status === 'changed');

    if (added.length > 0) {
      summary.push(`${added.length} đối tượng được thêm mới`);
    }
    if (removed.length > 0) {
      summary.push(`${removed.length} đối tượng đã bị xóa`);
    }
    if (changed.length > 0) {
      const byType = new Map<string, number>();
      for (const m of changed) {
        const obj = mapB.get(m.stableId) ?? mapA.get(m.stableId);
        const type = (obj as any)?.type ?? 'unknown';
        byType.set(type, (byType.get(type) ?? 0) + 1);
      }
      for (const [type, count] of byType) {
        summary.push(`${count} ${type} thay đổi kích thước / vị trí`);
      }
    }
    return summary;
  }
}
