import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { FilterQuery, Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './audit-log.schema';
import { AuditLogPayload, AuditLogRecordedEvent } from '../events/domain-events';

export interface AuditLogFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectModel(AuditLog.name) private readonly model: Model<AuditLogDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Call from any admin mutation — emits, never blocks the caller on Mongo. */
  record(payload: AuditLogPayload) {
    this.eventEmitter.emit(AuditLogRecordedEvent.EVENT, new AuditLogRecordedEvent(payload));
  }

  @OnEvent(AuditLogRecordedEvent.EVENT)
  async onAuditLogRecorded(event: AuditLogRecordedEvent) {
    try {
      await this.model.create(event.payload);
    } catch (err) {
      this.logger.warn(`Failed to persist AuditLog: ${(err as Error).message}`);
    }
  }

  async list(filter: AuditLogFilter, page = 1, limit = 50) {
    const query: FilterQuery<AuditLogDocument> = {};
    if (filter.actorId) query.actorId = filter.actorId;
    if (filter.action) query.action = filter.action;
    if (filter.targetType) query.targetType = filter.targetType;
    if (filter.from || filter.to) {
      query.createdAt = {};
      if (filter.from) (query.createdAt as Record<string, unknown>).$gte = new Date(filter.from);
      if (filter.to) (query.createdAt as Record<string, unknown>).$lte = new Date(filter.to);
    }
    const skip = Math.max(0, (page - 1) * limit);
    const [items, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments(query).exec(),
    ]);
    return { items, total, page, limit };
  }
}
