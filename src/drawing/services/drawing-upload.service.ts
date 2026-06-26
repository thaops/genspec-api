import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingUploadedEvent } from '../../events/domain-events';

@Injectable()
export class DrawingUploadService {
  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly events: EventEmitter2,
  ) {}

  async upload(estimateId: string, file: Express.Multer.File): Promise<DrawingDocument> {
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const fileType = (['pdf', 'dwg', 'dxf'].includes(ext) ? ext : 'image') as Drawing['type'];

    // TODO: upload file to storage (S3 / Railway volumes) and get url
    const url = `/uploads/${estimateId}/${file.originalname}`;

    const drawing = await this.drawingModel.create({
      estimateId,
      name: file.originalname,
      type: fileType,
      url,
      parseStatus: fileType === 'dwg' ? 'converting' : 'parsing',
      uploadedBy: 'user', // TODO: from auth context
    });

    // Emit domain event — parser, thumbnail, history all listen
    this.events.emit(
      DrawingUploadedEvent.EVENT,
      new DrawingUploadedEvent(
        (drawing as any)._id.toString(),
        estimateId,
        fileType,
        url,
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
}
