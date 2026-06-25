import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'catalog_codes', timestamps: true })
export class CatalogCode extends Document {
  @Prop({ required: true, index: true }) code: string;       // e.g. "AB.25322"
  @Prop({ required: true }) name: string;                    // tên công tác
  @Prop({ required: true }) unit: string;                    // đơn vị
  @Prop({ required: true, index: true }) group: string;      // nhóm
  @Prop({ default: 0 }) material: number;
  @Prop({ default: 0 }) labor: number;
  @Prop({ default: 0 }) machine: number;
  @Prop({ default: 'seed' }) sourceId: string;
  @Prop({ default: 50 }) trust: number;                      // 0–100
  @Prop() effectiveDate: Date;
  @Prop() expireDate: Date;
  @Prop({ default: true }) active: boolean;
}

export const CatalogCodeSchema = SchemaFactory.createForClass(CatalogCode);

// Text index for full-text search (Sprint 1 — replaced by Meilisearch in Sprint 2)
CatalogCodeSchema.index({ code: 'text', name: 'text', group: 'text' });
// Prefix search
CatalogCodeSchema.index({ code: 1, active: 1 });
