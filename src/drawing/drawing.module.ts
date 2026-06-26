import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DrawingController } from './drawing.controller';
// Upload
import { DrawingUploadService } from './services/drawing-upload.service';
// Parser
import { DrawingParserService } from './services/drawing-parser.service';
import { PdfParserService } from './parsers/pdf-parser.service';
import { DxfParserService } from './parsers/dxf-parser.service';
// Converter
import { DwgConverterService } from './converters/dwg-converter.service';
// Search
import { DrawingSearchService } from './services/drawing-search.service';
// Detect
import { DrawingDetectService } from './services/drawing-detect.service';
// Compare
import { DrawingCompareService } from './services/drawing-compare.service';
// Graph
import { DrawingGraphService } from './services/drawing-graph.service';
// Annotation
import { DrawingAnnotationService } from './services/drawing-annotation.service';
// Revision
import { DrawingRevisionService } from './services/drawing-revision.service';
// Thumbnail
import { DrawingThumbnailService } from './services/drawing-thumbnail.service';
// Cache
import { DrawingCacheService } from './services/drawing-cache.service';
// Schemas
import { Drawing, DrawingSchema } from './schemas/drawing.schema';
import { DrawingObject, DrawingObjectSchema } from './schemas/drawing-object.schema';
import { DrawingRelationship, DrawingRelationshipSchema } from './schemas/drawing-relationship.schema';
import { DrawingRevision, DrawingRevisionSchema } from './schemas/drawing-revision.schema';
import { DrawingIndex, DrawingIndexSchema } from './schemas/drawing-index.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Drawing.name,             schema: DrawingSchema },
      { name: DrawingObject.name,       schema: DrawingObjectSchema },
      { name: DrawingRelationship.name, schema: DrawingRelationshipSchema },
      { name: DrawingRevision.name,     schema: DrawingRevisionSchema },
      { name: DrawingIndex.name,        schema: DrawingIndexSchema },
    ]),
  ],
  controllers: [DrawingController],
  providers: [
    DrawingUploadService,
    DrawingParserService,
    PdfParserService,
    DxfParserService,
    DwgConverterService,
    DrawingSearchService,
    DrawingDetectService,
    DrawingCompareService,
    DrawingGraphService,
    DrawingAnnotationService,
    DrawingRevisionService,
    DrawingThumbnailService,
    DrawingCacheService,
  ],
  exports: [
    DrawingSearchService,
    DrawingDetectService,
    DrawingGraphService,
  ],
})
export class DrawingModule {}
