import { Injectable, Logger } from '@nestjs/common';
import { DocumentService } from '../documents/document.service';
import { buildDataHubTools } from '../tools/data-hub.tools';
import { CatalogDbService } from '../catalog/catalog-db.service';
import { PriceService } from '../prices/price.service';

export interface LegalReference {
  title: string;
  number?: string;
  docType: string;
  issuedDate?: Date;
  relevantChunks: string[];
  url?: string;
}

export interface LegalAgentResult {
  query: string;
  references: LegalReference[];
  answer: string;   // synthesized answer (filled by AI caller)
}

@Injectable()
export class LegalAgentService {
  private readonly logger = new Logger(LegalAgentService.name);

  constructor(
    private readonly catalog: CatalogDbService,
    private readonly price: PriceService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * Sprint 5 — AI Legal Agent
   * Finds relevant legal documents for a query and returns structured references + chunks for RAG.
   */
  async search(query: string, province?: string): Promise<LegalAgentResult> {
    const tools = buildDataHubTools(this.catalog, this.price, this.documents);

    // Search documents
    const docs = await tools['document.find']({ q: query, province, limit: 5 }) as any[];

    const references: LegalReference[] = await Promise.all(
      docs.map(async (doc: any) => {
        const chunks = await this.documents.getChunks(String(doc._id));
        // Find most relevant chunks by simple keyword overlap
        const qWords = query.toLowerCase().split(/\s+/);
        const scored = chunks
          .map((c: any) => {
            const text = c.text.toLowerCase();
            const score = qWords.filter((w) => text.includes(w)).length;
            return { text: c.text, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((c) => c.text);

        return {
          title: doc.title,
          number: doc.number,
          docType: doc.docType,
          issuedDate: doc.issuedDate,
          relevantChunks: scored,
          url: doc.originalUrl,
        };
      }),
    );

    this.logger.log(`Legal agent: ${references.length} references for "${query}"`);

    return {
      query,
      references,
      // answer is empty — AI model fills this using the references as context
      answer: '',
    };
  }
}
