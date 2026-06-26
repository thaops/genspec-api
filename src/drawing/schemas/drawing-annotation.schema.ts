import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingAnnotationDocument = DrawingAnnotation & Document;

@Schema({ timestamps: true, collection: 'drawing_annotations' })
export class DrawingAnnotation {
  @Prop({ required: true, index: true })
  drawingId: string;

  @Prop({ required: true, default: 1 })
  pageNumber: number;

  @Prop({ required: true })
  text: string;

  @Prop()
  objectId?: string;

  @Prop()
  markupId?: string;

  @Prop({ default: 'user' })
  createdBy: string;
}

export const DrawingAnnotationSchema = SchemaFactory.createForClass(DrawingAnnotation);
DrawingAnnotationSchema.index({ drawingId: 1, pageNumber: 1 });
