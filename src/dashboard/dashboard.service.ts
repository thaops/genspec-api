import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { Estimate, EstimateDocument } from '../estimate/estimate.schema';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { CrawlJob } from '../data-hub/crawlers/crawl-job.schema';
import { DRAWING_QUEUE } from '../queue/drawing.queue';
import { UsersService } from '../users/users.service';
import { AiUsageService } from '../usage/ai-usage.service';
import { CloudinaryService } from '../storage/cloudinary.service';
import { CacheService } from '../common/cache.service';

const CACHE_KEY = 'admin:dashboard';
const CACHE_TTL_SECONDS = 30;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectModel(Estimate.name) private readonly estimateModel: Model<EstimateDocument>,
    @InjectModel(Drawing.name) private readonly drawingModel: Model<DrawingDocument>,
    @InjectModel(CrawlJob.name) private readonly crawlJobModel: Model<CrawlJob>,
    private readonly users: UsersService,
    private readonly aiUsage: AiUsageService,
    private readonly cloudinary: CloudinaryService,
    private readonly cache: CacheService,
    @Optional() @InjectQueue(DRAWING_QUEUE) private readonly drawingQueue?: Queue,
  ) {}

  async snapshot() {
    const cached = await this.cache.get<Record<string, unknown>>(CACHE_KEY);
    if (cached) return cached;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [usersTotal, usersActiveToday, estimatesToday, drawingsToday, aiToday, crawlByStatus, queueCounts, storage] =
      await Promise.all([
        this.users.countTotal(),
        this.users.countActiveSince(startOfDay),
        this.estimateModel.countDocuments({ createdAt: { $gte: startOfDay } }).exec(),
        this.drawingModel.countDocuments({ createdAt: { $gte: startOfDay } }).exec(),
        this.aiUsage.todaySummary(),
        this.crawlJobModel
          .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
          .then((rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]))),
        this.queueStats(),
        this.cloudinary.usage().catch(() => null),
      ]);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      users: { total: usersTotal, activeToday: usersActiveToday },
      estimatesToday,
      drawingsToday,
      ai: aiToday,
      crawl: { byStatus: crawlByStatus },
      queue: queueCounts,
      storage,
    };

    await this.cache.set(CACHE_KEY, snapshot, CACHE_TTL_SECONDS);
    return snapshot;
  }

  private async queueStats() {
    if (!this.drawingQueue) return null;
    try {
      return await this.drawingQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    } catch (err) {
      this.logger.warn(`Queue stats failed: ${(err as Error).message}`);
      return null;
    }
  }
}
