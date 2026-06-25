import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuid } from 'uuid';
import { CrawlJob } from './crawl-job.schema';
import { ICrawler, CrawlContext } from './crawler.interface';
import { RawStorageService } from '../raw-storage/raw-storage.service';
import { SourceRegistryService } from '../sources/source-registry.service';

@Injectable()
export class CrawlerRunnerService {
  private readonly logger = new Logger(CrawlerRunnerService.name);
  private readonly crawlers = new Map<string, ICrawler>();

  constructor(
    @InjectModel(CrawlJob.name) private readonly jobModel: Model<CrawlJob>,
    private readonly rawStorage: RawStorageService,
    private readonly sourceRegistry: SourceRegistryService,
  ) {}

  /** Register a crawler implementation — called by each crawler module */
  register(crawler: ICrawler) {
    this.crawlers.set(crawler.key, crawler);
    this.logger.log(`Crawler registered: ${crawler.key}`);
  }

  async runSource(sourceId: string, triggeredBy: 'schedule' | 'manual' = 'manual'): Promise<string> {
    const source = await this.sourceRegistry.findById(sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);

    const crawler = this.crawlers.get(source.crawlerKey);
    if (!crawler) throw new Error(`No crawler registered for key: ${source.crawlerKey}`);

    const job = await this.jobModel.create({
      sourceId,
      crawlerKey: source.crawlerKey,
      status: 'pending',
      triggeredBy,
    });

    // run async — don't await
    this.executeJob(job.id as string, source, crawler).catch((err) =>
      this.logger.error(`Job ${job.id} crashed: ${err.message}`),
    );

    return job.id as string;
  }

  private async executeJob(jobId: string, source: any, crawler: ICrawler) {
    await this.jobModel.updateOne({ _id: jobId }, { status: 'running', startedAt: new Date() });

    const ctx: CrawlContext = {
      sourceId: source.sourceId,
      crawlerKey: source.crawlerKey,
      baseUrl: source.baseUrl,
      jobId,
    };

    try {
      const result = await crawler.crawl(ctx);
      let saved = 0;

      for (const file of result.files) {
        if (file.buffer) {
          await this.rawStorage.save({
            sourceId: source.sourceId,
            filename: file.filename,
            buffer: file.buffer,
            mimeType: file.mimeType,
            url: file.url,
            documentType: file.documentType,
          });
          saved++;
        }
      }

      await this.jobModel.updateOne(
        { _id: jobId },
        {
          status: 'done',
          finishedAt: new Date(),
          filesFound: result.files.length,
          filesSaved: saved,
          crawlErrors: result.errors,
        },
      );
      await this.sourceRegistry.updateStatus(source.sourceId, 'active');
    } catch (err) {
      const msg = (err as Error).message;
      await this.jobModel.updateOne(
        { _id: jobId },
        { status: 'failed', finishedAt: new Date(), crawlErrors: [msg] },
      );
      await this.sourceRegistry.updateStatus(source.sourceId, 'error', msg);
    }
  }

  async listJobs(sourceId?: string, limit = 20): Promise<CrawlJob[]> {
    const filter = sourceId ? { sourceId } : {};
    return this.jobModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean().exec() as any;
  }
}
