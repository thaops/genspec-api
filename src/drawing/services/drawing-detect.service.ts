import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../schemas/drawing-object.schema';
import { DrawingDetectorService } from './drawing-detector.service';
import { DrawingNormalizerService } from './drawing-normalizer.service';
import { DrawingLayerRuleService } from './drawing-layer-rule.service';
import { DrawingObjectOverrideService } from './drawing-object-override.service';

@Injectable()
export class DrawingDetectService {
  constructor(
    @InjectModel(Drawing.name) private drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private objectModel: Model<DrawingObjectDocument>,
    private readonly normalizer: DrawingNormalizerService,
    private readonly detector: DrawingDetectorService,
    private readonly layerRules: DrawingLayerRuleService,
    private readonly overrides: DrawingObjectOverrideService,
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

    const layerOverrides = await this.layerRules.list(estimateId);
    // Tỉ lệ đã suy lúc parse (thiếu $INSUNITS → undefined) — re-detect phải dùng đúng
    // tỉ lệ đó để guard tiết diện KC cho kết quả giống lần parse đầu.
    const drawing = await this.drawingModel.findById(drawingId).lean();
    const detected = this.detector.detect(normalized, layerOverrides, drawing?.unitFactor);
    const userOverrides = await this.overrides.map(drawingId);

    await this.objectModel.deleteMany({ drawingId });
    // Batch insert to bound peak memory on dense drawings (giant BSON array → OOM).
    const CHUNK = 2000;
    for (let i = 0; i < detected.length; i += CHUNK) {
      const docs = detected.slice(i, i + CHUNK).map((obj) => {
        // Tier 4 — user correction wins over every detector tier.
        const forced = userOverrides.get(obj.stableId);
        return {
          drawingId,
          stableId: obj.stableId,
          rawType: obj.rawType,
          type: forced ?? obj.objectType,
          layer: obj.layer,
          boundingBox: obj.boundingBox,
          geometry: obj.geometry,
          confidence: forced ? 1 : obj.confidence,
          detectionReason: forced ? 'Người dùng sửa (Tier 4)' : obj.detection?.reason,
          candidates: forced ? [{ type: forced, prob: 1 }] : obj.detection?.candidates,
          ambiguous: forced ? false : obj.detection?.ambiguous,
          properties: obj.properties,
          floor: obj.floor,
        };
      });
      await this.objectModel.insertMany(docs, { ordered: false });
    }

    const objects = await this.objectModel.find({ drawingId }).lean();
    return { drawingId, objectCount: detected.length, objects };
  }
}
