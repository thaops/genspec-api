import {
  Controller, Get, Post, Delete, Param, UploadedFile,
  UseInterceptors, Body, Query, Res, InternalServerErrorException, NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { DrawingUploadService } from './services/drawing-upload.service';
import { DrawingSearchService } from './services/drawing-search.service';
import { DrawingDetectService } from './services/drawing-detect.service';
import { DrawingCompareService } from './services/drawing-compare.service';
import { DrawingRevisionService } from './services/drawing-revision.service';
import { DrawingAnnotationService } from './services/drawing-annotation.service';
import { DrawingGraphService } from './services/drawing-graph.service';

@Controller('estimates/:estimateId/drawings')
export class DrawingController {
  constructor(
    private readonly upload: DrawingUploadService,
    private readonly search: DrawingSearchService,
    private readonly detect: DrawingDetectService,
    private readonly compare: DrawingCompareService,
    private readonly revision: DrawingRevisionService,
    private readonly annotation: DrawingAnnotationService,
    private readonly graph: DrawingGraphService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  uploadDrawing(
    @Param('estimateId') estimateId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.upload.upload(estimateId, file);
  }

  @Get()
  listDrawings(@Param('estimateId') estimateId: string) {
    return this.upload.list(estimateId);
  }

  @Get(':drawingId')
  getDrawing(
    @Param('estimateId') estimateId: string,
    @Param('drawingId') drawingId: string,
  ) {
    return this.upload.getWithObjects(estimateId, drawingId);
  }

  @Get(':drawingId/file')
  async downloadFile(
    @Param('estimateId') estimateId: string,
    @Param('drawingId') drawingId: string,
    @Res() res: Response,
  ) {
    try {
      const { buffer, mimeType, filename } = await this.upload.downloadFile(estimateId, drawingId);
      res.set({
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException(`Không thể tải file: ${err.message}`);
    }
  }

  @Delete(':drawingId')
  deleteDrawing(
    @Param('estimateId') estimateId: string,
    @Param('drawingId') drawingId: string,
  ) {
    return this.upload.delete(estimateId, drawingId);
  }

  // --- Search ---
  @Get(':drawingId/search')
  searchDrawing(
    @Param('drawingId') drawingId: string,
    @Query('q') query: string,
  ) {
    return this.search.search(drawingId, query);
  }

  // --- Detect objects ---
  @Post(':drawingId/detect')
  detectObjects(
    @Param('estimateId') estimateId: string,
    @Param('drawingId') drawingId: string,
  ) {
    return this.detect.detect(estimateId, drawingId);
  }

  // --- Graph ---
  @Get(':drawingId/graph')
  getGraph(@Param('drawingId') drawingId: string) {
    return this.graph.getGraph(drawingId);
  }

  @Post(':drawingId/graph/build')
  buildGraph(@Param('drawingId') drawingId: string) {
    return this.graph.build(drawingId);
  }

  // --- Revisions ---
  @Get(':drawingId/revisions')
  listRevisions(@Param('drawingId') drawingId: string) {
    return this.revision.list(drawingId);
  }

  @Post(':drawingId/revisions')
  @UseInterceptors(FileInterceptor('file'))
  uploadRevision(
    @Param('estimateId') estimateId: string,
    @Param('drawingId') drawingId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('label') label?: string,
  ) {
    return this.revision.upload(estimateId, drawingId, file, label);
  }

  // --- Compare ---
  @Post('compare')
  compareRevisions(
    @Param('estimateId') estimateId: string,
    @Body() body: { drawingIdA: string; drawingIdB: string },
  ) {
    return this.compare.compare(estimateId, body.drawingIdA, body.drawingIdB);
  }

  // --- Annotations ---
  @Get(':drawingId/annotations')
  listAnnotations(@Param('drawingId') drawingId: string) {
    return this.annotation.list(drawingId);
  }

  @Post(':drawingId/annotations')
  addAnnotation(
    @Param('drawingId') drawingId: string,
    @Body() body: { pageNumber: number; text: string; objectId?: string; markupId?: string },
  ) {
    return this.annotation.add(drawingId, body);
  }
}
