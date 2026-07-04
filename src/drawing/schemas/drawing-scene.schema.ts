import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DrawingSceneDocument = DrawingSceneEntity & Document;

/** Gzipped render-scene per drawing (scene contract v1). */
@Schema({ timestamps: true, collection: 'drawing_scenes' })
export class DrawingSceneEntity {
  @Prop({ required: true, unique: true, index: true })
  drawingId: string;

  @Prop({ required: true, type: Buffer })
  gz: Buffer;

  /** Uncompressed JSON size in bytes */
  @Prop({ required: true })
  size: number;

  @Prop({ default: false })
  truncated: boolean;

  /** Adapter/builder version that produced this scene — older versions rebuild on GET */
  @Prop({ default: 0 })
  builderVersion: number;
}

export const DrawingSceneSchema = SchemaFactory.createForClass(DrawingSceneEntity);
