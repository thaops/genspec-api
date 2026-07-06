import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { DrawingController } from './drawing.controller';
// Pipeline
import { DrawingParserService } from './services/drawing-parser.service';
import { DrawingNormalizerService } from './services/drawing-normalizer.service';
import { DrawingDetectorService } from './services/drawing-detector.service';
import { DrawingLayerRuleService } from './services/drawing-layer-rule.service';
import { DrawingObjectOverrideService } from './services/drawing-object-override.service';
import { DrawingLlmClassifierService } from './services/drawing-llm-classifier.service';
import { DrawingIndexerService } from './services/drawing-indexer.service';
// Parsers
import { DrawingParserFactory } from './parsers/drawing-parser.factory';
import { PdfParserService } from './parsers/pdf-parser.service';
import { DxfParserService } from './parsers/dxf-parser.service';
import { DwgParserService } from './parsers/dwg-parser.service';
// Converter
import { DwgConverterService } from './converters/dwg-converter.service';
// Core services
import { DrawingUploadService } from './services/drawing-upload.service';
import { DrawingSearchService } from './services/drawing-search.service';
import { DrawingDetectService } from './services/drawing-detect.service';
import { DrawingCompareService } from './services/drawing-compare.service';
import { DrawingGraphService } from './services/drawing-graph.service';
import { DrawingAnnotationService } from './services/drawing-annotation.service';
import { DrawingRevisionService } from './services/drawing-revision.service';
import { DrawingThumbnailService } from './services/drawing-thumbnail.service';
import { DrawingCacheService } from './services/drawing-cache.service';
import { SceneBuilderService } from './services/scene-builder.service';
import { DrawingSceneService } from './services/drawing-scene.service';
// Engines
import { ProposalEngineService } from './services/proposal-engine.service';
import { WorkspaceGraphService } from './services/workspace-graph.service';
// Schemas
import { Drawing, DrawingSchema } from './schemas/drawing.schema';
import { DrawingObject, DrawingObjectSchema } from './schemas/drawing-object.schema';
import { DrawingRelationship, DrawingRelationshipSchema } from './schemas/drawing-relationship.schema';
import { DrawingRevision, DrawingRevisionSchema } from './schemas/drawing-revision.schema';
import { DrawingIndex, DrawingIndexSchema } from './schemas/drawing-index.schema';
import { DrawingAnnotation, DrawingAnnotationSchema } from './schemas/drawing-annotation.schema';
import { DrawingSceneEntity, DrawingSceneSchema } from './schemas/drawing-scene.schema';
import { DrawingLayerRule, DrawingLayerRuleSchema } from './schemas/drawing-layer-rule.schema';
import { DrawingObjectOverride, DrawingObjectOverrideSchema } from './schemas/drawing-object-override.schema';

@Module({
  imports: [
    AiModule,
    MongooseModule.forFeature([
      { name: Drawing.name,             schema: DrawingSchema },
      { name: DrawingObject.name,       schema: DrawingObjectSchema },
      { name: DrawingRelationship.name, schema: DrawingRelationshipSchema },
      { name: DrawingRevision.name,     schema: DrawingRevisionSchema },
      { name: DrawingIndex.name,        schema: DrawingIndexSchema },
      { name: DrawingAnnotation.name,   schema: DrawingAnnotationSchema },
      { name: DrawingSceneEntity.name,  schema: DrawingSceneSchema },
      { name: DrawingLayerRule.name,    schema: DrawingLayerRuleSchema },
      { name: DrawingObjectOverride.name, schema: DrawingObjectOverrideSchema },
    ]),
  ],
  controllers: [DrawingController],
  providers: [
    // Pipeline (event-driven)
    DrawingParserService,
    DrawingNormalizerService,
    DrawingDetectorService,
    DrawingLayerRuleService,
    DrawingObjectOverrideService,
    DrawingLlmClassifierService,
    DrawingIndexerService,
    // Parsers
    DrawingParserFactory,
    PdfParserService,
    DxfParserService,
    DwgParserService,
    // Converter (kept for queue-based ODA path if REDIS_URL + ODA_CONVERTER_BIN set)
    DwgConverterService,
    // Core
    DrawingUploadService,
    DrawingSearchService,
    DrawingDetectService,
    DrawingCompareService,
    DrawingGraphService,
    DrawingAnnotationService,
    DrawingRevisionService,
    DrawingThumbnailService,
    DrawingCacheService,
    // Scene
    SceneBuilderService,
    DrawingSceneService,
    // Engines
    ProposalEngineService,
    WorkspaceGraphService,
  ],
  exports: [
    DrawingSceneService,
    DrawingSearchService,
    DrawingDetectService,
    DrawingGraphService,
    ProposalEngineService,
    WorkspaceGraphService,
  ],
})
export class DrawingModule {}
