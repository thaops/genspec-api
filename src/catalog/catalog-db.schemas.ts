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
  /**
   * GIÁ TẠI NGUỒN — chưa VAT, chưa vận chuyển/bốc xếp. KHÔNG nhét VAT hay cước vận
   * chuyển vào đây: cả hai là TẦNG TÍNH TOÁN, không phải dữ liệu giá gốc.
   *  · VAT   → đã có rule sẵn `markups.vatPct` (state), áp lúc compute.
   *  · Vận chuyển → phụ thuộc cự ly mỏ→công trình, loại xe, trung chuyển → tính riêng.
   * Cộng cứng vào đây = giá KHÔNG tái sử dụng được (không ai biết bao nhiêu km, xe mấy
   * tấn), và Cost Summary sẽ sai mà không lộ ra.
   */
  @Prop({ required: true }) price: number;
  @Prop({ type: String, default: 'material' }) kind: ComponentKind;
  /**
   * ĐIỂM KHẢO SÁT giá (mỏ/bãi/NCC) — vd "Bãi Cầu Trung Hà, xã Vật Lại". Bắt buộc để
   * truy vết: CÙNG vật liệu có NHIỀU giá theo mỏ (đo thật trên công bố Sở XD Hà Nội
   * T4/2026: cát vàng 600.000↔800.000đ/m³ giữa 4 bãi = chênh 33%). Chính văn bản công
   * bố yêu cầu "căn cứ địa điểm công trình, địa điểm cung cấp vật tư, cự ly vận chuyển
   * để lựa chọn" ⇒ engine KHÔNG được chọn hộ, phải bày ra kèm mỏ cho QS chốt.
   */
  @Prop() sourcePoint?: string;
  /** false = giá tại mỏ, CHƯA gồm vận chuyển/bốc xếp (vật liệu rời: cát, đá). */
  @Prop() includesTransport?: boolean;
  /** high = công bố Sở Xây dựng; medium = báo giá đại lý/nhà máy. */
  @Prop({ type: String }) sourceConfidence?: 'high' | 'medium';
}
export const PriceItemSchema = SchemaFactory.createForClass(PriceItem);
PriceItemSchema.index({ priceSetId: 1, refCode: 1 });
PriceItemSchema.index({ name: 'text' });
