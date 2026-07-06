import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { DRAWING_QUEUE } from './drawing.queue';
import { DrawingJobProcessor } from './drawing.processor';
import { JobStatusController } from './job-status.controller';
import { Drawing, DrawingSchema } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectSchema } from '../drawing/schemas/drawing-object.schema';
import { DrawingIndex, DrawingIndexSchema } from '../drawing/schemas/drawing-index.schema';
import { DrawingRelationship, DrawingRelationshipSchema } from '../drawing/schemas/drawing-relationship.schema';
import { DrawingNormalizerService } from '../drawing/services/drawing-normalizer.service';
import { DrawingDetectorService } from '../drawing/services/drawing-detector.service';
import { DrawingLayerRuleService } from '../drawing/services/drawing-layer-rule.service';
import { DrawingLayerRule, DrawingLayerRuleSchema } from '../drawing/schemas/drawing-layer-rule.schema';
import { DrawingObjectOverrideService } from '../drawing/services/drawing-object-override.service';
import { DrawingObjectOverride, DrawingObjectOverrideSchema } from '../drawing/schemas/drawing-object-override.schema';
import { DrawingIndexerService } from '../drawing/services/drawing-indexer.service';
import { DrawingGraphService } from '../drawing/services/drawing-graph.service';
import { DrawingParserFactory } from '../drawing/parsers/drawing-parser.factory';
import { PdfParserService } from '../drawing/parsers/pdf-parser.service';
import { DxfParserService } from '../drawing/parsers/dxf-parser.service';
import { DwgConverterService } from '../drawing/converters/dwg-converter.service';
import { CloudinaryService } from '../storage/cloudinary.service';
import { SceneBuilderService } from '../drawing/services/scene-builder.service';
import { DrawingSceneService } from '../drawing/services/drawing-scene.service';
import { DrawingSceneEntity, DrawingSceneSchema } from '../drawing/schemas/drawing-scene.schema';

// BullModule.forRoot() is registered globally in AppModule.
// This module only registers the queue and its processor.
@Module({
  imports: [
    BullModule.registerQueue({ name: DRAWING_QUEUE }),
    MongooseModule.forFeature([
      { name: Drawing.name,             schema: DrawingSchema },
      { name: DrawingObject.name,       schema: DrawingObjectSchema },
      { name: DrawingIndex.name,        schema: DrawingIndexSchema },
      { name: DrawingRelationship.name, schema: DrawingRelationshipSchema },
      { name: DrawingSceneEntity.name,  schema: DrawingSceneSchema },
      { name: DrawingLayerRule.name,    schema: DrawingLayerRuleSchema },
      { name: DrawingObjectOverride.name, schema: DrawingObjectOverrideSchema },
    ]),
  ],
  providers: [
    DrawingJobProcessor,
    DrawingNormalizerService,
    DrawingDetectorService,
    DrawingLayerRuleService,
    DrawingObjectOverrideService,
    DrawingIndexerService,
    DrawingGraphService,
    DrawingParserFactory,
    PdfParserService,
    DxfParserService,
    DwgConverterService,
    CloudinaryService,
    SceneBuilderService,
    DrawingSceneService,
  ],
  controllers: [JobStatusController],
  exports: [BullModule],
})
export class QueueModule {}
