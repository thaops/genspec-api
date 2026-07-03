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
    if (!existing.length) return { drawingId, objectCount: 0, objects: [], message: 'No objects to re-detect' };

    // Re-run detection on existing normalized objects
    // Tái dựng đủ shape NormalizedObject: rawType gốc (o.type là objectType đã detect),
    // text nằm trong properties.text (normalizer lưu ở đó) — thiếu là rule label_pattern chết.
    const normalized = existing.map((o) => {
      const properties = o.properties ?? {};
      const text = typeof properties.text === 'string' ? properties.text : undefined;
      return {
        stableId: o.stableId,
        rawType: o.rawType ?? o.type,
        layer: o.layer,
        boundingBox: o.boundingBox,
        geometry: o.geometry ?? [],
        text,
        properties,
        floor: o.floor,
      };
    });

    const detected = this.detector.detect(normalized);

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

    const objects = await this.objectModel.find({ drawingId }).lean();
    return { drawingId, objectCount: detected.length, objects };
  }
}
