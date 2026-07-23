import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NotificationController } from './notification/notification.controller';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { DataHubCoreModule } from './data-hub/data-hub-core.module';
import { DataHubAdminModule } from './data-hub/data-hub-admin.module';
import { EstimateModule } from './estimate/estimate.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { DrawingModule } from './drawing/drawing.module';
import { QueueModule } from './queue/queue.module';
import { UsageModule } from './usage/usage.module';
import { AuditModule } from './audit/audit.module';
import { DashboardModule } from './dashboard/dashboard.module';

const isAdmin = process.env.DATAHUB_ADMIN === 'true';
const redisUrl = process.env.REDIS_URL;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
        maxPoolSize: 3,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5000,
      }),
    }),
    EventEmitterModule.forRoot(),
    // BullMQ root — only when Redis is configured. family:0 = dual-stack DNS để
    // kết nối Redis private của Railway (IPv6-only); thiếu → connection fail.
    ...(redisUrl
      ? [BullModule.forRoot({ connection: { url: redisUrl, family: 0 } })]
      : []),
    StorageModule,
    UsersModule,
    AuthModule,
    CatalogModule,
    isAdmin ? DataHubAdminModule : DataHubCoreModule,
    EstimateModule,
    DrawingModule,
    ...(redisUrl ? [QueueModule] : []),
    UsageModule,
    AuditModule,
    DashboardModule,
  ],
  controllers: [AppController, NotificationController],
  providers: [AppService],
})
export class AppModule {}
