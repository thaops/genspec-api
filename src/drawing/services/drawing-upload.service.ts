import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingUploadedEvent } from '../../events/domain-events';
import { CloudinaryService } from '../../storage/cloudinary.service';

@Injectable()
export class DrawingUploadService {
  private readonly logger = new Logger(DrawingUploadService.name);

  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly events: EventEmitter2,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async upload(estimateId: string, file: Express.Multer.File): Promise<DrawingDocument> {
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const fileType = (['pdf', 'dwg', 'dxf'].includes(ext) ? ext : 'image') as 'pdf' | 'dwg' | 'dxf' | 'image';

    // 1. Save to tmp for the parser pipeline (needs filesystem access)
    const tmpPath = this.saveTmp(estimateId, file);

    // 2. Upload to Cloudinary for permanent accessible URL
    let url = tmpPath;
    try {
      const result = await this.cloudinary.uploadBuffer(file.buffer, {
        folder: `genspec/drawings/${estimateId}`,
        fileName: file.originalname,
      });
      url = result.url;
    } catch (err: any) {
      this.logger.warn(`Cloudinary upload failed, using tmp path: ${err.message}`);
    }

    const drawing = await this.drawingModel.create({
      estimateId,
      name: file.originalname,
      type: fileType,
      url,
      parseStatus: fileType === 'dwg' ? 'converting' : 'parsing',
      uploadedBy: 'user',
    });

    this.events.emit(
      DrawingUploadedEvent.EVENT,
      new DrawingUploadedEvent(
        (drawing as any)._id.toString(),
        estimateId,
        fileType,
        tmpPath, // parser reads from local tmp, not Cloudinary
        'user',
      ),
    );

    return drawing;
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
