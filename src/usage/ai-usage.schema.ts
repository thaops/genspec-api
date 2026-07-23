import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { COLLECTIONS } from '../common/constants';

export type AiUsageDocument = HydratedDocument<AiUsage>;

@Schema({ collection: COLLECTIONS.aiUsage, timestamps: true })
export class AiUsage {
  @Prop({ required: true, index: true })
  requestId: string;

  @Prop()
  traceId?: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ index: true })
  estimateId?: string;

  @Prop()
  sessionId?: string;

  @Prop({ required: true, index: true })
  source: string;

  @Prop()
  mode?: string;

  @Prop({ required: true, default: 'gemini' })
  provider: string;

  @Prop({ required: true, index: true })
  model: string;

  @Prop({ required: true, default: 0 })
  inputTokens: number;

  @Prop({ required: true, default: 0 })
  outputTokens: number;

  @Prop({ required: true, default: 0 })
  totalTokens: number;

  @Prop()
  cachedInputTokens?: number;

  @Prop()
  reasoningTokens?: number;

  @Prop()
  toolTokens?: number;

  @Prop({ required: true, default: 0 })
  inputPricePer1M: number;

  @Prop({ required: true, default: 0 })
  outputPricePer1M: number;

  @Prop({ required: true, default: 0 })
  costUsd: number;

  @Prop({ required: true, default: 0 })
  latencyMs: number;

  @Prop({ required: true, enum: ['success', 'error', 'timeout'], default: 'success' })
  status: 'success' | 'error' | 'timeout';

  @Prop()
  errorMessage?: string;
}

export const AiUsageSchema = SchemaFactory.createForClass(AiUsage);
AiUsageSchema.index({ createdAt: -1 });
