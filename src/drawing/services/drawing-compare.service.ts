import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingRevisionService } from './drawing-revision.service';

@Injectable()
export class DrawingCompareService {
  constructor(
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly revision: DrawingRevisionService,
    private readonly events: EventEmitter2,
  ) {}

  async compare(estimateId: string, drawingIdA: string, drawingIdB: string) {
    const [objectsA, objectsB] = await Promise.all([
      this.objectModel.find({ drawingId: drawingIdA }).lean() as unknown as DrawingObjectDocument[],
      this.objectModel.find({ drawingId: drawingIdB }).lean() as unknown as DrawingObjectDocument[],
    ]);
    return this.revision.diff(drawingIdA, estimateId, objectsA, objectsB);
  }
}
