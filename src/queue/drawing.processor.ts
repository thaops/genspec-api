import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { DRAWING_QUEUE, DrawingJobData, DrawingJobProgress } from './drawing.queue';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { DrawingIndex, DrawingIndexDocument } from '../drawing/schemas/drawing-index.schema';
import { DrawingNormalizerService } from '../drawing/services/drawing-normalizer.service';
import { DrawingDetectorService } from '../drawing/services/drawing-detector.service';
import { DrawingLayerRuleService } from '../drawing/services/drawing-layer-rule.service';
import { DrawingObjectOverrideService } from '../drawing/services/drawing-object-override.service';
import { DrawingIndexerService } from '../drawing/services/drawing-indexer.service';
import { DrawingGraphService } from '../drawing/services/drawing-graph.service';
import { DrawingParserFactory } from '../drawing/parsers/drawing-parser.factory';
import { DwgConverterService } from '../drawing/converters/dwg-converter.service';
import { CloudinaryService } from '../storage/cloudinary.service';
import { DrawingSceneService } from '../drawing/services/drawing-scene.service';

@Processor(DRAWING_QUEUE, { concurrency: 2 })
export class DrawingJobProcessor extends WorkerHost {
  private readonly logger = new Logger(DrawingJobProcessor.name);

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    @InjectModel(DrawingIndex.name) private indexModel: Model<DrawingIndexDocument>,
    private readonly parserFactory: DrawingParserFactory,
    private readonly normalizer: DrawingNormalizerService,
    private readonly detector: DrawingDetectorService,
    private readonly layerRules: DrawingLayerRuleService,
    private readonly objectOverrides: DrawingObjectOverrideService,
    private readonly indexer: DrawingIndexerService,
    private readonly graph: DrawingGraphService,
    private readonly dwgConverter: DwgConverterService,
    private readonly cloudinary: CloudinaryService,
    private readonly scene: DrawingSceneService,
  ) {
    super();
  }

  async process(job: Job<DrawingJobData>): Promise<void> {
    const { drawingId, estimateId, fileType, storageUrl, tmpPath } = job.data;
    this.logger.log(`Processing drawing ${drawingId} [${fileType}]`);

    try {
      // Leave 'pending' immediately so the UI reflects work-in-progress during the
      // download/convert phase (which precedes the later 'parsing' status).
      await this.setStatus(drawingId, 'parsing');
      // 1. Get file on disk (use existing tmp or download from Cloudinary)
      await this.progress(job, 'downloading', 'Đang tải file...', 5);
      const filePath = await this.ensureLocalFile(drawingId, storageUrl, tmpPath);

      // 2. Convert DWG → DXF if needed
      let parsePath = filePath;
      let parseExt  = fileType === 'image' ? 'image' : fileType;

      if (fileType === 'dwg') {
        await this.progress(job, 'converting', 'Đang chuyển đổi DWG → DXF...', 15);
        try {
          const dxfPath = await this.dwgConverter.convert(filePath);
          parsePath = dxfPath;
          parseExt  = 'dxf';
          // Persist converted DXF durably so scenes can be rebuilt later
          let convertedUrl = dxfPath;
          try {
            const up = await this.cloudinary.uploadBuffer(fs.readFileSync(dxfPath), {
              folder: `genspec/drawings/${estimateId}/converted`,
              fileName: `${drawingId}.dxf`,
            });
            convertedUrl = up.url;
          } catch (upErr: any) {
            this.logger.warn(`Converted DXF upload failed, keeping local path: ${upErr.message}`);
          }
          await this.drawingModel.updateOne({ _id: drawingId }, { convertedUrl });
        } catch (err: any) {
          // ODA not installed — mark failed with helpful message
          await this.setStatus(drawingId, 'failed',
            `DWG converter không khả dụng: ${err.message}. Vui lòng upload file DXF.`);
          return;
        }
      }

      // 3. Parse
      await this.progress(job, 'parsing', 'Đang đọc bản vẽ...', 30);
      await this.setStatus(drawingId, 'parsing');
      const parser = this.parserFactory.resolve(parseExt);
      const result = await parser.parse(parsePath);

      // 3b. Build render scene (DXF geometry — includes converted DWG)
      if (parseExt === 'dxf') {
        await this.scene.buildAndPersistFromDxfFile(drawingId, parsePath);
      }

      // 4. Normalize + Detect
      await this.progress(job, 'detecting', 'Đang phân tích đối tượng...', 55);
      const raw       = this.normalizer.fromPages(drawingId, result.pages);
      const overrides = await this.layerRules.list(estimateId);
      const detected  = this.detector.detect(raw, overrides);
      const userOverrides = await this.objectOverrides.map(drawingId);

      await this.objectModel.deleteMany({ drawingId });
      // Batch insert: on dense drawings one giant BSON array is a real OOM source.
      const CHUNK = 2000;
      for (let i = 0; i < detected.length; i += CHUNK) {
        const docs = detected.slice(i, i + CHUNK).map((o) => {
          const forced = userOverrides.get(o.stableId); // Tier 4 — user correction wins
          return {
            drawingId, stableId: o.stableId, rawType: o.rawType,
            type: forced ?? o.objectType, layer: o.layer,
            boundingBox: o.boundingBox, geometry: o.geometry,
            confidence: forced ? 1 : o.confidence,
            detectionReason: forced ? 'Người dùng sửa (Tier 4)' : o.detection?.reason,
            candidates: forced ? [{ type: forced, prob: 1 }] : o.detection?.candidates,
            ambiguous: forced ? false : o.detection?.ambiguous,
            properties: o.properties, floor: o.floor,
          };
        });
        await this.objectModel.insertMany(docs, { ordered: false });
      }

      // 5. Index
      await this.progress(job, 'indexing', 'Đang tạo search index...', 75);
      await this.indexer.buildIndex(drawingId, detected, result.layers, result.pages);

      // 6. Graph
      await this.progress(job, 'graph', 'Đang xây dựng relationship graph...', 90);
      await this.graph.build(drawingId);

      // 7. Done
      await this.setStatus(drawingId, 'ready');
      await this.drawingModel.updateOne(
        { _id: drawingId },
        { pageCount: result.pages.length, parseStatus: 'ready' },
      );
      await this.progress(job, 'ready', 'Bản vẽ sẵn sàng', 100);
      this.logger.log(`Drawing ${drawingId} ready — ${detected.length} objects`);
    } catch (err: any) {
      this.logger.error(`Drawing ${drawingId} failed: ${err.message}`);
      await this.setStatus(drawingId, 'failed', err.message);
      throw err; // let BullMQ handle retry
    } finally {
      // Clean up tmp file
      try {
        const tmpDir = path.join('/tmp', 'uploads', job.data.estimateId);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  private async progress(
    job: Job,
    step: DrawingJobProgress['step'],
    message: string,
    percent: number,
  ) {
    await job.updateProgress({ step, message, percent } satisfies DrawingJobProgress);
  }

  private async setStatus(drawingId: string, status: string, error?: string) {
    await this.drawingModel.updateOne(
      { _id: drawingId },
      { parseStatus: status, ...(error ? { parseError: error } : {}) },
    );
  }

  /** Ensure the file is on local disk. Uses signed Cloudinary download if tmp is gone. */
  private async ensureLocalFile(
    drawingId: string,
    url: string,
    tmpPath?: string,
  ): Promise<string> {
    if (tmpPath && fs.existsSync(tmpPath)) return tmpPath;

    const ext  = url.split('?')[0].split('.').pop() ?? 'bin';
    const dir  = path.join('/tmp', 'uploads', drawingId);
    const dest = path.join(dir, `file.${ext}`);
    fs.mkdirSync(dir, { recursive: true });

    // Use CloudinaryService for authenticated download (handles signed URLs)
    const buffer = await this.cloudinary.downloadBuffer(url);
    if (buffer.length === 0) throw new Error(`Downloaded empty file from ${url}`);
    fs.writeFileSync(dest, buffer);
    return dest;
  }
}
