import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingRevisionDocument = DrawingRevision & Document;

@Schema({ timestamps: true, collection: 'drawing_revisions' })
export class DrawingRevision {
  @Prop({ required: true, index: true })
  drawingId: string;

  @Prop({ required: true })
  version: number;

  @Prop()
  label?: string;

  @Prop({ type: Object })
  diff: {
    added: string[];    // stableIds of added objects
    removed: string[];  // stableIds of removed objects
    changed: string[];  // stableIds of changed objects
  };

  @Prop()
  summary?: string;

  @Prop({ required: true })
  uploadedBy: string;
}

export const DrawingRevisionSchema = SchemaFactory.createForClass(DrawingRevision);
DrawingRevisionSchema.index({ drawingId: 1, version: -1 });
