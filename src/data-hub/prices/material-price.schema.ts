import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** A single price data point for a material/labor/equipment */
@Schema({ collection: 'material_prices', timestamps: true })
export class MaterialPrice extends Document {
  /** Canonical material ID from NormalizeService */
  @Prop({ required: true, index: true }) materialId: string;
  /** Human-readable name (original, not normalized) */
  @Prop({ required: true }) name: string;
  @Prop({ enum: ['material', 'labor', 'equipment', 'fuel', 'transport'], default: 'material' }) category: string;
  @Prop({ required: true }) unit: string;
  @Prop({ required: true }) price: number;
  /** Province code, null = national */
  @Prop({ index: true }) province: string;
  @Prop({ required: true }) sourceId: string;
  @Prop({ default: 50 }) trust: number;
  @Prop({ required: true }) effectiveDate: Date;
  @Prop() expireDate: Date;
  @Prop() documentNumber: string; // e.g. "13/2021/TT-BXD"
  @Prop({ default: true }) active: boolean;
}

export const MaterialPriceSchema = SchemaFactory.createForClass(MaterialPrice);
MaterialPriceSchema.index({ materialId: 1, province: 1, effectiveDate: -1 });
MaterialPriceSchema.index({ name: 'text' });
