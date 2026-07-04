import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingSceneEntity, DrawingSceneDocument } from '../schemas/drawing-scene.schema';
import { DxfParserService, DxfDocument } from '../parsers/dxf-parser.service';
import { DwgParserService } from '../parsers/dwg-parser.service';
import { DrawingParseResult } from '../parsers/drawing-parser.interface';
import { adaptDwgToDxfDocument } from './dwg-scene-adapter';
import { SceneBuilderService, DrawingScene } from './scene-builder.service';
import { DwgConverterService } from '../converters/dwg-converter.service';
import { CloudinaryService } from '../../storage/cloudinary.service';

const MAX_GZ_BYTES = 15 * 1024 * 1024; // 15MB — above this, store a truncated scene
// Bump whenever adapter/builder output changes shape — stale scenes rebuild on next GET
const SCENE_BUILDER_VERSION = 2;
const FALLBACK_CAP = 20_000;           // entity cap used when full scene gz exceeds limit

@Injectable()
export class DrawingSceneService {
  private readonly logger = new Logger(DrawingSceneService.name);
  /** Per-drawing in-flight backfill lock — avoids duplicate on-demand builds. */
  private readonly inFlight = new Map<string, Promise<DrawingScene>>();

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingSceneEntity.name) private sceneModel: Model<DrawingSceneDocument>,
    private readonly dxfParser: DxfParserService,
    private readonly dwgParser: DwgParserService,
    private readonly builder: SceneBuilderService,
    private readonly dwgConverter: DwgConverterService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /** Build scene from a local DXF file and persist gzipped. Never throws (logs instead). */
  async buildAndPersistFromDxfFile(drawingId: string, dxfPath: string): Promise<void> {
    try {
      const content = fs.readFileSync(dxfPath, 'utf-8');
      await this.buildAndPersistFromContent(drawingId, content);
    } catch (err: any) {
      this.logger.warn(`[Scene] build failed for drawing ${drawingId}: ${err.message}`);
    }
  }

  /**
   * Build scene for a DWG from an ALREADY-PARSED libredwg result — used by the
   * upload pipeline right after DwgParserService.parse() so the file is not
   * parsed twice. Never throws (logs instead).
   */
  async buildAndPersistFromDwgResult(drawingId: string, result: DrawingParseResult): Promise<void> {
    try {
      const { doc, dropped } = adaptDwgToDxfDocument(result);
      if (Object.keys(dropped).length) {
        this.logger.log(`[Scene] dwg adapter dropped: ${JSON.stringify(dropped)}`);
      }
      await this.buildAndPersistFromDoc(drawingId, doc);
    } catch (err: any) {
      this.logger.warn(`[Scene] dwg scene build failed for drawing ${drawingId}: ${err.message}`);
    }
  }

  private async buildAndPersistFromContent(drawingId: string, dxfContent: string): Promise<DrawingScene> {
    const doc = this.dxfParser.parseContent(dxfContent);
    return this.buildAndPersistFromDoc(drawingId, doc);
  }

  private async buildAndPersistFromDoc(drawingId: string, doc: DxfDocument): Promise<DrawingScene> {
    let scene = this.builder.build(doc);
    let json = JSON.stringify(scene);
    let gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));

    if (gz.length > MAX_GZ_BYTES) {
      this.logger.warn(`[Scene] gz ${gz.length}B > 15MB for drawing ${drawingId} — storing truncated scene`);
      scene = this.builder.build(doc, FALLBACK_CAP);
      scene.truncated = true;
      json = JSON.stringify(scene);
      gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
    }

    await this.sceneModel.updateOne(
      { drawingId },
      { $set: { drawingId, gz, size: Buffer.byteLength(json), truncated: scene.truncated === true, builderVersion: SCENE_BUILDER_VERSION } },
      { upsert: true },
    );
    this.logger.log(`[Scene] persisted drawing ${drawingId}: ${scene.entities.length} entities, gz=${gz.length}B`);
    return scene;
  }

  /** GET scene: stored → decompress; missing → on-demand backfill for dxf/dwg; pdf/image → 404. */
  async getScene(estimateId: string, drawingId: string): Promise<DrawingScene> {
    const drawing = await this.drawingModel.findOne({ _id: drawingId, estimateId }).lean() as any;
    if (!drawing) throw new NotFoundException('Drawing not found');

    const stored = await this.sceneModel.findOne({ drawingId }).lean() as any;
    // Scenes built by an older adapter (giant insert markers, single-line
    // MTEXT, "[object Object]" texts) are rebuilt instead of served stale.
    const stale = stored && (stored.builderVersion ?? 0) < SCENE_BUILDER_VERSION
      && (drawing.type === 'dxf' || drawing.type === 'dwg');
    if (stored?.gz && !stale) {
      const buf = Buffer.isBuffer(stored.gz) ? stored.gz : Buffer.from(stored.gz.buffer ?? stored.gz);
      return JSON.parse(zlib.gunzipSync(buf).toString('utf-8'));
    }

    if (drawing.type === 'pdf' || drawing.type === 'image') {
      throw new NotFoundException('Bản vẽ PDF hiển thị trực tiếp');
    }
    if (drawing.type !== 'dxf' && drawing.type !== 'dwg') {
      throw new NotFoundException('Không có scene cho bản vẽ này');
    }

    // Backfill on demand — dedupe concurrent requests per drawing
    const existing = this.inFlight.get(drawingId);
    if (existing) return existing;

    const task = this.backfill(drawing, drawingId).finally(() => this.inFlight.delete(drawingId));
    this.inFlight.set(drawingId, task);
    return task;
  }

  private async backfill(drawing: any, drawingId: string): Promise<DrawingScene> {
    this.logger.log(`[Scene] backfill start for drawing ${drawingId} (type=${drawing.type})`);
    const tmpFiles: string[] = [];
    try {
      // Prefer already-converted DXF if it points to a durable URL
      let dxfPath: string | null = null;
      if (drawing.convertedUrl) {
        dxfPath = await this.materialize(drawing.convertedUrl, 'dxf', tmpFiles);
      }

      if (!dxfPath) {
        const srcPath = await this.materialize(drawing.url, drawing.type, tmpFiles);
        if (!srcPath) throw new NotFoundException('Không tìm thấy file gốc của bản vẽ');
        if (drawing.type === 'dwg') {
          // Primary: libredwg WASM parse (no CLI dependency — works on Railway)
          try {
            const result = await this.dwgParser.parse(srcPath);
            const { doc, dropped } = adaptDwgToDxfDocument(result);
            if (Object.keys(dropped).length) {
              this.logger.log(`[Scene] dwg adapter dropped: ${JSON.stringify(dropped)}`);
            }
            return await this.buildAndPersistFromDoc(drawingId, doc);
          } catch (wasmErr: any) {
            this.logger.warn(`[Scene] WASM dwg parse failed (${wasmErr.message}) — trying CLI converter`);
          }
          // Fallback: CLI converter (ODA/dwg2dxf) if installed
          try {
            dxfPath = await this.dwgConverter.convert(srcPath);
            tmpFiles.push(dxfPath);
          } catch (err: any) {
            throw new NotFoundException(`Không thể tạo scene từ DWG: ${err.message}`);
          }
        } else {
          dxfPath = srcPath;
        }
      }

      const content = fs.readFileSync(dxfPath, 'utf-8');
      const scene = await this.buildAndPersistFromContent(drawingId, content);
      return scene;
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      this.logger.warn(`[Scene] backfill failed for drawing ${drawingId}: ${err.message}`);
      throw new NotFoundException(`Không thể tạo scene: ${err.message}`);
    } finally {
      for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
    }
  }

  /** Get a local path for a stored file (download if remote). Returns null if unavailable. */
  private async materialize(location: string, ext: string, tmpFiles: string[]): Promise<string | null> {
    try {
      if (!location.startsWith('http')) {
        return fs.existsSync(location) ? location : null;
      }
      const buffer = await this.cloudinary.downloadBuffer(location);
      if (!buffer.length) return null;
      const tmpPath = path.join(os.tmpdir(), `scene-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
      fs.writeFileSync(tmpPath, buffer);
      tmpFiles.push(tmpPath);
      return tmpPath;
    } catch (err: any) {
      this.logger.warn(`[Scene] materialize failed (${location}): ${err.message}`);
      return null;
    }
  }
}
