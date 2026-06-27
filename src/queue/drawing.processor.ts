import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { DRAWING_QUEUE, DrawingJobData, DrawingJobProgress } from './drawing.queue';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { DrawingIndex, DrawingIndexDocument } from '../drawing/schemas/drawing-index.schema';
import { DrawingNormalizerService } from '../drawing/services/drawing-normalizer.service';
import { DrawingDetectorService } from '../drawing/services/drawing-detector.service';
import { DrawingIndexerService } from '../drawing/services/drawing-indexer.service';
import { DrawingGraphService } from '../drawing/services/drawing-graph.service';
import { DrawingParserFactory } from '../drawing/parsers/drawing-parser.factory';
import { DwgConverterService } from '../drawing/converters/dwg-converter.service';

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
    private readonly indexer: DrawingIndexerService,
    private readonly graph: DrawingGraphService,
    private readonly dwgConverter: DwgConverterService,
  ) {
    super();
  }

  async process(job: Job<DrawingJobData>): Promise<void> {
    const { drawingId, estimateId, fileType, storageUrl, tmpPath } = job.data;
    this.logger.log(`Processing drawing ${drawingId} [${fileType}]`);

    try {
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
          await this.drawingModel.updateOne({ _id: drawingId }, { convertedUrl: dxfPath });
          parsePath = dxfPath;
          parseExt  = 'dxf';
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

      // 4. Normalize + Detect
      await this.progress(job, 'detecting', 'Đang phân tích đối tượng...', 55);
      const raw      = this.normalizer.fromPages(drawingId, result.pages);
      const detected = this.detector.detect(raw);

      await this.objectModel.deleteMany({ drawingId });
      if (detected.length) {
        await this.objectModel.insertMany(
          detected.map((o) => ({
            drawingId, stableId: o.stableId, rawType: o.rawType,
            type: o.objectType, layer: o.layer,
            boundingBox: o.boundingBox, geometry: o.geometry,
            confidence: o.confidence, properties: o.properties, floor: o.floor,
          })),
          { ordered: false },
        );
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

  /** Ensure the file is on local disk. Downloads from URL if tmp was lost. */
  private async ensureLocalFile(
    drawingId: string,
    url: string,
    tmpPath?: string,
  ): Promise<string> {
    if (tmpPath && fs.existsSync(tmpPath)) return tmpPath;

    // Download from Cloudinary / any https URL
    const ext  = url.split('?')[0].split('.').pop() ?? 'bin';
    const dir  = path.join('/tmp', 'uploads', drawingId);
    const dest = path.join(dir, `file.${ext}`);
    fs.mkdirSync(dir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(dest);
      client.get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    });

    return dest;
  }
}
