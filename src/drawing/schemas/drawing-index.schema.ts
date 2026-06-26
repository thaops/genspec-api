import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingIndexDocument = DrawingIndex & Document;

@Schema({ collection: 'drawing_index' })
export class DrawingIndex {
  @Prop({ required: true, index: true })
  drawingId: string;

  @Prop({ required: true })
  pageNumber: number;

  @Prop({ required: true, enum: ['layer', 'text', 'dimension', 'block', 'object'] })
  kind: string;

  @Prop({ required: true })
  value: string;

  @Prop()
  objectId?: string;

  @Prop({ type: Object })
  boundingBox?: { x: number; y: number; w: number; h: number };
}

export const DrawingIndexSchema = SchemaFactory.createForClass(DrawingIndex);

// Text search index for full-text lookup
DrawingIndexSchema.index({ drawingId: 1, kind: 1 });
DrawingIndexSchema.index({ value: 'text' });
