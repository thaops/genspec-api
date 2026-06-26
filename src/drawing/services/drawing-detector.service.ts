import { Injectable, Logger } from '@nestjs/common';
import type { NormalizedObject } from './drawing-normalizer.service';

export interface DetectedObject extends NormalizedObject {
  objectType: string;
  confidence: number;
  floor?: string;
}

// Layer name → object type (highest priority — explicit mapping)
const LAYER_TYPE_MAP: Record<string, string> = {
  BEAM: 'beam', DAM: 'beam', 'KCC-DAM': 'beam',
  COLUMN: 'column', COT: 'column', 'KCC-COT': 'column',
  WALL: 'wall', TUONG: 'wall', 'KCC-TUONG': 'wall',
  SLAB: 'slab', SAN: 'slab', 'KCC-SAN': 'slab',
  STAIR: 'stair', THANG: 'stair',
  ROOF: 'roof', MAI: 'roof',
  FOOTING: 'footing', MONG: 'footing', 'KCC-MONG': 'footing',
  PILE: 'pile', COC: 'pile',
  DOOR: 'door', CUA: 'door',
  WINDOW: 'window', 'CUA-SO': 'window',
  DIM: 'dimension', DIMENSION: 'dimension', 'A-ANNO-DIMS': 'dimension',
};

// Label text pattern → object type
const LABEL_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /^[Bb]\d/, type: 'beam' },        // B1, B12
  { pattern: /^[Cc]\d/, type: 'column' },       // C1, C12
  { pattern: /^[Ww]\d/, type: 'wall' },         // W1, W3
  { pattern: /^[Ss][Ll]\d/i, type: 'slab' },   // SL1
  { pattern: /^[Ff]\d/, type: 'footing' },      // F1
  { pattern: /^[Pp][Cc]\d/i, type: 'pile' },   // PC1
  { pattern: /^[Dd]\d/, type: 'door' },         // D1
];

// DXF entity type → base object type (lowest priority fallback)
const ENTITY_TYPE_MAP: Record<string, string> = {
  TEXT: 'text', MTEXT: 'text',
  DIMENSION: 'dimension', LEADER: 'leader', MULTILEADER: 'leader',
  INSERT: 'block', HATCH: 'hatch',
  VIEWPORT: 'viewport',
};

/**
 * Classifies normalized objects into DrawingObjectType.
 *
 * Priority:
 *   1. Explicit layer name match (LAYER_TYPE_MAP) — confidence 0.95
 *   2. Label text pattern match (LABEL_PATTERNS) — confidence 0.85
 *   3. Aspect ratio heuristics (tall narrow = column, wide flat = beam) — 0.65
 *   4. DXF entity type fallback — 0.5
 *   5. unknown — 0.0
 */
@Injectable()
export class DrawingDetectorService {
  private readonly logger = new Logger(DrawingDetectorService.name);

  detect(objects: NormalizedObject[]): DetectedObject[] {
    return objects.map((obj) => {
      const { type, confidence } = this.classify(obj);
      const floor = this.inferFloor(obj);
      return { ...obj, objectType: type, confidence, floor };
    });
  }

  private classify(obj: NormalizedObject): { type: string; confidence: number } {
    // 1. Layer name
    const layerUpper = obj.layer.toUpperCase();
    for (const [key, type] of Object.entries(LAYER_TYPE_MAP)) {
      if (layerUpper === key || layerUpper.startsWith(key + '-')) {
        return { type, confidence: 0.95 };
      }
    }

    // 2. Label patterns
    if (obj.text) {
      for (const { pattern, type } of LABEL_PATTERNS) {
        if (pattern.test(obj.text.trim())) {
          return { type, confidence: 0.85 };
        }
      }
    }

    // 3. Aspect ratio heuristics for structural elements
    const { w, h } = obj.boundingBox;
    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (ratio > 4 && w > 100) return { type: 'beam',   confidence: 0.65 };
      if (ratio < 0.3 && h > 100) return { type: 'column', confidence: 0.65 };
      if (ratio > 2 && w > 500) return { type: 'wall',   confidence: 0.60 };
    }

    // 4. DXF entity type fallback
    const fallback = ENTITY_TYPE_MAP[obj.rawType];
    if (fallback) return { type: fallback, confidence: 0.5 };

    return { type: 'unknown', confidence: 0 };
  }

  private inferFloor(obj: NormalizedObject): string | undefined {
    // Infer from layer name: "T1-BEAM", "TANG1-COT"
    const match = obj.layer.match(/(?:T|TANG|FLOOR|FL)[-_]?(\d+|MONG|MAI|ROOF|BASE)/i);
    if (match) {
      const token = match[1].toUpperCase();
      if (['MONG', 'BASE'].includes(token)) return 'Móng';
      if (['MAI', 'ROOF'].includes(token)) return 'Mái';
      return `Tầng ${token}`;
    }
    // PDF page → approximate floor (1 page = 1 floor for simple buildings)
    if (obj.boundingBox.page) return `Tầng ${obj.boundingBox.page}`;
    return undefined;
  }
}
