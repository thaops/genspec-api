import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Source, SourceSchema } from './sources/source.schema';
import { SourceRegistryService } from './sources/source-registry.service';

import { CrawlJob, CrawlJobSchema } from './crawlers/crawl-job.schema';

import { NormalizeService } from './normalizers/normalize.service';
import { MeilisearchService } from './search/meilisearch.service';

import { CatalogCode, CatalogCodeSchema } from './catalog/catalog-code.schema';
import { CatalogDbService } from './catalog/catalog-db.service';

import { MaterialPrice, MaterialPriceSchema } from './prices/material-price.schema';
import { PriceService } from './prices/price.service';

import { LegalDocument, LegalDocumentSchema } from './documents/document.schema';
import { DocumentChunk, DocumentChunkSchema } from './documents/document-chunk.schema';
import { DocumentService } from './documents/document.service';

import { SuggestController } from './suggest/suggest.controller';

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
  controllers: [SuggestController],
  providers: [
    SourceRegistryService,
    NormalizeService,
    MeilisearchService,
    CatalogDbService,
    PriceService,
    DocumentService,
  ],
  exports: [
    CatalogDbService,
    PriceService,
    DocumentService,
    SourceRegistryService,
    NormalizeService,
    MeilisearchService,
  ],
})
export class DataHubCoreModule {}
