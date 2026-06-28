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
import { CloudinaryService } from '../../storage/cloudinary.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    private readonly cloudinary: CloudinaryService,
  ) {}

  @OnEvent(DrawingConvertedEvent.EVENT)
  async onConverted(event: DrawingConvertedEvent) {
    this.logger.log(`[DrawingParser] onConverted: drawingId=${event.drawingId}, dxfPath=${event.dxfPath}`);
    await this.drawingModel.updateOne(
      { _id: event.drawingId },
      { convertedUrl: event.dxfPath, parseStatus: 'parsing' },
    );
    await this.runPipeline(event.drawingId, event.dxfPath, 'dxf');
  }

  @OnEvent(DrawingUploadedEvent.EVENT)
  async onUploaded(event: DrawingUploadedEvent) {
    this.logger.log(`[DrawingParser] onUploaded: drawingId=${event.drawingId}, type=${event.fileType}, path=${event.storagePath}`);
    const filePath = await this.resolveStoragePath(event.storagePath);
    this.logger.log(`[DrawingParser] Resolved file path: ${filePath}`);
    try {
      await this.runPipeline(event.drawingId, filePath, event.fileType);
    } finally {
      this.cleanupTmp(filePath);
    }
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

  private async resolveStoragePath(storagePath: string): Promise<string> {
    if (!storagePath.startsWith('http')) return storagePath;
    // Download remote file to a tmp path so the parser can read it from disk
    const buffer = await this.cloudinary.downloadBuffer(storagePath);
    const ext = storagePath.split('.').pop()?.split('?')[0] ?? 'bin';
    const tmpPath = path.join(os.tmpdir(), `drawing-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    return tmpPath;
  }

  private cleanupTmp(filePath: string) {
    const tmp = os.tmpdir().replace(/\\/g, '/');
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.startsWith(tmp) || normalized.startsWith('/tmp/')) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}
