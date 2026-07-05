import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingDocument = Drawing & Document;

@Schema({ timestamps: true, collection: 'drawings' })
export class Drawing {
  @Prop({ required: true, index: true })
  estimateId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, enum: ['pdf', 'dwg', 'dxf', 'image'] })
  type: string;

  @Prop({ enum: ['KT', 'KC', 'DIEN', 'NUOC', 'KHAC'], default: 'KHAC' })
  discipline: string;

  @Prop({ required: true })
  url: string;

  @Prop()
  cloudinaryPublicId?: string;

  @Prop()
  convertedUrl?: string;

  @Prop()
  thumbnail?: string;

  @Prop({ default: 1 })
  version: number;

  @Prop({ default: 0 })
  pageCount: number;

  @Prop({ enum: ['pending', 'converting', 'parsing', 'ready', 'failed'], default: 'pending' })
  parseStatus: string;

  @Prop()
  parseError?: string;

  @Prop({ type: [String], default: [] })
  parseLogs: string[];

  @Prop()
  uploadedBy: string;
}

export const DrawingSchema = SchemaFactory.createForClass(Drawing);
DrawingSchema.index({ estimateId: 1, createdAt: -1 });
