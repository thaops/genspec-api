import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DrawingObjectOverrideDocument = HydratedDocument<DrawingObjectOverride>;

/**
 * Tier 4 — a user's manual correction of a single object's type. Kept in its own
 * collection (not on DrawingObject) so it survives the delete-and-rebuild that
 * re-detection performs. Re-applied inside detect() by deterministic `stableId`,
 * which is stable across re-parses of the same drawing.
 */
@Schema({ collection: 'drawing_object_overrides', timestamps: true, minimize: false })
export class DrawingObjectOverride {
  @Prop({ required: true, index: true })
  estimateId: string;

  @Prop({ required: true, index: true })
  drawingId: string;

  @Prop({ required: true })
  stableId: string;

  /** Layer of the corrected object — feeds Tier 2 auto-promotion. */
  @Prop({ required: true })
  layer: string;

  @Prop({ required: true })
  type: string;

  @Prop({ default: 'user' })
  createdBy: string;
}

export const DrawingObjectOverrideSchema = SchemaFactory.createForClass(DrawingObjectOverride);
DrawingObjectOverrideSchema.index({ drawingId: 1, stableId: 1 }, { unique: true });
