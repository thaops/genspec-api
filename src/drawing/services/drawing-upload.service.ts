import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { CloudinaryService } from '../../storage/cloudinary.service';
import { DrawingUploadedEvent } from '../../events/domain-events';

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
  ) {}

  async upload(estimateId: string, file: Express.Multer.File) {
    const ext      = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const fileType = (['pdf', 'dwg', 'dxf'].includes(ext) ? ext : 'image') as 'pdf' | 'dwg' | 'dxf' | 'image';

    // 1. Save buffer to tmp (parser needs filesystem access)
    const tmpPath = this.saveTmp(estimateId, file);

    // 2. Upload to Cloudinary for durable storage
    let storageUrl = tmpPath;
    try {
      const result = await this.cloudinary.uploadBuffer(file.buffer, {
        folder: `genspec/drawings/${estimateId}`,
        fileName: `${Date.now()}_${file.originalname}`,
      });
      storageUrl = result.url;
    } catch (err: any) {
      this.logger.warn(`Cloudinary unavailable, using tmp: ${err.message}`);
    }

    // 3. Create drawing record
    const drawing = await this.drawingModel.create({
      estimateId,
      name: file.originalname,
      type: fileType,
      url: storageUrl,
      parseStatus: 'pending',
      uploadedBy: 'user',
    });

    const drawingId = (drawing as any)._id.toString();

    // 4. Try BullMQ queue; fall back to EventEmitter if Redis unavailable
    const jobId = await this.tryEnqueue(drawingId, estimateId, fileType, storageUrl, tmpPath);

    return { ...drawing.toObject(), id: drawingId, ...(jobId ? { jobId } : {}) };
  }

  async list(estimateId: string): Promise<DrawingDocument[]> {
    return this.drawingModel
      .find({ estimateId })
      .sort({ createdAt: -1 })
      .lean()
      .exec() as unknown as DrawingDocument[];
  }

  async getWithObjects(estimateId: string, drawingId: string) {
    const drawing = await this.drawingModel.findOne({ _id: drawingId, estimateId }).lean();
    if (!drawing) throw new NotFoundException('Drawing not found');
    const objects = await this.objectModel.find({ drawingId }).lean();
    return { ...drawing, id: (drawing as any)._id, objects };
  }

  async delete(estimateId: string, drawingId: string): Promise<{ ok: true }> {
    const result = await this.drawingModel.deleteOne({ _id: drawingId, estimateId });
    if (result.deletedCount === 0) throw new NotFoundException('Drawing not found');
    await this.objectModel.deleteMany({ drawingId });
    return { ok: true };
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

    // EventEmitter fallback — synchronous pipeline
    this.logger.log(`Drawing ${drawingId} → EventEmitter fallback`);
    await this.drawingModel.updateOne({ _id: drawingId }, { parseStatus: 'parsing' });
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

  private saveTmp(estimateId: string, file: Express.Multer.File): string {
    const dir = path.join('/tmp', 'uploads', estimateId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, file.originalname);
    fs.writeFileSync(filePath, file.buffer);
    return filePath;
  }
}
