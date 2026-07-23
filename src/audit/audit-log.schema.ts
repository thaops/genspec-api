import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { COLLECTIONS } from '../common/constants';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({ collection: COLLECTIONS.auditLogs, timestamps: true })
export class AuditLog {
  @Prop({ required: true, index: true })
  actorId: string;

  @Prop()
  actorEmail?: string;

  @Prop({ required: true, index: true })
  action: string;

  @Prop({ required: true, index: true })
  targetType: string;

  @Prop({ required: true })
  targetId: string;

  @Prop({ type: Object })
  meta?: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ createdAt: -1 });
