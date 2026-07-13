import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingRelationship, DrawingRelationshipDocument } from '../schemas/drawing-relationship.schema';
import { DrawingDetectedEvent, DrawingGraphBuiltEvent } from '../../events/domain-events';
import {
  GraphObject,
  assembleBuilding,
  assignObjectsToRooms,
  perFloorTypeCounts,
  countType,
  roomsMissingType,
} from '../building-graph';
import { mepTakeoff } from '../mep-takeoff';
import { reviewBuilding } from '../building-review';

/**
 * Builds structural graph after AI detect completes.
 * Listens to DrawingDetectedEvent — no controller wires this.
 *
 * Rules (rule-based first, AI-assisted later):
 *   beam on column:    beam.boundingBox intersects column.boundingBox → supports
 *   slab on beam:      slab layer above beam layer → supported_by
 *   wall adjacent:     wall endpoints within threshold → adjacent_to
 *   object on page:    belongs_to floor (derived from page label)
 */
@Injectable()
export class DrawingGraphService {
  private readonly logger = new Logger(DrawingGraphService.name);

  constructor(
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    @InjectModel(DrawingRelationship.name) private relModel: Model<DrawingRelationshipDocument>,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(DrawingDetectedEvent.EVENT)
  async onDetected(event: DrawingDetectedEvent) {
    await this.build(event.drawingId);
  }

  async build(drawingId: string): Promise<{ nodeCount: number; edgeCount: number }> {
    const objects = await this.objectModel.find({ drawingId }).lean();

    // Clear existing relationships for this drawing before rebuild
    await this.relModel.deleteMany({ drawingId });

    const relationships: Partial<DrawingRelationship>[] = [];

    const beams    = objects.filter((o) => o.type === 'beam');
    const columns  = objects.filter((o) => o.type === 'column');
    const slabs    = objects.filter((o) => o.type === 'slab');
    const walls    = objects.filter((o) => o.type === 'wall');

    // Each pass below is O(|A|·|B|). On dense structural/MEP drawings a type can
    // hold thousands of objects → tens of millions of iterations that block the
    // event loop. Skip a pass whose pair count is pathological rather than hang.
    const MAX_PAIRS = 3_000_000;
    const tooMany = (a: number, b: number, label: string): boolean => {
      if (a * b > MAX_PAIRS) {
        this.logger.warn(`Skip ${label} graph pass — ${a}×${b} pairs exceed ${MAX_PAIRS}`);
        return true;
      }
      return false;
    };

    // beam → column: beam bounding box overlaps column bounding box
    if (!tooMany(beams.length, columns.length, 'beam→column')) for (const beam of beams) {
      for (const col of columns) {
        if (this.overlaps(beam.boundingBox, col.boundingBox)) {
          relationships.push({
            drawingId,
            fromStableId: beam.stableId,
            toStableId: col.stableId,
            type: 'supported_by',
            confidence: 0.85,
          });
        }
      }
    }

    // slab → beam: similar overlap + same page
    if (!tooMany(slabs.length, beams.length, 'slab→beam')) for (const slab of slabs) {
      for (const beam of beams) {
        if (
          slab.boundingBox.page === beam.boundingBox.page &&
          this.overlaps(slab.boundingBox, beam.boundingBox)
        ) {
          relationships.push({
            drawingId,
            fromStableId: slab.stableId,
            toStableId: beam.stableId,
            type: 'supported_by',
            confidence: 0.75,
          });
        }
      }
    }

    // wall → wall: adjacent endpoints (threshold = 5 units)
    if (!tooMany(walls.length, walls.length, 'wall↔wall')) for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        if (this.isAdjacent(walls[i].boundingBox, walls[j].boundingBox, 5)) {
          relationships.push({
            drawingId,
            fromStableId: walls[i].stableId,
            toStableId: walls[j].stableId,
            type: 'adjacent_to',
            confidence: 0.9,
          });
        }
      }
    }

    // Room → object: 'contains' (tầng ngữ nghĩa). Chỉ sinh khi có object type='room';
    // rỗng nếu chưa detect room (S3b) — không phá gì.
    const roomMembers = assignObjectsToRooms(objects as unknown as GraphObject[]);
    for (const [roomId, memberIds] of roomMembers) {
      for (const memberId of memberIds) {
        relationships.push({
          drawingId,
          fromStableId: roomId,
          toStableId: memberId,
          type: 'contains',
          confidence: 0.8,
        });
      }
    }

    if (relationships.length > 0) {
      await this.relModel.insertMany(relationships, { ordered: false });
    }

    this.events.emit(
      DrawingGraphBuiltEvent.EVENT,
      new DrawingGraphBuiltEvent(drawingId, objects.length, relationships.length),
    );

    return { nodeCount: objects.length, edgeCount: relationships.length };
  }

  async getGraph(drawingId: string) {
    const [objects, relationships] = await Promise.all([
      this.objectModel.find({ drawingId }).lean(),
      this.relModel.find({ drawingId }).lean(),
    ]);
    return { drawingId, objects, relationships };
  }

  // ── Building Graph — tầng ngữ nghĩa (query cho Copilot) ────────────────────

  private async load(drawingId: string): Promise<GraphObject[]> {
    return (await this.objectModel.find({ drawingId }).lean()) as unknown as GraphObject[];
  }

  /** Cây Building → Floor → Room → Object. */
  async building(drawingId: string) {
    return assembleBuilding(await this.load(drawingId));
  }

  /** typeCounts theo từng tầng — "mỗi tầng có gì". */
  async floorSummary(drawingId: string) {
    return perFloorTypeCounts(await this.load(drawingId));
  }

  /** "Tầng 3 có bao nhiêu đèn?" — countType(drawingId, 'light', '3'). */
  async count(drawingId: string, type: string, floor?: string) {
    return { type, floor: floor ?? null, count: countType(await this.load(drawingId), type, floor ? { floor } : undefined) };
  }

  /** "Phòng nào chưa có ổ cắm?" — nền AI Review. Rỗng nếu chưa detect room. */
  async roomsMissing(drawingId: string, requiredType: string) {
    return roomsMissingType(await this.load(drawingId), requiredType);
  }

  /**
   * MEP takeoff: đếm thiết bị (đèn/ổ cắm/…) + đo chiều dài tuyến (ống/dây/máng).
   * `factor` = m/đơn-vị-vẽ (mm→m = 0.001). byFloor=true tách theo tầng.
   */
  async mepTakeoff(drawingId: string, factor = 1, byFloor = false) {
    return mepTakeoff(await this.load(drawingId), factor, byFloor);
  }

  /** AI Review: rà soát thiếu phạm vi (scope-gap) — human-in-the-loop, không tự sửa. */
  async review(drawingId: string) {
    return reviewBuilding(await this.load(drawingId));
  }

  private overlaps(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): boolean {
    return !(
      a.x + a.w < b.x || b.x + b.w < a.x ||
      a.y + a.h < b.y || b.y + b.h < a.y
    );
  }

  private isAdjacent(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
    threshold: number,
  ): boolean {
    const aCenterX = a.x + a.w / 2, aCenterY = a.y + a.h / 2;
    const bCenterX = b.x + b.w / 2, bCenterY = b.y + b.h / 2;
    const dist = Math.sqrt((aCenterX - bCenterX) ** 2 + (aCenterY - bCenterY) ** 2);
    return dist < (a.w + b.w) / 2 + threshold;
  }
}
