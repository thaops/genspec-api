import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CrawlJobStatus = 'pending' | 'running' | 'done' | 'failed';

@Schema({ collection: 'crawl_jobs', timestamps: true })
export class CrawlJob extends Document {
  @Prop({ required: true }) sourceId: string;
  @Prop({ required: true }) crawlerKey: string;
  @Prop({ type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' }) status: CrawlJobStatus;
  @Prop() startedAt: Date;
  @Prop() finishedAt: Date;
  @Prop({ default: 0 }) filesFound: number;
  @Prop({ default: 0 }) filesSaved: number;
  @Prop({ type: [String], default: [] }) crawlErrors: string[];
  @Prop() triggeredBy: string; // 'schedule' | 'manual'
}

export const CrawlJobSchema = SchemaFactory.createForClass(CrawlJob);
