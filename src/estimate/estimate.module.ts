import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CopilotService } from './copilot.service';
import { EstimateController } from './estimate.controller';
import { Estimate, EstimateSchema } from './estimate.schema';
import { EstimateService } from './estimate.service';
import { ExportF1Service } from './export-f1.service';
import { ExportThdtService } from './export-thdt.service';
import { ContextBuilderService } from './context-builder.service';
import { ReadModeHandler } from './modes/read.handler';
import { ReviewModeHandler } from './modes/review.handler';
import { EditModeHandler } from './modes/edit.handler';
import { CitationEngineService } from './sources/citation-engine';
import { Drawing, DrawingSchema } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectSchema } from '../drawing/schemas/drawing-object.schema';
import { DrawingSceneEntity, DrawingSceneSchema } from '../drawing/schemas/drawing-scene.schema';
import { NormItem, NormItemSchema } from '../catalog/catalog-db.schemas';
import { NormWebLookupService, WebNormCache, WebNormCacheSchema } from './norm-web-lookup.service';
import { PriceWebLookupService, WebPriceCache, WebPriceCacheSchema } from './price-web-lookup.service';
import { RepriceService } from './reprice.service';
import { TakeoffEngineService } from './takeoff-engine.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Estimate.name, schema: EstimateSchema },
      { name: Drawing.name, schema: DrawingSchema },
      { name: DrawingObject.name, schema: DrawingObjectSchema },
      { name: DrawingSceneEntity.name, schema: DrawingSceneSchema },
      { name: NormItem.name, schema: NormItemSchema },
      { name: WebNormCache.name, schema: WebNormCacheSchema },
      { name: WebPriceCache.name, schema: WebPriceCacheSchema },
    ]),
    AiModule,
    CatalogModule,
  ],
  controllers: [EstimateController],
  providers: [
    EstimateService,
    CopilotService,
    ExportF1Service,
    ExportThdtService,
    ContextBuilderService,
    ReadModeHandler,
    ReviewModeHandler,
    EditModeHandler,
    CitationEngineService,
    NormWebLookupService,
    PriceWebLookupService,
    TakeoffEngineService,
    RepriceService,
  ],
  exports: [EstimateService],
})
export class EstimateModule {}
