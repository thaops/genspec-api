import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DrawingAnnotation, DrawingAnnotationDocument } from '../schemas/drawing-annotation.schema';

@Injectable()
export class DrawingAnnotationService {
  constructor(
    @InjectModel(DrawingAnnotation.name)
    private annotationModel: Model<DrawingAnnotationDocument>,
  ) {}

  list(drawingId: string) {
    return this.annotationModel.find({ drawingId }).sort({ createdAt: -1 }).lean();
  }

  add(drawingId: string, body: { pageNumber: number; text: string; objectId?: string; markupId?: string }) {
    return this.annotationModel.create({
      drawingId,
      pageNumber: body.pageNumber,
      text: body.text,
      objectId: body.objectId,
      markupId: body.markupId,
    });
  }
}
