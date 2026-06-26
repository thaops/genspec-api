import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingRevision, DrawingRevisionDocument } from '../schemas/drawing-revision.schema';
import { DrawingRevisionUploadedEvent, DrawingComparedEvent } from '../../events/domain-events';

export interface RevisionMapping {
  stableId: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  oldProperties?: Record<string, unknown>;
  newProperties?: Record<string, unknown>;
  changedFields?: string[];
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

    // Objects in both → compare properties
    for (const [stableId, objA] of mapA) {
      const objB = mapB.get(stableId);
      if (!objB) continue;
      const changedFields = this.diffProperties(objA.properties, objB.properties);
      if (changedFields.length > 0) {
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
