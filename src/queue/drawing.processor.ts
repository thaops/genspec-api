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
import { inferUnitFactor } from '../drawing/services/drawing-unit';
import { expandInsertEntities } from '../drawing/services/dwg-insert-expand';
import { DrawingGraphService } from '../drawing/services/drawing-graph.service';
import { DrawingParserFactory } from '../drawing/parsers/drawing-parser.factory';
import { DxfParserService } from '../drawing/parsers/dxf-parser.service';
import type { DrawingParseResult } from '../drawing/parsers/drawing-parser.interface';
import { DwgConverterService } from '../drawing/converters/dwg-converter.service';
import { CloudinaryService } from '../storage/cloudinary.service';
import { DrawingSceneService } from '../drawing/services/drawing-scene.service';

// A converted DXF larger than this almost certainly came from pathological block
// nesting; tokenizing it would OOM before the per-entity cap engages. Fail fast.
const MAX_PARSE_MB = 250;

function fileSizeMB(p: string): number {
  try { return Math.round((fs.statSync(p).size / 1_048_576) * 10) / 10; } catch { return -1; }
}

// concurrency 1: a single complex DWG can spike RAM near the container limit;
// running two heavy jobs at once doubles the peak and OOM-kills the whole process.
@Processor(DRAWING_QUEUE, { concurrency: 1 })
export class DrawingJobProcessor extends WorkerHost {
  private readonly logger = new Logger(DrawingJobProcessor.name);

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    @InjectModel(DrawingIndex.name) private indexModel: Model<DrawingIndexDocument>,
    private readonly parserFactory: DrawingParserFactory,
    private readonly dxfParser: DxfParserService,
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
      await this.plog(drawingId, `[start] type=${fileType}`);
      const filePath = await this.ensureLocalFile(drawingId, storageUrl, tmpPath);
      await this.plog(drawingId, `[downloaded] ${fileSizeMB(filePath)}MB`);

      // 2. Parse. DWG dùng WASM TRƯỚC (nhanh, KHÔNG cần binary native) — như đường
      // in-process. Chỉ file lớn/phức tạp mà WASM gãy mới cần converter dwg2dxf/ODA.
      let parsePath = filePath;
      let parseExt  = fileType === 'image' ? 'image' : fileType;
      let result: DrawingParseResult | null = null;

      if (fileType === 'dwg') {
        // WASM (libredwg-web) nạp CẢ file vào WASM heap + dựng object JS → RAM cao.
        // Với DWG LỚN, trên container RAM hạn chế nó OOM-KILL cả process (SIGKILL,
        // try/catch KHÔNG bắt được, BullMQ retry → crash-loop). Nên: file lớn BỎ QUA
        // WASM, đi thẳng converter native (dwg2dxf/ODA = subprocess, streaming, RAM thấp).
        const dwgMB = fileSizeMB(filePath);
        const maxWasmMb = Number(process.env.MAX_WASM_DWG_MB ?? 12);
        let needConvert = dwgMB > maxWasmMb;

        if (!needConvert) {
          await this.progress(job, 'parsing', 'Đang đọc bản vẽ (WASM)...', 25);
          try {
            result = await this.parserFactory.resolve('dwg').parse(filePath);
            await this.scene.buildAndPersistFromDwgResult(drawingId, result);
            await this.plog(drawingId, `[parsed:wasm] entities=${result.pages.reduce((s, p) => s + p.entities.length, 0)}`);
            parseExt = 'dwg-done';
          } catch (wasmErr: any) {
            await this.plog(drawingId, `[wasm-fail] ${wasmErr.message} → converter native`);
            needConvert = true;
          }
        } else {
          await this.plog(drawingId, `[skip-wasm] ${dwgMB}MB > ${maxWasmMb}MB → converter native trực tiếp (tránh OOM-kill)`);
        }

        if (needConvert) {
          await this.progress(job, 'converting', 'Chuyển đổi DWG→DXF...', 15);
          try {
            const dxfPath = await this.dwgConverter.convert(filePath);
            parsePath = dxfPath;
            parseExt  = 'dxf';
            await this.plog(drawingId, `[converted] DWG→DXF ${fileSizeMB(dxfPath)}MB`);
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
          } catch (convErr: any) {
            await this.setStatus(drawingId, 'failed',
              `Không xử lý được DWG lớn: converter native (dwg2dxf) chưa khả dụng — ${convErr.message}. ` +
              `Tạm thời: Save As sang .dxf trong AutoCAD rồi upload file .dxf.`);
            return;
          }
        }
      }

      // 3. Parse DXF/khác (bỏ qua nếu DWG đã parse xong bằng WASM). Guard MAX_PARSE_MB.
      if (parseExt !== 'dwg-done') {
        const parseMB = fileSizeMB(parsePath);
        if (parseMB > MAX_PARSE_MB) {
          await this.setStatus(drawingId, 'failed',
            `File quá lớn để xử lý (${parseMB}MB > ${MAX_PARSE_MB}MB) — bản vẽ có thể chứa block lồng bất thường. Hãy purge/audit trong CAD rồi upload lại.`);
          await this.plog(drawingId, `[abort] parse size ${parseMB}MB exceeds ${MAX_PARSE_MB}MB`);
          return;
        }
        await this.progress(job, 'parsing', 'Đang đọc bản vẽ...', 30);
        await this.plog(drawingId, `[parsing] ${parseExt} ${parseMB}MB…`);
        if (parseExt === 'dxf') {
          const doc = await this.dxfParser.parseFileStreaming(parsePath);
          result = this.dxfParser.docToResult(doc);
          await this.plog(drawingId, `[parsed] entities=${result.pages.reduce((s, p) => s + p.entities.length, 0)}`);
          await this.scene.buildAndPersistFromDxfDoc(drawingId, doc);
          await this.plog(drawingId, `[scene] built (reused doc)`);
        } else {
          result = await this.parserFactory.resolve(parseExt).parse(parsePath);
          await this.plog(drawingId, `[parsed] entities=${result.pages.reduce((s, p) => s + p.entities.length, 0)}`);
        }
      }
      if (!result) throw new Error('Parse không trả kết quả');

      // 3b. Expand block INSERT (cửa/cửa sổ/nội thất...) thành geometry THẬT —
      // chỉ đường WASM DWG trực tiếp thiếu bước này (DXF/converted đã expand lúc
      // parse). Thiếu → mọi INSERT chỉ có insertion point → bbox fallback 1×1 →
      // khối lượng SAI (xác nhận thật: 221 cửa "KT.dwg" đều 1×1).
      if (parseExt === 'dwg-done') {
        const blocks = (result.metadata?.blocks ?? {}) as Record<string, import('../drawing/parsers/dwg-parser.service').DwgBlockDef>;
        result = { ...result, pages: result.pages.map((p) => ({ ...p, entities: expandInsertEntities(p.entities, blocks) })) };
        await this.plog(drawingId, `[expand] block INSERT → geometry thật (${Object.keys(blocks).length} block def)`);
      }

      // 4. Normalize + Detect
      await this.progress(job, 'detecting', 'Đang phân tích đối tượng...', 55);
      const raw       = this.normalizer.fromPages(drawingId, result.pages);
      const overrides = await this.layerRules.list(estimateId);
      // Tỉ lệ từ header bật guard tiết diện KC (lớp 1); không suy ra được → undefined,
      // engine vẫn chặn lúc đo (lớp 2). Lưu lại để re-detect dùng cùng tỉ lệ.
      const unitFactor = inferUnitFactor(result);
      await this.drawingModel.updateOne({ _id: drawingId }, { unitFactor });
      await this.plog(drawingId, `[units] unitFactor=${unitFactor ?? 'không suy ra được (thiếu $INSUNITS) → bỏ qua guard tiết diện ở detector'}`);
      await this.plog(drawingId, `[detecting] ${raw.length} objects…`);
      const detected  = this.detector.detect(raw, overrides, unitFactor);
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
      await this.plog(drawingId, `[persisted] ${detected.length} objects`);

      // 5. Index
      await this.progress(job, 'indexing', 'Đang tạo search index...', 75);
      await this.indexer.buildIndex(drawingId, detected, result.layers, result.pages);
      await this.plog(drawingId, `[indexed]`);

      // 6. Graph
      await this.progress(job, 'graph', 'Đang xây dựng relationship graph...', 90);
      await this.graph.build(drawingId);
      await this.plog(drawingId, `[graph] built`);

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

  /**
   * Persist a stage marker to drawing.parseLogs. Awaited BEFORE each heavy
   * synchronous stage so the marker survives even if that stage OOM-kills the
   * process — the last line in parseLogs then pinpoints where it died.
   */
  private async plog(drawingId: string, message: string) {
    this.logger.log(`[proc:${drawingId}] ${message}`);
    try {
      await this.drawingModel.updateOne(
        { _id: drawingId },
        { $push: { parseLogs: { $each: [`${new Date().toISOString()} ${message}`], $slice: -100 } } },
      );
    } catch {}
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
