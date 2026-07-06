import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  DrawingLayerRule,
  DrawingLayerRuleDocument,
} from '../schemas/drawing-layer-rule.schema';
import type { LayerOverride } from './drawing-detector.service';

export interface LayerRuleInput {
  layer: string;
  color?: number;
  lineType?: string;
  type: string;
}

@Injectable()
export class DrawingLayerRuleService {
  constructor(
    @InjectModel(DrawingLayerRule.name)
    private ruleModel: Model<DrawingLayerRuleDocument>,
  ) {}

  /** All rules for an estimate, as detector overrides. */
  async list(estimateId: string): Promise<LayerOverride[]> {
    const rules = await this.ruleModel.find({ estimateId }).lean();
    return rules.map((r) => ({ layer: r.layer, color: r.color, lineType: r.lineType, type: r.type }));
  }

  /**
   * Replace the full rule set for an estimate (idempotent save from the mapper UI).
   * Layer names are normalized upper-case; 'ignored' is a valid target type.
   */
  async replace(estimateId: string, rules: LayerRuleInput[]): Promise<LayerOverride[]> {
    await this.ruleModel.deleteMany({ estimateId });
    const clean = rules
      .filter((r) => r.layer?.trim() && r.type?.trim())
      .map((r) => ({
        estimateId,
        layer: r.layer.trim().toUpperCase(),
        color: typeof r.color === 'number' ? r.color : undefined,
        lineType: r.lineType?.trim() ? r.lineType.trim().toUpperCase() : undefined,
        type: r.type.trim(),
      }));
    if (clean.length) await this.ruleModel.insertMany(clean, { ordered: false });
    return clean.map(({ layer, color, lineType, type }) => ({ layer, color, lineType, type }));
  }

  /** Additive upsert of one any-color layer rule (used by Tier 4 auto-promotion). */
  async upsertOne(estimateId: string, layer: string, type: string): Promise<void> {
    const norm = layer.trim().toUpperCase();
    await this.ruleModel.updateOne(
      { estimateId, layer: norm, color: null, lineType: null },
      { $set: { type }, $setOnInsert: { estimateId, layer: norm } },
      { upsert: true },
    );
  }
}
