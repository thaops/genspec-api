import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ collection: 'document_chunks', timestamps: true })
export class DocumentChunk extends Document {
  @Prop({ required: true, type: Types.ObjectId, ref: 'LegalDocument', index: true }) documentId: Types.ObjectId;
  @Prop({ required: true }) chunkIndex: number;
  @Prop({ required: true }) text: string;
  @Prop({ type: [Number] }) embedding: number[];
  @Prop() pageNumber: number;
}

export const DocumentChunkSchema = SchemaFactory.createForClass(DocumentChunk);
DocumentChunkSchema.index({ documentId: 1, chunkIndex: 1 }, { unique: true });
