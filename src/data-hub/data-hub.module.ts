import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

// Sources
import { Source, SourceSchema } from './sources/source.schema';
import { SourceRegistryService } from './sources/source-registry.service';

// Crawlers
import { CrawlJob, CrawlJobSchema } from './crawlers/crawl-job.schema';
import { CrawlerRunnerService } from './crawlers/crawler-runner.service';
import { CrawlerBXD } from './crawlers/impls/crawler-bxd';
import { CrawlerVKTXD } from './crawlers/impls/crawler-vktxd';
import { CrawlerHCM } from './crawlers/impls/crawler-hcm';
import { CrawlerHN } from './crawlers/impls/crawler-hn';
import { CrawlerBinhDuong } from './crawlers/impls/crawler-binhduong';
import { CrawlerDongNai } from './crawlers/impls/crawler-dongnai';
import { CrawlerQLDA } from './crawlers/impls/crawler-qlda';

// Raw Storage
import { RawStorageService } from './raw-storage/raw-storage.service';

// Parsers
import { PdfParserService } from './parsers/pdf-parser.service';
import { ExcelParserService } from './parsers/excel-parser.service';

// Normalizer
import { NormalizeService } from './normalizers/normalize.service';

// Search
import { MeilisearchService } from './search/meilisearch.service';

// Catalog
import { CatalogCode, CatalogCodeSchema } from './catalog/catalog-code.schema';
import { CatalogDbService } from './catalog/catalog-db.service';

// Prices
import { MaterialPrice, MaterialPriceSchema } from './prices/material-price.schema';
import { PriceService } from './prices/price.service';

// Documents
import { LegalDocument, LegalDocumentSchema } from './documents/document.schema';
import { DocumentChunk, DocumentChunkSchema } from './documents/document-chunk.schema';
import { DocumentService } from './documents/document.service';

// Agents (Sprint 5)
import { ReviewAgentService } from './agents/review-agent.service';
import { PriceAgentService } from './agents/price-agent.service';
import { LegalAgentService } from './agents/legal-agent.service';

// Knowledge Graph (Sprint 5)
import { KnowledgeGraphService } from './knowledge/knowledge-graph.service';
import { KnowledgeController } from './knowledge/knowledge.controller';

// Controllers
import { SuggestController } from './suggest/suggest.controller';
import { DataHubAdminController } from './admin/data-hub-admin.controller';

const CRAWLERS = [
  CrawlerBXD, CrawlerVKTXD, CrawlerHCM, CrawlerHN,
  CrawlerBinhDuong, CrawlerDongNai, CrawlerQLDA,
];

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Source.name, schema: SourceSchema },
      { name: CrawlJob.name, schema: CrawlJobSchema },
      { name: CatalogCode.name, schema: CatalogCodeSchema },
      { name: MaterialPrice.name, schema: MaterialPriceSchema },
      { name: LegalDocument.name, schema: LegalDocumentSchema },
      { name: DocumentChunk.name, schema: DocumentChunkSchema },
    ]),
  ],
  controllers: [SuggestController, DataHubAdminController, KnowledgeController],
  providers: [
    // Sources
    SourceRegistryService,
    // Crawlers
    CrawlerRunnerService,
    ...CRAWLERS,
    // Infrastructure
    RawStorageService,
    PdfParserService,
    ExcelParserService,
    NormalizeService,
    MeilisearchService,
    // Knowledge stores
    CatalogDbService,
    PriceService,
    DocumentService,
    // AI Agents
    ReviewAgentService,
    PriceAgentService,
    LegalAgentService,
    // Knowledge Graph
    KnowledgeGraphService,
  ],
  exports: [
    CatalogDbService,
    PriceService,
    DocumentService,
    SourceRegistryService,
    CrawlerRunnerService,
    RawStorageService,
    PdfParserService,
    ExcelParserService,
    NormalizeService,
    MeilisearchService,
    ReviewAgentService,
    PriceAgentService,
    LegalAgentService,
  ],
})
export class DataHubModule {
  constructor(
    private readonly runner: CrawlerRunnerService,
    private readonly bxd: CrawlerBXD,
    private readonly vktxd: CrawlerVKTXD,
    private readonly hcm: CrawlerHCM,
    private readonly hn: CrawlerHN,
    private readonly binhDuong: CrawlerBinhDuong,
    private readonly dongNai: CrawlerDongNai,
    private readonly qlda: CrawlerQLDA,
  ) {}

  onModuleInit() {
    // Auto-register all crawlers
    [this.bxd, this.vktxd, this.hcm, this.hn, this.binhDuong, this.dongNai, this.qlda]
      .forEach((c) => this.runner.register(c));
  }
}
