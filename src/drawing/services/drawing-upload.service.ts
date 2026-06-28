import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { CloudinaryService } from '../../storage/cloudinary.service';
import { DrawingUploadedEvent } from '../../events/domain-events';
import { DwgConverterService } from '../converters/dwg-converter.service';

// Queue is optional — only injected when REDIS_URL is set
let Queue: typeof import('bullmq').Queue | undefined;
let InjectQueue: typeof import('@nestjs/bullmq').InjectQueue | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Queue = require('bullmq').Queue;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  InjectQueue = require('@nestjs/bullmq').InjectQueue;
} catch {}

@Injectable()
export class DrawingUploadService {
  private readonly logger = new Logger(DrawingUploadService.name);

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly events: EventEmitter2,
    private readonly cloudinary: CloudinaryService,
    private readonly dwgConverter: DwgConverterService,
  ) {}

  async upload(estimateId: string, file: Express.Multer.File) {
    const fileType = this.detectFileType(file.buffer, file.originalname);

    // 1. Save buffer to tmp (parser needs filesystem access)
    const tmpPath = this.saveTmp(estimateId, file);

    // 2. Upload to Cloudinary for durable storage
    let storageUrl = tmpPath;
    let cloudinaryPublicId: string | undefined;
    try {
      const result = await this.cloudinary.uploadBuffer(file.buffer, {
        folder: `genspec/drawings/${estimateId}`,
        fileName: `${Date.now()}_${file.originalname}`,
      });
      storageUrl = result.url;
      cloudinaryPublicId = result.publicId;
    } catch (err: any) {
      this.logger.warn(`Cloudinary unavailable, using tmp: ${err.message}`);
    }

    // 3. Create drawing record
    const drawing = await this.drawingModel.create({
      estimateId,
      name: file.originalname,
      type: fileType,
      url: storageUrl,
      cloudinaryPublicId,
      parseStatus: 'pending',
      uploadedBy: 'user',
    });

    const drawingId = (drawing as any)._id.toString();

    // 4. Try BullMQ queue; fall back to EventEmitter if Redis unavailable
    const jobId = await this.tryEnqueue(drawingId, estimateId, fileType, storageUrl, tmpPath);

    return { ...drawing.toObject(), id: drawingId, ...(jobId ? { jobId } : {}) };
  }

  async list(estimateId: string) {
    const docs = await this.drawingModel
      .find({ estimateId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return docs.map((d: any) => ({ ...d, id: d._id.toString() }));
  }

  async getWithObjects(estimateId: string, drawingId: string) {
    const drawing = await this.drawingModel.findOne({ _id: drawingId, estimateId }).lean();
    if (!drawing) throw new NotFoundException('Drawing not found');
    const objects = await this.objectModel.find({ drawingId }).lean();
    return { ...drawing, id: (drawing as any)._id.toString(), objects };
  }

  async delete(estimateId: string, drawingId: string): Promise<{ ok: true }> {
    const result = await this.drawingModel.deleteOne({ _id: drawingId, estimateId });
    if (result.deletedCount === 0) throw new NotFoundException('Drawing not found');
    await this.objectModel.deleteMany({ drawingId });
    return { ok: true };
  }

  /** Stream the raw file to client — uses signed Cloudinary URL or local tmp fallback. */
  async downloadFile(estimateId: string, drawingId: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const drawing = await this.drawingModel.findOne({ _id: drawingId, estimateId }).lean() as any;
    if (!drawing) throw new NotFoundException('Drawing not found');

    let buffer: Buffer;
    if (drawing.cloudinaryPublicId) {
      buffer = await this.cloudinary.downloadBuffer(drawing.url);
    } else if (!drawing.url.startsWith('http')) {
      // local tmp path (/tmp/... on Linux, C:\... on Windows)
      buffer = fs.readFileSync(drawing.url);
    } else {
      buffer = await this.cloudinary.downloadBuffer(drawing.url);
    }

    const ext = drawing.name.split('.').pop()?.toLowerCase() ?? 'pdf';
    const mimeType = ext === 'pdf' ? 'application/pdf'
      : ext === 'dxf' || ext === 'dwg' ? 'application/octet-stream'
      : 'application/octet-stream';

    return { buffer, mimeType, filename: drawing.name };
  }

  /** Returns jobId if enqueued, null if falling back to EventEmitter. Never throws. */
  private async tryEnqueue(
    drawingId: string,
    estimateId: string,
    fileType: 'pdf' | 'dwg' | 'dxf' | 'image',
    storageUrl: string,
    tmpPath: string,
  ): Promise<string | null> {
    const queue = this.getQueue();
    if (queue) {
      try {
        const job = await queue.add(
          'process',
          { drawingId, estimateId, fileType, storageUrl, tmpPath },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 7 * 86400 },
          },
        );
        this.logger.log(`Drawing ${drawingId} queued as job ${job.id}`);
        return job.id ?? null;
      } catch (err: any) {
        this.logger.warn(`Queue unavailable (${err.message}), falling back to EventEmitter`);
        this._queue = null; // reset so next upload retries
      }
    }

    // EventEmitter fallback — synchronous pipeline (no Redis)
    this.logger.log(`[DrawingUpload] No Redis queue — EventEmitter fallback for drawing ${drawingId} (type=${fileType})`);

    await this.drawingModel.updateOne({ _id: drawingId }, { parseStatus: 'parsing' });
    this.logger.log(`[DrawingUpload] Emitting DrawingUploadedEvent for drawing ${drawingId} (type=${fileType})`);
    this.events.emit(
      DrawingUploadedEvent.EVENT,
      new DrawingUploadedEvent(drawingId, estimateId, fileType, tmpPath, 'user'),
    );
    return null;
  }

  private _queue: any = undefined;

  private getQueue(): any {
    if (this._queue !== undefined) return this._queue;
    if (!process.env.REDIS_URL || !Queue) {
      this._queue = null;
      return null;
    }
    try {
      this._queue = new (Queue as any)('drawing', {
        connection: { url: process.env.REDIS_URL },
      });
    } catch {
      this._queue = null;
    }
    return this._queue;
  }

  /**
   * Detect file type by magic bytes first, fall back to extension.
   * DWG files always start with "AC10" regardless of filename.
   * Binary DXF and renamed files are caught this way.
   */
  private detectFileType(buffer: Buffer, originalname: string): 'pdf' | 'dwg' | 'dxf' | 'image' {
    // Magic byte detection
    if (buffer.length >= 6) {
      const magic = buffer.toString('ascii', 0, 6);
      if (magic.startsWith('AC10')) {
        this.logger.log(`[Upload] Magic bytes '${magic}' → type=dwg (overrides extension)`);
        return 'dwg';
      }
      if (magic.startsWith('%PDF')) return 'pdf';
    }
    // ASCII DXF check: first non-whitespace content should be group codes (digits)
    // Fall back to extension
    const ext = originalname.split('.').pop()?.toLowerCase() ?? '';
    const byExt = (['pdf', 'dwg', 'dxf'] as const).find((e) => e === ext) ?? 'image';
    this.logger.log(`[Upload] No magic match → type=${byExt} (from extension .${ext})`);
    return byExt;
  }

  private saveTmp(estimateId: string, file: Express.Multer.File): string {
    const dir = path.join('/tmp', 'uploads', estimateId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, file.originalname);
    fs.writeFileSync(filePath, file.buffer);
    return filePath;
  }
}
