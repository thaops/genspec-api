import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Source } from './source.schema';
import { SourceDefinition } from './source.types';

const BUILT_IN_SOURCES: SourceDefinition[] = [
  {
    id: 'bxd',
    name: 'Bộ Xây dựng',
    type: 'official',
    priority: 100,
    schedule: '0 2 * * *',
    status: 'active',
    crawlerKey: 'CrawlerBXD',
    baseUrl: 'https://moc.gov.vn',
  },
  {
    id: 'vktxd',
    name: 'Viện Kinh tế Xây dựng',
    type: 'official',
    priority: 95,
    schedule: '0 3 * * *',
    status: 'active',
    crawlerKey: 'CrawlerVKTXD',
    baseUrl: 'https://vktxd.vn',
  },
  {
    id: 'hcm',
    name: 'Sở XD TP.HCM',
    type: 'official',
    priority: 90,
    schedule: '0 2 * * *',
    status: 'active',
    crawlerKey: 'CrawlerHCM',
    baseUrl: 'https://socongthuong.hochiminhcity.gov.vn',
  },
  {
    id: 'hn',
    name: 'Sở XD Hà Nội',
    type: 'official',
    priority: 90,
    schedule: '0 2 * * *',
    status: 'active',
    crawlerKey: 'CrawlerHN',
    baseUrl: 'https://sxd.hanoi.gov.vn',
  },
  {
    id: 'binhduong',
    name: 'Sở XD Bình Dương',
    type: 'official',
    priority: 85,
    schedule: '0 2 * * *',
    status: 'active',
    crawlerKey: 'CrawlerBinhDuong',
  },
  {
    id: 'dongnai',
    name: 'Sở XD Đồng Nai',
    type: 'official',
    priority: 85,
    schedule: '0 2 * * *',
    status: 'active',
    crawlerKey: 'CrawlerDongNai',
  },
  {
    id: 'qlda',
    name: 'QLDA GXD',
    type: 'reference',
    priority: 60,
    schedule: '0 4 * * *',
    status: 'active',
    crawlerKey: 'CrawlerQLDA',
    baseUrl: 'https://gxd.vn',
  },
];

@Injectable()
export class SourceRegistryService implements OnModuleInit {
  private readonly logger = new Logger(SourceRegistryService.name);

  constructor(@InjectModel(Source.name) private readonly model: Model<Source>) {}

  async onModuleInit() {
    await this.seedBuiltInSources();
  }

  async all(): Promise<Source[]> {
    return this.model.find().sort({ priority: -1 }).lean().exec() as any;
  }

  async findById(sourceId: string): Promise<Source | null> {
    return this.model.findOne({ sourceId }).lean().exec() as any;
  }

  async updateStatus(sourceId: string, status: string, error?: string) {
    await this.model.updateOne(
      { sourceId },
      { status, lastError: error, ...(status === 'active' ? { lastCrawledAt: new Date() } : {}) },
    );
  }

  private async seedBuiltInSources() {
    for (const src of BUILT_IN_SOURCES) {
      await this.model.updateOne(
        { sourceId: src.id },
        {
          $setOnInsert: {
            sourceId: src.id,
            name: src.name,
            type: src.type,
            priority: src.priority,
            schedule: src.schedule,
            status: src.status,
            crawlerKey: src.crawlerKey,
            baseUrl: src.baseUrl,
          },
        },
        { upsert: true },
      );
    }
    this.logger.log(`Source registry seeded — ${BUILT_IN_SOURCES.length} sources`);
  }
}
