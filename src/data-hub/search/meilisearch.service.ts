import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Meilisearch as MeiliSearch, Index } from 'meilisearch';

export interface CatalogSearchDoc {
  id: string;
  code: string;
  name: string;
  group: string;
  unit: string;
  material: number;
  labor: number;
  machine: number;
  trust: number;
  sourceId: string;
}

export interface DocumentSearchDoc {
  id: string;
  title: string;
  docType: string;
  issuedDate: string;
  content: string;
  sourceId: string;
  province?: string;
}

@Injectable()
export class MeilisearchService implements OnModuleInit {
  private readonly logger = new Logger(MeilisearchService.name);
  private client: MeiliSearch | null = null;
  private catalogIdx: Index | null = null;
  private documentsIdx: Index | null = null;
  private available = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('MEILISEARCH_HOST') ?? 'http://localhost:7700';
    const apiKey = this.config.get<string>('MEILISEARCH_API_KEY') ?? '';
    try {
      this.client = new MeiliSearch({ host, apiKey });
      await this.client.health();
      await this.setupIndexes();
      this.available = true;
      this.logger.log('Meilisearch connected');
    } catch {
      this.logger.warn('Meilisearch not available — falling back to MongoDB text search');
    }
  }

  get isAvailable() { return this.available; }

  private async getOrCreate(client: MeiliSearch, uid: string, primaryKey: string): Promise<Index> {
    try {
      return client.index(uid);
    } catch {
      await client.createIndex(uid, { primaryKey });
      return client.index(uid);
    }
  }

  private async setupIndexes() {
    const client = this.client!;
    this.catalogIdx = await this.getOrCreate(client, 'catalog_codes', 'id');
    await this.catalogIdx!.updateSettings({
      searchableAttributes: ['code', 'name', 'group'],
      filterableAttributes: ['group', 'sourceId', 'trust'],
      sortableAttributes: ['trust'],
      rankingRules: ['typo', 'words', 'proximity', 'attribute', 'sort', 'exactness'],
    });

    this.documentsIdx = await this.getOrCreate(client, 'documents', 'id');
    await this.documentsIdx!.updateSettings({
      searchableAttributes: ['title', 'content', 'docType'],
      filterableAttributes: ['docType', 'province', 'sourceId'],
      sortableAttributes: ['issuedDate'],
    });
  }

  async indexCatalogCodes(docs: CatalogSearchDoc[]) {
    if (!this.available || !this.catalogIdx) return;
    await this.catalogIdx.addDocuments(docs, { primaryKey: 'id' });
  }

  async searchCatalog(q: string, limit = 10): Promise<CatalogSearchDoc[]> {
    if (!this.available || !this.catalogIdx) return [];
    const res = await this.catalogIdx.search<CatalogSearchDoc>(q, { limit });
    return res.hits;
  }

  async indexDocument(doc: DocumentSearchDoc) {
    if (!this.available || !this.documentsIdx) return;
    await this.documentsIdx.addDocuments([doc], { primaryKey: 'id' });
  }

  async searchDocuments(q: string, limit = 5): Promise<DocumentSearchDoc[]> {
    if (!this.available || !this.documentsIdx) return [];
    const res = await this.documentsIdx.search<DocumentSearchDoc>(q, { limit });
    return res.hits;
  }
}
