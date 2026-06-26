import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingDetectorService } from './drawing-detector.service';
import { DrawingNormalizerService } from './drawing-normalizer.service';

@Injectable()
export class DrawingDetectService {
  constructor(
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly normalizer: DrawingNormalizerService,
    private readonly detector: DrawingDetectorService,
  ) {}

  async detect(estimateId: string, drawingId: string) {
    const existing = await this.objectModel.find({ drawingId }).lean();
    if (!existing.length) return { drawingId, objectCount: 0, message: 'No objects to re-detect' };

    // Re-run detection on existing normalized objects
    const normalized = existing.map((o) => ({
      stableId: o.stableId,
      rawType: o.type,
      layer: o.layer,
      boundingBox: o.boundingBox,
      geometry: o.geometry ?? [],
      properties: o.properties ?? {},
      floor: o.floor,
    }));

    const detected = this.detector.detect(normalized as any);

    await this.objectModel.deleteMany({ drawingId });
    if (detected.length) {
      const docs = detected.map((obj) => ({
        drawingId,
        stableId: obj.stableId,
        rawType: obj.rawType,
        type: obj.objectType,
        layer: obj.layer,
        boundingBox: obj.boundingBox,
        geometry: obj.geometry,
        confidence: obj.confidence,
        properties: obj.properties,
        floor: obj.floor,
      }));
      await this.objectModel.insertMany(docs, { ordered: false });
    }

    return { drawingId, objectCount: detected.length };
  }
}
