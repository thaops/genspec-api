import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobStatusController } from './job-status.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DRAWING_QUEUE } from './drawing.queue';
import { DrawingJobProcessor } from './drawing.processor';
import { MongooseModule } from '@nestjs/mongoose';
import { Drawing, DrawingSchema } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectSchema } from '../drawing/schemas/drawing-object.schema';
import { DrawingIndex, DrawingIndexSchema } from '../drawing/schemas/drawing-index.schema';
import { DrawingRelationship, DrawingRelationshipSchema } from '../drawing/schemas/drawing-relationship.schema';
import { DrawingNormalizerService } from '../drawing/services/drawing-normalizer.service';
import { DrawingDetectorService } from '../drawing/services/drawing-detector.service';
import { DrawingIndexerService } from '../drawing/services/drawing-indexer.service';
import { DrawingGraphService } from '../drawing/services/drawing-graph.service';
import { DrawingParserFactory } from '../drawing/parsers/drawing-parser.factory';
import { PdfParserService } from '../drawing/parsers/pdf-parser.service';
import { DxfParserService } from '../drawing/parsers/dxf-parser.service';
import { DwgConverterService } from '../drawing/converters/dwg-converter.service';
import { CloudinaryService } from '../storage/cloudinary.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
        },
      }),
    }),
    BullModule.registerQueue({ name: DRAWING_QUEUE }),
    MongooseModule.forFeature([
      { name: Drawing.name,             schema: DrawingSchema },
      { name: DrawingObject.name,       schema: DrawingObjectSchema },
      { name: DrawingIndex.name,        schema: DrawingIndexSchema },
      { name: DrawingRelationship.name, schema: DrawingRelationshipSchema },
    ]),
  ],
  providers: [
    DrawingJobProcessor,
    DrawingNormalizerService,
    DrawingDetectorService,
    DrawingIndexerService,
    DrawingGraphService,
    DrawingParserFactory,
    PdfParserService,
    DxfParserService,
    DwgConverterService,
    CloudinaryService,
  ],
  controllers: [JobStatusController],
  exports: [BullModule],
})
export class QueueModule {}
