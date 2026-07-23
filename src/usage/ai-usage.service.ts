import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { FilterQuery, Model } from 'mongoose';
import { AiUsage, AiUsageDocument } from './ai-usage.schema';
import { AiUsagePayload, AiUsageRecordedEvent } from '../events/domain-events';

export interface AiUsageFilter {
  userId?: string;
  estimateId?: string;
  model?: string;
  source?: string;
  mode?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(@InjectModel(AiUsage.name) private readonly model: Model<AiUsageDocument>) {}

  // Fire-and-forget listener: AI already answered before this runs. If Mongo
  // is down, we just lose the usage row — never the user-facing response.
  @OnEvent(AiUsageRecordedEvent.EVENT)
  async onAiUsageRecorded(event: AiUsageRecordedEvent) {
    try {
      await this.model.create(event.payload);
    } catch (err) {
      this.logger.warn(`Failed to persist AiUsage: ${(err as Error).message}`);
    }
  }

  private buildQuery(filter: AiUsageFilter): FilterQuery<AiUsageDocument> {
    const q: FilterQuery<AiUsageDocument> = {};
    if (filter.userId) q.userId = filter.userId;
    if (filter.estimateId) q.estimateId = filter.estimateId;
    if (filter.model) q.model = filter.model;
    if (filter.source) q.source = filter.source;
    if (filter.mode) q.mode = filter.mode;
    if (filter.from || filter.to) {
      q.createdAt = {};
      if (filter.from) (q.createdAt as Record<string, unknown>).$gte = new Date(filter.from);
      if (filter.to) (q.createdAt as Record<string, unknown>).$lte = new Date(filter.to);
    }
    return q;
  }

  async list(filter: AiUsageFilter, page = 1, limit = 50) {
    const query = this.buildQuery(filter);
    const skip = Math.max(0, (page - 1) * limit);
    const [items, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments(query).exec(),
    ]);
    return { items, total, page, limit };
  }

  async summary(filter: AiUsageFilter) {
    const query = this.buildQuery(filter);
    const [totals] = await this.model.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          totalTokens: { $sum: '$totalTokens' },
          costUsd: { $sum: '$costUsd' },
        },
      },
    ]);
    const bySource = await this.model.aggregate([
      { $match: query },
      { $group: { _id: '$source', requests: { $sum: 1 }, totalTokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } } },
      { $sort: { costUsd: -1 } },
    ]);
    const topUsers = await this.model.aggregate([
      { $match: { ...query, userId: { $exists: true, $ne: null } } },
      { $group: { _id: '$userId', requests: { $sum: 1 }, totalTokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } } },
      { $sort: { costUsd: -1 } },
      { $limit: 5 },
    ]);
    return {
      totals: totals ?? { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      bySource: bySource.map((r) => ({ source: r._id, requests: r.requests, totalTokens: r.totalTokens, costUsd: r.costUsd })),
      topUsers: topUsers.map((r) => ({ userId: r._id, requests: r.requests, totalTokens: r.totalTokens, costUsd: r.costUsd })),
    };
  }

  async todaySummary() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.summary({ from: startOfDay.toISOString() });
  }
}

export type { AiUsagePayload };
