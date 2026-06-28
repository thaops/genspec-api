import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingObjectDocument = DrawingObject & Document;

@Schema({ timestamps: true, collection: 'drawing_objects' })
export class DrawingObject {
  @Prop({ required: true })
  drawingId: string;

  // Stable identity across revisions — set once by parser/AI, never changes.
  // Format: "<drawingId>-<type>-<normalizedPosition>" or AI-assigned hash.
  @Prop({ required: true, index: true })
  stableId: string;

  @Prop()
  pageId?: string;

  @Prop()
  layerId?: string;

  @Prop({ required: true })
  type: string;

  @Prop()
  rawType?: string;

  @Prop({ type: [[Number]], default: [] })
  geometry: number[][];

  @Prop({ required: true, min: 0, max: 1 })
  confidence: number;

  @Prop()
  detectionReason?: string;

  @Prop({ required: true })
  layer: string;

  @Prop({ type: Object, required: true })
  boundingBox: { x: number; y: number; w: number; h: number; page?: number };

  @Prop({ type: Object, default: {} })
  properties: Record<string, string | number>;

  @Prop()
  boqRef?: string;

  @Prop()
  specRef?: string;

  @Prop({ type: [String], default: [] })
  markupIds: string[];

  @Prop()
  floor?: string;
}

export const DrawingObjectSchema = SchemaFactory.createForClass(DrawingObject);

// Compound index: fast lookup by drawing + stable identity
DrawingObjectSchema.index({ drawingId: 1, stableId: 1 }, { unique: true });
DrawingObjectSchema.index({ drawingId: 1, type: 1 });
DrawingObjectSchema.index({ drawingId: 1, layer: 1 });
