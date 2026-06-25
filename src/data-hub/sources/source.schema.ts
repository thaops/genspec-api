import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'source_registry', timestamps: true })
export class Source extends Document {
  @Prop({ required: true, unique: true }) sourceId: string;
  @Prop({ required: true }) name: string;
  @Prop({ enum: ['official', 'reference'], default: 'official' }) type: string;
  @Prop({ default: 50 }) priority: number;
  @Prop({ default: '0 2 * * *' }) schedule: string;
  @Prop({ enum: ['active', 'paused', 'error'], default: 'active' }) status: string;
  @Prop({ required: true }) crawlerKey: string;
  @Prop() baseUrl: string;
  @Prop({ type: Object }) metadata: Record<string, string>;
  @Prop() lastCrawledAt: Date;
  @Prop() lastError: string;
}

export const SourceSchema = SchemaFactory.createForClass(Source);
