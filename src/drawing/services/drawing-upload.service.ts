import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { CloudinaryService } from '../../storage/cloudinary.service';
import { DRAWING_QUEUE, DrawingJobData } from '../../queue/drawing.queue';

@Injectable()
export class DrawingUploadService {
  private readonly logger = new Logger(DrawingUploadService.name);

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    @InjectQueue(DRAWING_QUEUE) private drawingQueue: Queue,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async upload(estimateId: string, file: Express.Multer.File) {
    const ext      = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const fileType = (['pdf', 'dwg', 'dxf'].includes(ext) ? ext : 'image') as DrawingJobData['fileType'];

    // 1. Save to tmp for fast queueing (worker may also use this path)
    const tmpPath = this.saveTmp(estimateId, file);

    // 2. Upload to Cloudinary for durable storage (worker downloads from here if tmp is gone)
    let storageUrl = tmpPath;
    try {
      const result = await this.cloudinary.uploadBuffer(file.buffer, {
        folder: `genspec/drawings/${estimateId}`,
        fileName: `${Date.now()}_${file.originalname}`,
      });
      storageUrl = result.url;
      this.logger.log(`Uploaded to Cloudinary: ${storageUrl}`);
    } catch (err: any) {
      this.logger.warn(`Cloudinary unavailable, using tmp: ${err.message}`);
    }

    // 3. Create drawing record immediately (status: queued)
    const drawing = await this.drawingModel.create({
      estimateId,
      name: file.originalname,
      type: fileType,
      url: storageUrl,
      parseStatus: 'queued',
      uploadedBy: 'user',
    });

    const drawingId = (drawing as any)._id.toString();

    // 4. Add to BullMQ queue — return immediately, worker does the heavy lifting
    const job = await this.drawingQueue.add(
      'process',
      {
        drawingId,
        estimateId,
        fileType,
        storageUrl,
        tmpPath,
      } satisfies DrawingJobData,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400 },  // keep 24h for status polling
        removeOnFail: { age: 7 * 86400 },
      },
    );

    this.logger.log(`Drawing ${drawingId} queued as job ${job.id}`);

    // Return drawing + jobId so FE can track status
    return { ...drawing.toObject(), id: drawingId, jobId: job.id };
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

  private saveTmp(estimateId: string, file: Express.Multer.File): string {
    const dir = path.join('/tmp', 'uploads', estimateId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, file.originalname);
    fs.writeFileSync(filePath, file.buffer);
    return filePath;
  }
}
