import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingParserFactory } from '../parsers/drawing-parser.factory';
import { DrawingNormalizerService } from './drawing-normalizer.service';
import { DrawingDetectorService } from './drawing-detector.service';
import { DrawingIndexerService } from './drawing-indexer.service';
import {
  DrawingUploadedEvent,
  DrawingConvertedEvent,
  DrawingParsedEvent,
  DrawingDetectedEvent,
} from '../../events/domain-events';

/**
 * Object Detection Pipeline orchestrator.
 *
 * Event-driven flow:
 *   DrawingUploadedEvent  → parse PDF/DXF → normalize → detect → index
 *   DrawingConvertedEvent → parse converted DXF → normalize → detect → index
 *   DrawingDetectedEvent  → (GraphService listens) → build relationships
 *   DrawingGraphBuiltEvent → (KnowledgeGraphService listens) → update workspace graph
 */
@Injectable()
export class DrawingParserService {
  private readonly logger = new Logger(DrawingParserService.name);

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly parserFactory: DrawingParserFactory,
    private readonly normalizer: DrawingNormalizerService,
    private readonly detector: DrawingDetectorService,
    private readonly indexer: DrawingIndexerService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(DrawingConvertedEvent.EVENT)
  async onConverted(event: DrawingConvertedEvent) {
    await this.drawingModel.updateOne(
      { _id: event.drawingId },
      { convertedUrl: event.dxfPath, parseStatus: 'parsing' },
    );
    await this.runPipeline(event.drawingId, event.dxfPath, 'dxf');
  }

  @OnEvent(DrawingUploadedEvent.EVENT)
  async onUploaded(event: DrawingUploadedEvent) {
    if (event.fileType === 'dwg') return; // waits for DrawingConvertedEvent
    await this.runPipeline(
      event.drawingId,
      this.resolveStoragePath(event.storagePath),
      event.fileType,
    );
  }

  private async runPipeline(drawingId: string, filePath: string, ext: string) {
    this.logger.log(`Pipeline [${ext}]: ${drawingId}`);
    await this.setStatus(drawingId, 'parsing');
    try {
      const parser = this.parserFactory.resolve(ext);
      const result = await parser.parse(filePath);

      const rawObjects = this.normalizer.fromPages(drawingId, result.pages);
      const detected   = this.detector.detect(rawObjects);

      await this.persistObjects(drawingId, detected);
      await this.indexer.buildIndex(drawingId, detected, result.layers, result.pages);
      await this.drawingModel.updateOne(
        { _id: drawingId },
        { pageCount: result.pages.length, parseStatus: 'ready' },
      );

      this.emitParsedAndDetected(
        drawingId, result.pages.length, result.layers.length, detected.length, '',
      );
    } catch (err: any) {
      await this.setStatus(drawingId, 'failed', err.message);
    }
  }

  private async persistObjects(drawingId: string, detected: ReturnType<DrawingDetectorService['detect']>) {
    const docs = detected.map((obj) => ({
      drawingId,
      stableId:    obj.stableId,
      type:        obj.objectType,
      layer:       obj.layer,
      boundingBox: obj.boundingBox,
      geometry:    obj.geometry,
      confidence:  obj.confidence,
      properties:  obj.properties,
      floor:       obj.floor,
    }));
    await this.objectModel.deleteMany({ drawingId });
    if (docs.length > 0) await this.objectModel.insertMany(docs, { ordered: false });
    return docs.length;
  }

  private emitParsedAndDetected(
    drawingId: string,
    pageCount: number,
    layerCount: number,
    objectCount: number,
    estimateId: string,
  ) {
    this.events.emit(
      DrawingParsedEvent.EVENT,
      new DrawingParsedEvent(drawingId, pageCount, layerCount, objectCount),
    );
    this.events.emit(
      DrawingDetectedEvent.EVENT,
      new DrawingDetectedEvent(drawingId, estimateId, objectCount),
    );
  }

  private async setStatus(drawingId: string, status: string, error?: string) {
    await this.drawingModel.updateOne(
      { _id: drawingId },
      { parseStatus: status, ...(error ? { parseError: error } : {}) },
    );
  }

  private resolveStoragePath(storagePath: string): string {
    // TODO: download from object storage (Cloudinary/S3) to local tmp when needed
    return storagePath;
  }
}
