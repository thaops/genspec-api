import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Estimate, EstimateSchema } from '../estimate/estimate.schema';
import { Drawing, DrawingSchema } from '../drawing/schemas/drawing.schema';
import { CrawlJob, CrawlJobSchema } from '../data-hub/crawlers/crawl-job.schema';
import { DRAWING_QUEUE } from '../queue/drawing.queue';
import { UsersModule } from '../users/users.module';
import { UsageModule } from '../usage/usage.module';
import { CacheService } from '../common/cache.service';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

const redisUrl = process.env.REDIS_URL;

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Estimate.name, schema: EstimateSchema },
      { name: Drawing.name, schema: DrawingSchema },
      { name: CrawlJob.name, schema: CrawlJobSchema },
    ]),
    ...(redisUrl ? [BullModule.registerQueue({ name: DRAWING_QUEUE })] : []),
    UsersModule,
    UsageModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService, CacheService],
})
export class DashboardModule {}
