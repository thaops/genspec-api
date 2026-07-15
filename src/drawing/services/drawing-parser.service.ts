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
import { inferUnitFactor } from './drawing-unit';
import {
  DrawingUploadedEvent,
  DrawingConvertedEvent,
  DrawingParsedEvent,
  DrawingDetectedEvent,
} from '../../events/domain-events';
import { CloudinaryService } from '../../storage/cloudinary.service';
import { DrawingSceneService } from './drawing-scene.service';
import { DwgConverterService } from '../converters/dwg-converter.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    private readonly scene: DrawingSceneService,
    private readonly dwgConverter: DwgConverterService,
  ) {}

  @OnEvent(DrawingConvertedEvent.EVENT)
  async onConverted(event: DrawingConvertedEvent) {
    await this.log(event.drawingId, `[converted] DWG → DXF: ${event.dxfPath}`);
    await this.drawingModel.updateOne(
      { _id: event.drawingId },
      { convertedUrl: event.dxfPath, parseStatus: 'parsing' },
    );
    await this.runPipeline(event.drawingId, event.dxfPath, 'dxf');
  }

  @OnEvent(DrawingUploadedEvent.EVENT)
  async onUploaded(event: DrawingUploadedEvent) {
    await this.log(event.drawingId, `[upload] type=${event.fileType}, storagePath=${event.storagePath}`);
    let filePath = event.storagePath;
    try {
      filePath = await this.resolveStoragePath(event.storagePath);
      await this.log(event.drawingId, `[storage] resolved to ${filePath}`);
      await this.runPipeline(event.drawingId, filePath, event.fileType);
    } catch (err: any) {
      await this.log(event.drawingId, `[error] onUploaded: ${err.message}`);
      await this.setStatus(event.drawingId, 'failed', err.message);
    } finally {
      this.cleanupTmp(filePath);
    }
  }

  private async runPipeline(drawingId: string, filePath: string, ext: string) {
    await this.log(drawingId, `[pipeline] start ext=${ext}, file=${path.basename(filePath)}`);

    // GUARD kích thước — runPipeline() CHỈ chạy ở đường IN-PROCESS (EventEmitter,
    // không Redis). Đường này parse ngay trong process API nên DWG lớn (KC 26MB) OOM
    // sẽ SẬP CẢ API cho mọi user → LUÔN áp cap ở đây. File lớn CẦN đi qua worker
    // (BullMQ DrawingJobProcessor, có guard 250MB riêng) → bật REDIS_URL để upload
    // tự enqueue vào worker thay vì rơi vào đây. Ngưỡng chỉnh qua env MAX_DRAWING_MB.
    try {
      const bytes = fs.statSync(filePath).size;
      const maxMb = Number(process.env.MAX_DRAWING_MB ?? 22);
      if (bytes > maxMb * 1024 * 1024) {
        const mb = (bytes / (1024 * 1024)).toFixed(1);
        await this.log(drawingId, `[guard] in-process, file ${mb}MB > ${maxMb}MB → skip (tránh OOM sập API)`);
        await this.setStatus(
          drawingId,
          'failed',
          `Bản vẽ ${mb}MB vượt ngưỡng xử lý tại chỗ (${maxMb}MB). ` +
            `File lớn cần chạy qua worker riêng (bật REDIS_URL để upload vào hàng đợi), hoặc tạm tách WBLOCK phần cần bóc rồi upload lại.`,
        );
        return;
      }
    } catch { /* statSync lỗi → cứ để pipeline thử */ }

    await this.setStatus(drawingId, 'parsing');

    try {
      // 1. Parse
      const parser = this.parserFactory.resolve(ext);
      await this.log(drawingId, `[parse] using parser: ${parser.constructor.name}`);
      const t0 = Date.now();
      // FALLBACK file lớn/phức tạp: WASM libredwg (nhanh) gãy trên bản KẾT CẤU 20MB+
      // ("memory access out of bounds") → chuyển sang converter native dwg2dxf/ODA →
      // parse DXF (parser DXF chịu được file lớn). Giữ WASM làm đường CHÍNH (nhanh).
      let result: Awaited<ReturnType<typeof parser.parse>>;
      let dxfFallbackPath: string | null = null;
      try {
        result = await parser.parse(filePath);
      } catch (parseErr: any) {
        if (ext !== 'dwg') throw parseErr;
        await this.log(drawingId, `[parse] WASM DWG fail: ${parseErr.message} → fallback converter dwg2dxf/ODA`);
        await this.setStatus(drawingId, 'converting');
        dxfFallbackPath = await this.dwgConverter.convert(filePath); // throw có hướng dẫn nếu không có backend
        await this.log(drawingId, `[convert] DWG→DXF ok: ${path.basename(dxfFallbackPath)}`);
        result = await this.parserFactory.resolve('dxf').parse(dxfFallbackPath);
        await this.setStatus(drawingId, 'parsing');
      }
      const parseMs = Date.now() - t0;
      await this.log(drawingId, `[parse] done in ${parseMs}ms — pages=${result.pages.length}, layers=${result.layers.length}, entities=${result.pages.reduce((s, p) => s + p.entities.length, 0)}, parserVersion=${result.parserVersion}${dxfFallbackPath ? ' (via DXF fallback)' : ''}`);

      // 1b. Build render scene (DXF geometry — includes converted DWG)
      if (ext === 'dxf' || dxfFallbackPath) {
        await this.scene.buildAndPersistFromDxfFile(drawingId, dxfFallbackPath ?? filePath);
        await this.log(drawingId, `[scene] built from DXF${dxfFallbackPath ? ' (fallback)' : ''} and persisted`);
      } else if (ext === 'dwg') {
        // Reuse the libredwg parse result — no second parse, no CLI converter
        await this.scene.buildAndPersistFromDwgResult(drawingId, result);
        await this.log(drawingId, `[scene] built from DWG parse result and persisted`);
      }

      // 2. Normalize
      const t1 = Date.now();
      const rawObjects = this.normalizer.fromPages(drawingId, result.pages);
      await this.log(drawingId, `[normalize] ${rawObjects.length} raw objects in ${Date.now() - t1}ms`);

      // 3. Detect — tỉ lệ từ header bật guard tiết diện KC (lớp 1). Không suy ra được
      // thì để undefined: engine vẫn chặn lúc đo (lớp 2), không đoán bừa tỉ lệ.
      const t2 = Date.now();
      const unitFactor = inferUnitFactor(result);
      await this.log(drawingId, `[units] unitFactor=${unitFactor ?? 'không suy ra được (bản vẽ thiếu $INSUNITS) → bỏ qua guard tiết diện ở detector'}`);
      const detected = this.detector.detect(rawObjects, [], unitFactor);
      await this.log(drawingId, `[detect] ${detected.length} detected objects in ${Date.now() - t2}ms`);

      // 4. Persist
      const t3 = Date.now();
      await this.persistObjects(drawingId, detected);
      await this.log(drawingId, `[persist] saved ${detected.length} objects in ${Date.now() - t3}ms`);

      // Sample log — type distribution + first 3 objects full structure
      const typeCounts: Record<string, number> = {};
      for (const d of detected) typeCounts[d.objectType] = (typeCounts[d.objectType] ?? 0) + 1;
      await this.log(drawingId, `[sample] type distribution: ${JSON.stringify(typeCounts)}`);
      const sample = detected.slice(0, 3).map(d => ({
        type: d.objectType, layer: d.layer, stableId: d.stableId,
        geometry: d.geometry, boundingBox: d.boundingBox, properties: d.properties,
      }));
      await this.log(drawingId, `[sample] first 3 objects: ${JSON.stringify(sample)}`);

      // 5. Index
      const t4 = Date.now();
      await this.indexer.buildIndex(drawingId, detected, result.layers, result.pages);
      await this.log(drawingId, `[index] built in ${Date.now() - t4}ms`);

      // 6. Done
      await this.drawingModel.updateOne(
        { _id: drawingId },
        { pageCount: result.pages.length, parseStatus: 'ready', unitFactor },
      );
      const total = Date.now() - t0;
      await this.log(drawingId, `[done] total=${total}ms — status=ready`);

      this.emitParsedAndDetected(drawingId, result.pages.length, result.layers.length, detected.length, '');
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.logger.error(`[Pipeline] drawingId=${drawingId} failed: ${msg}`);
      await this.log(drawingId, `[failed] ${msg}`);
      await this.setStatus(drawingId, 'failed', msg);
    }
  }

  private async persistObjects(drawingId: string, detected: ReturnType<DrawingDetectorService['detect']>) {
    await this.objectModel.deleteMany({ drawingId });
    if (detected.length === 0) return 0;

    const ops = detected.map((obj) => ({
      updateOne: {
        filter: { drawingId, stableId: obj.stableId },
        update: {
          $set: {
            drawingId,
            stableId:    obj.stableId,
            type:        obj.objectType,
            layer:       obj.layer,
            boundingBox: obj.boundingBox,
            geometry:    obj.geometry,
            confidence:  obj.confidence,
            properties:  obj.properties,
            floor:       obj.floor,
          },
        },
        upsert: true,
      },
    }));

    await this.objectModel.bulkWrite(ops, { ordered: false });
    return detected.length;
  }

  private emitParsedAndDetected(
    drawingId: string,
    pageCount: number,
    layerCount: number,
    objectCount: number,
    estimateId: string,
  ) {
    this.events.emit(DrawingParsedEvent.EVENT, new DrawingParsedEvent(drawingId, pageCount, layerCount, objectCount));
    this.events.emit(DrawingDetectedEvent.EVENT, new DrawingDetectedEvent(drawingId, estimateId, objectCount));
  }

  private async setStatus(drawingId: string, status: string, error?: string) {
    await this.drawingModel.updateOne(
      { _id: drawingId },
      {
        parseStatus: status,
        ...(error ? { parseError: error } : {}),
        // Mốc bắt đầu xử lý — FE tính "kẹt quá lâu" từ đây.
        ...(status === 'parsing' || status === 'converting' ? { parseStartedAt: new Date() } : {}),
      },
    );
  }

  /** Append a timestamped log line to drawing.parseLogs (capped at 100 entries). */
  private async log(drawingId: string, message: string) {
    const line = `${new Date().toISOString()} ${message}`;
    this.logger.log(`[DrawingPipeline:${drawingId}] ${message}`);
    await this.drawingModel.updateOne(
      { _id: drawingId },
      { $push: { parseLogs: { $each: [line], $slice: -100 } } },
    );
  }

  private async resolveStoragePath(storagePath: string): Promise<string> {
    if (!storagePath.startsWith('http')) return storagePath;
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
