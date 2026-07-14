import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UnitPriceDocument = UnitPrice & Document;

/**
 * Đơn giá công tác THẬT theo tỉnh (vd tập Đơn giá TP Hà Nội — TT13/2021), có nguồn.
 * Khác norm_items (hao phí) + price_items (giá tài nguyên): đây là ĐƠN GIÁ CÔNG TÁC
 * đã tổng hợp sẵn VL/NC/Máy — tra thẳng theo mã hiệu để điền đơn giá dự toán.
 */
@Schema({ collection: 'unit_prices', timestamps: true })
export class UnitPrice extends Document {
  @Prop({ required: true, index: true }) code: string;   // mã hiệu, vd AF.61520
  @Prop({ required: true }) name: string;
  @Prop({ default: '' }) unit: string;
  @Prop({ default: 0 }) material: number;                // đơn giá VL
  @Prop({ default: 0 }) labor: number;                   // đơn giá NC
  @Prop({ default: 0 }) machine: number;                 // đơn giá Máy
  @Prop({ required: true }) unitPrice: number;           // tổng đơn giá (VL+NC+Máy)
  @Prop({ required: true, index: true }) province: string;
  @Prop({ default: '' }) sourceDoc: string;              // vd "TT13/2021 - Đơn giá Hà Nội"
  @Prop({ default: '' }) sourceOrigin: string;           // vd "luatvietnam.vn"
  @Prop({ default: true }) splitConfident: boolean;      // false = VL/NC/M suy đoán, tổng vẫn chuẩn
}

export const UnitPriceSchema = SchemaFactory.createForClass(UnitPrice);
UnitPriceSchema.index({ code: 1, province: 1 }, { unique: true });
UnitPriceSchema.index({ name: 'text' });
