import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DocType = 'thong_tu' | 'nghi_dinh' | 'quyet_dinh' | 'qcvn' | 'tcvn' | 'bang_gia' | 'dinh_muc' | 'other';

@Schema({ collection: 'documents', timestamps: true })
export class LegalDocument extends Document {
  @Prop({ required: true }) title: string;
  @Prop({ type: String, enum: ['thong_tu', 'nghi_dinh', 'quyet_dinh', 'qcvn', 'tcvn', 'bang_gia', 'dinh_muc', 'other'], default: 'other' }) docType: DocType;
  @Prop() number: string;
  @Prop() issuedBy: string;
  @Prop() issuedDate: Date;
  @Prop() effectiveDate: Date;
  @Prop() expireDate: Date;
  @Prop({ required: true }) sourceId: string;
  @Prop() province: string;
  @Prop() rawStoragePath: string;
  @Prop() originalUrl: string;
  @Prop({ default: 50 }) trust: number;
  @Prop({ default: true }) active: boolean;
  @Prop() fullText: string;
}

export const LegalDocumentSchema = SchemaFactory.createForClass(LegalDocument);
LegalDocumentSchema.index({ docType: 1, active: 1 });
LegalDocumentSchema.index({ number: 1 });
LegalDocumentSchema.index({ title: 'text', fullText: 'text' });
