import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingRelationshipDocument = DrawingRelationship & Document;

export type RelationshipType =
  | 'supports'
  | 'supported_by'
  | 'contains'
  | 'adjacent_to'
  | 'belongs_to'
  | 'connects'
  | 'references';

@Schema({ timestamps: true, collection: 'drawing_relationships' })
export class DrawingRelationship {
  @Prop({ required: true, index: true })
  drawingId: string;

  // Use stableId (not DB id) so relationships survive revision re-parse
  @Prop({ required: true })
  fromStableId: string;

  @Prop({ required: true })
  toStableId: string;

  @Prop({ required: true })
  type: RelationshipType;

  @Prop({ min: 0, max: 1, default: 1 })
  confidence: number;

  @Prop({ type: Object, default: {} })
  properties: Record<string, string | number>;
}

export const DrawingRelationshipSchema =
  SchemaFactory.createForClass(DrawingRelationship);

DrawingRelationshipSchema.index({ drawingId: 1, fromStableId: 1 });
DrawingRelationshipSchema.index({ drawingId: 1, toStableId: 1 });
DrawingRelationshipSchema.index(
  { drawingId: 1, fromStableId: 1, toStableId: 1, type: 1 },
  { unique: true }
);
