import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
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

const isAdmin = process.env.DATAHUB_ADMIN === 'true';

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
    StorageModule,
    UsersModule,
    AuthModule,
    CatalogModule,
    isAdmin ? DataHubAdminModule : DataHubCoreModule,
    EstimateModule,
    DrawingModule,
    QueueModule,
  ],
  controllers: [AppController, NotificationController],
  providers: [AppService],
})
export class AppModule {}
