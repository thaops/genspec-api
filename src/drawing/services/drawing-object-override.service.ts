import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DrawingObjectOverride,
  DrawingObjectOverrideDocument,
} from '../schemas/drawing-object-override.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingLayerRuleService } from './drawing-layer-rule.service';

// When this many corrections on one layer agree on a type (with no dissent),
// promote to a project-wide Tier 2 layer rule so future objects/revisions inherit it.
const PROMOTE_THRESHOLD = 3;

@Injectable()
export class DrawingObjectOverrideService {
  constructor(
    @InjectModel(DrawingObjectOverride.name)
    private overrideModel: Model<DrawingObjectOverrideDocument>,
    @InjectModel(DrawingObject.name)
    private objectModel: Model<DrawingObjectDocument>,
    private readonly layerRules: DrawingLayerRuleService,
  ) {}

  /** Correct one object by stableId: record durable override + update the live doc now. */
  async correct(estimateId: string, drawingId: string, stableId: string, type: string) {
    const obj = await this.objectModel.findOne({ drawingId, stableId }).lean();
    if (!obj) throw new NotFoundException('Không tìm thấy đối tượng');
    const res = await this.set(estimateId, drawingId, stableId, obj.layer, type);
    await this.objectModel.updateOne(
      { drawingId, stableId },
      { $set: { type, confidence: 1, ambiguous: false, candidates: [{ type, prob: 1 }], detectionReason: 'Người dùng sửa (Tier 4)' } },
    );
    const updated = await this.objectModel.findOne({ drawingId, stableId }).lean();
    return { object: updated, promoted: res.promoted };
  }

  /** stableId → type map, applied inside detect() so user corrections win. */
  async map(drawingId: string): Promise<Map<string, string>> {
    const rows = await this.overrideModel.find({ drawingId }).lean();
    return new Map(rows.map((r) => [r.stableId, r.type]));
  }

  /**
   * Record a correction, then check whether its layer now has enough agreeing
   * corrections to auto-promote into a Tier 2 layer rule.
   */
  async set(estimateId: string, drawingId: string, stableId: string, layer: string, type: string) {
    await this.overrideModel.updateOne(
      { drawingId, stableId },
      { $set: { type, layer }, $setOnInsert: { estimateId, drawingId, stableId } },
      { upsert: true },
    );
    const promoted = await this.maybePromote(estimateId, layer, type);
    return { stableId, type, promoted };
  }

  /** Promote to a layer rule if ≥threshold estimate-wide corrections on this layer agree and none dissent. */
  private async maybePromote(estimateId: string, layer: string, type: string): Promise<boolean> {
    const sameLayer = await this.overrideModel.find({ estimateId, layer }).lean();
    if (sameLayer.length < PROMOTE_THRESHOLD) return false;
    const agree = sameLayer.filter((o) => o.type === type).length;
    const dissent = sameLayer.some((o) => o.type !== type);
    if (dissent || agree < PROMOTE_THRESHOLD) return false;
    await this.layerRules.upsertOne(estimateId, layer, type);
    return true;
  }
}
