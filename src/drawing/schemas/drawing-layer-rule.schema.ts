import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DrawingLayerRuleDocument = HydratedDocument<DrawingLayerRule>;

/**
 * Per-project (estimate) layer → object-type override (Tier 2).
 * Highest-priority classifier: user maps a CAD layer once, every entity on it
 * is reclassified. Keyed by estimateId so "MANH = Wall" in project A does not
 * leak into project B where "MANH = Hidden Line".
 *
 * `color` is an optional discriminator (ACI index) for future CAD-fingerprint
 * matching — null means "any color on this layer".
 */
@Schema({ collection: 'drawing_layer_rules', timestamps: true, minimize: false })
export class DrawingLayerRule {
  @Prop({ required: true, index: true })
  estimateId: string;

  /** Layer name, stored upper-cased for case-insensitive match. */
  @Prop({ required: true })
  layer: string;

  /** Optional ACI color index discriminator; undefined = match any color. */
  @Prop()
  color?: number;

  /** Optional linetype-name discriminator (e.g. "DASHED" → Hidden Wall); undefined = any. */
  @Prop()
  lineType?: string;

  /** Target object type, or 'ignored' to exclude from takeoff. */
  @Prop({ required: true })
  type: string;
}

export const DrawingLayerRuleSchema = SchemaFactory.createForClass(DrawingLayerRule);
DrawingLayerRuleSchema.index({ estimateId: 1, layer: 1, color: 1, lineType: 1 }, { unique: true });
