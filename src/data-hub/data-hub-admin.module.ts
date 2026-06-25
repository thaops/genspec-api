import { Module } from '@nestjs/common';

import { DataHubCoreModule } from './data-hub-core.module';

import { RawStorageService } from './raw-storage/raw-storage.service';
import { PdfParserService } from './parsers/pdf-parser.service';
import { ExcelParserService } from './parsers/excel-parser.service';

import { CrawlerRunnerService } from './crawlers/crawler-runner.service';
import { CrawlerBXD } from './crawlers/impls/crawler-bxd';
import { CrawlerVKTXD } from './crawlers/impls/crawler-vktxd';
import { CrawlerHCM } from './crawlers/impls/crawler-hcm';
import { CrawlerHN } from './crawlers/impls/crawler-hn';
import { CrawlerBinhDuong } from './crawlers/impls/crawler-binhduong';
import { CrawlerDongNai } from './crawlers/impls/crawler-dongnai';
import { CrawlerQLDA } from './crawlers/impls/crawler-qlda';

import { ReviewAgentService } from './agents/review-agent.service';
import { PriceAgentService } from './agents/price-agent.service';
import { LegalAgentService } from './agents/legal-agent.service';

import { DataHubAdminController } from './admin/data-hub-admin.controller';

const CRAWLERS = [
  CrawlerBXD, CrawlerVKTXD, CrawlerHCM, CrawlerHN,
  CrawlerBinhDuong, CrawlerDongNai, CrawlerQLDA,
];

@Module({
  imports: [DataHubCoreModule],
  controllers: [DataHubAdminController],
  providers: [
    RawStorageService,
    PdfParserService,
    ExcelParserService,
    CrawlerRunnerService,
    ...CRAWLERS,
    ReviewAgentService,
    PriceAgentService,
    LegalAgentService,
  ],
  exports: [
    RawStorageService,
    PdfParserService,
    ExcelParserService,
    CrawlerRunnerService,
    ReviewAgentService,
    PriceAgentService,
    LegalAgentService,
  ],
})
export class DataHubAdminModule {
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
    [this.bxd, this.vktxd, this.hcm, this.hn, this.binhDuong, this.dongNai, this.qlda]
      .forEach((c) => this.runner.register(c));
  }
}
