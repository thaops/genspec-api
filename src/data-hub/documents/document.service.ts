import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LegalDocument, DocType } from './document.schema';
import { DocumentChunk } from './document-chunk.schema';
import { MeilisearchService } from '../search/meilisearch.service';
import { PdfParserService } from '../parsers/pdf-parser.service';

const CHUNK_SIZE = 1800;

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    @InjectModel(LegalDocument.name) private readonly docModel: Model<LegalDocument>,
    @InjectModel(DocumentChunk.name) private readonly chunkModel: Model<DocumentChunk>,
    private readonly search: MeilisearchService,
    private readonly pdfParser: PdfParserService,
  ) {}

  async ingestPdf(input: {
    title: string;
    docType: DocType;
    number?: string;
    issuedBy?: string;
    issuedDate?: Date;
    sourceId: string;
    province?: string;
    rawStoragePath: string;
    originalUrl: string;
    buffer: Buffer;
  }): Promise<string> {
    const parsed = await this.pdfParser.parse(input.buffer, input.sourceId);

    const existing = await this.docModel.findOne({ number: input.number, sourceId: input.sourceId });
    if (existing) {
      this.logger.debug(`Document already ingested: ${input.number}`);
      return String(existing._id);
    }

    const doc = await this.docModel.create({
      title: input.title,
      docType: input.docType,
      number: input.number,
      issuedBy: input.issuedBy,
      issuedDate: input.issuedDate,
      sourceId: input.sourceId,
      province: input.province,
      rawStoragePath: input.rawStoragePath,
      originalUrl: input.originalUrl,
      trust: 80,
      active: true,
      fullText: parsed.text.slice(0, 500_000),
    });

    await this.chunkAndStore(doc._id as Types.ObjectId, parsed.text);

    await this.search.indexDocument({
      id: String(doc._id),
      title: doc.title,
      docType: doc.docType,
      issuedDate: doc.issuedDate?.toISOString() ?? '',
      content: parsed.text.slice(0, 5000),
      sourceId: doc.sourceId,
      province: doc.province,
    });

    this.logger.log(`Ingested: ${input.title} (${parsed.pageCount}p, ${parsed.text.length}c)`);
    return String(doc._id);
  }

  async find(q: string, docType?: DocType, province?: string, limit = 5): Promise<LegalDocument[]> {
    if (this.search.isAvailable) {
      const hits = await this.search.searchDocuments(q, limit);
      if (hits.length > 0) {
        const ids = hits.map((h) => new Types.ObjectId(h.id));
        return this.docModel.find({ _id: { $in: ids } }).lean().exec() as any;
      }
    }
    const filter: any = { active: true };
    if (docType) filter.docType = docType;
    if (province) filter.province = province;
    return this.docModel
      .find({ ...filter, $text: { $search: q } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean()
      .exec() as any;
  }

  async findByNumber(number: string): Promise<LegalDocument | null> {
    return this.docModel.findOne({ number, active: true }).lean().exec() as any;
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    return this.chunkModel
      .find({ documentId: new Types.ObjectId(documentId) })
      .sort({ chunkIndex: 1 })
      .lean()
      .exec() as any;
  }

  private async chunkAndStore(documentId: Types.ObjectId, text: string) {
    if (!text) return;
    const chunks: any[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push({
        documentId,
        chunkIndex: Math.floor(i / CHUNK_SIZE),
        text: text.slice(i, i + CHUNK_SIZE),
        pageNumber: 0,
      });
    }
    await this.chunkModel.insertMany(chunks, { ordered: false }).catch(() => {});
  }
}
