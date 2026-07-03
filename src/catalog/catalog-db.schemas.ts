import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ComponentKind = 'material' | 'labor' | 'machine';

export interface NormComponent {
  kind: ComponentKind;
  refCode?: string;
  name: string;
  unit: string;
  norm: number;
}

/** Định mức công tác (vd TT12/2021) — nạp từ Excel, KHÔNG tự sinh. */
@Schema({ collection: 'norm_items', timestamps: true })
export class NormItem extends Document {
  @Prop({ required: true, unique: true }) code: string;
  @Prop({ required: true }) name: string;
  @Prop({ default: '' }) unit: string;
  @Prop({ default: '' }) group: string;
  @Prop({ type: Array, default: [] }) components: NormComponent[];
  @Prop({ default: '' }) sourceDoc: string; // vd "TT12/2021"
  @Prop({ default: () => new Date() }) importedAt: Date;
}
export const NormItemSchema = SchemaFactory.createForClass(NormItem);
NormItemSchema.index({ name: 'text', code: 'text' });
// code prefix search is covered by the implicit unique index on `code`

/** Một đợt công bố giá tỉnh. */
@Schema({ collection: 'price_sets', timestamps: true })
export class PriceSet extends Document {
  @Prop({ required: true, index: true }) province: string;
  @Prop({ required: true }) effectiveDate: Date;
  @Prop({ default: '' }) sourceDoc: string;
  @Prop({ default: () => new Date() }) importedAt: Date;
}
export const PriceSetSchema = SchemaFactory.createForClass(PriceSet);
PriceSetSchema.index({ province: 1, effectiveDate: -1 });

/** Dòng giá thuộc một price_set. */
@Schema({ collection: 'price_items', timestamps: true })
export class PriceItem extends Document {
  @Prop({ required: true, index: true, type: Types.ObjectId }) priceSetId: Types.ObjectId;
  @Prop() refCode?: string;
  @Prop({ required: true }) name: string;
  @Prop({ default: '' }) unit: string;
  @Prop({ required: true }) price: number;
  @Prop({ type: String, default: 'material' }) kind: ComponentKind;
}
export const PriceItemSchema = SchemaFactory.createForClass(PriceItem);
PriceItemSchema.index({ priceSetId: 1, refCode: 1 });
PriceItemSchema.index({ name: 'text' });
