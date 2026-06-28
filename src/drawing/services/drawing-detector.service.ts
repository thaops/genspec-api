import { Injectable, Logger } from '@nestjs/common';
import type { RawEntity } from '../parsers/drawing-parser.interface';

export interface NormalizedObject {
  stableId: string;
  rawType: string;
  layer: string;
  boundingBox: { x: number; y: number; w: number; h: number; page?: number };
  geometry: number[][];
  text?: string;
  properties: Record<string, string | number>;
  floor?: string;
}

export type DetectionRule =
  | 'layer_map'       // layer name matched LAYER_TYPE_MAP
  | 'label_pattern'   // text label matched regex
  | 'aspect_ratio'    // bounding box ratio heuristic
  | 'entity_type'     // DXF entity type fallback
  | 'none';           // unclassified

export interface DetectionResult {
  objectType: string;
  confidence: number;
  matchedRule: DetectionRule;
  reason: string;     // human-readable explanation — used by Explain AI
  fallback: boolean;  // true if result is a best-effort guess
}

export interface DetectedObject extends NormalizedObject {
  detection: DetectionResult;
  // Convenience aliases kept for pipeline compatibility
  objectType: string;
  confidence: number;
}

const LAYER_TYPE_MAP: Record<string, string> = {
  // Structural — beam
  BEAM: 'beam', DAM: 'beam', 'KCC-DAM': 'beam', 'S-BEAM': 'beam', 'KC-DAM': 'beam',
  // Structural — column
  COLUMN: 'column', COT: 'column', 'KCC-COT': 'column', 'S-COL': 'column', 'KC-COT': 'column',
  // Wall
  WALL: 'wall', TUONG: 'wall', 'KCC-TUONG': 'wall', 'A-WALL': 'wall', 'S-WALL': 'wall',
  'TUONG-GACH': 'wall', 'TUONG-BT': 'wall',
  // Slab / floor
  SLAB: 'slab', SAN: 'slab', 'KCC-SAN': 'slab', 'S-SLAB': 'slab', 'KC-SAN': 'slab',
  // Stair
  STAIR: 'stair', THANG: 'stair', 'A-STAIR': 'stair',
  // Roof
  ROOF: 'roof', MAI: 'roof', 'A-ROOF': 'roof',
  // Foundation
  FOOTING: 'footing', MONG: 'footing', 'KCC-MONG': 'footing', 'S-FNDTN': 'footing', 'KC-MONG': 'footing',
  // Pile
  PILE: 'pile', COC: 'pile', 'S-PILE': 'pile',
  // Door
  DOOR: 'door', CUA: 'door', 'A-DOOR': 'door', 'CUAN': 'door',
  // Window
  WINDOW: 'window', 'CUA-SO': 'window', 'A-WIND': 'window', 'CUASO': 'window',
  // Axis / grid lines — visual only, not structural
  TRUC: 'axis', TRUCL: 'axis', 'TIM-TRUC': 'axis', GRID: 'axis', 'A-GRID': 'axis',
  'TRUC-CHINH': 'axis', 'TRUC-PHU': 'axis',
  // Dimension / annotation
  DIM: 'dimension', DIMENSION: 'dimension', 'A-ANNO-DIMS': 'dimension',
  'Layer-DIM': 'dimension', 'KICH-THUOC': 'dimension', 'KT': 'dimension',
  ANNO: 'dimension', TEXT: 'text', 'A-TEXT': 'text', 'A-ANNO-TEXT': 'text',
  // Hatch / fill
  HATCH: 'hatch', 'A-HATCH': 'hatch', 'CAT': 'hatch',
  // Symbols
  SYMBOL: 'symbol', 'A-SYMB': 'symbol', 'KY-HIEU': 'symbol',
};

const LABEL_PATTERNS: Array<{ pattern: RegExp; type: string; hint: string }> = [
  { pattern: /^[Bb]\d/, type: 'beam',    hint: 'Label matches beam pattern (B + digit)' },
  { pattern: /^[Cc]\d/, type: 'column',  hint: 'Label matches column pattern (C + digit)' },
  { pattern: /^[Ww]\d/, type: 'wall',    hint: 'Label matches wall pattern (W + digit)' },
  { pattern: /^[Ss][Ll]\d/i, type: 'slab', hint: 'Label matches slab pattern (SL + digit)' },
  { pattern: /^[Ff]\d/, type: 'footing', hint: 'Label matches footing pattern (F + digit)' },
  { pattern: /^[Pp][Cc]\d/i, type: 'pile', hint: 'Label matches pile pattern (PC + digit)' },
  { pattern: /^[Dd]\d/, type: 'door',    hint: 'Label matches door pattern (D + digit)' },
];

const ENTITY_TYPE_MAP: Record<string, string> = {
  TEXT: 'text', MTEXT: 'text',
  DIMENSION: 'dimension', LEADER: 'leader', MULTILEADER: 'leader',
  INSERT: 'block', HATCH: 'hatch',
  VIEWPORT: 'viewport',
};

@Injectable()
export class DrawingDetectorService {
  private readonly logger = new Logger(DrawingDetectorService.name);

  detect(objects: NormalizedObject[]): DetectedObject[] {
    return objects.map((obj) => {
      const detection = this.classify(obj);
      const floor = this.inferFloor(obj);
      return {
        ...obj,
        floor: floor ?? obj.floor,
        detection,
        objectType: detection.objectType,
        confidence: detection.confidence,
      };
    });
  }

  private classify(obj: NormalizedObject): DetectionResult {
    // 1. Layer name — exact, prefix, or suffix match (case-insensitive)
    const layerUpper = obj.layer.toUpperCase();
    for (const [key, type] of Object.entries(LAYER_TYPE_MAP)) {
      const k = key.toUpperCase();
      if (layerUpper === k || layerUpper.startsWith(k + '-') || layerUpper.endsWith('-' + k) || layerUpper.includes('-' + k + '-')) {
        return {
          objectType: type,
          confidence: 0.95,
          matchedRule: 'layer_map',
          reason: `Layer "${obj.layer}" matched rule "${key}" → ${type}`,
          fallback: false,
        };
      }
    }

    // 2. Label text pattern
    if (obj.text) {
      for (const { pattern, type, hint } of LABEL_PATTERNS) {
        if (pattern.test(obj.text.trim())) {
          return {
            objectType: type,
            confidence: 0.85,
            matchedRule: 'label_pattern',
            reason: `${hint} (text: "${obj.text}")`,
            fallback: false,
          };
        }
      }
    }

    // 3. Aspect ratio heuristics
    const { w, h } = obj.boundingBox;
    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (ratio > 4 && w > 100) return {
        objectType: 'beam', confidence: 0.65,
        matchedRule: 'aspect_ratio',
        reason: `Wide horizontal shape (ratio ${ratio.toFixed(1)}) suggests beam`,
        fallback: true,
      };
      if (ratio < 0.3 && h > 100) return {
        objectType: 'column', confidence: 0.65,
        matchedRule: 'aspect_ratio',
        reason: `Tall narrow shape (ratio ${ratio.toFixed(1)}) suggests column`,
        fallback: true,
      };
      if (ratio > 2 && w > 500) return {
        objectType: 'wall', confidence: 0.60,
        matchedRule: 'aspect_ratio',
        reason: `Long horizontal element (w=${Math.round(w)}) suggests wall`,
        fallback: true,
      };
    }

    // 4. DXF entity type fallback
    const fallbackType = ENTITY_TYPE_MAP[obj.rawType];
    if (fallbackType) return {
      objectType: fallbackType,
      confidence: 0.5,
      matchedRule: 'entity_type',
      reason: `DXF entity type ${obj.rawType} → ${fallbackType}`,
      fallback: true,
    };

    return {
      objectType: 'unknown',
      confidence: 0,
      matchedRule: 'none',
      reason: 'No matching rule found',
      fallback: true,
    };
  }

  private inferFloor(obj: NormalizedObject): string | undefined {
    const match = obj.layer.match(/(?:T|TANG|FLOOR|FL)[-_]?(\d+|MONG|MAI|ROOF|BASE)/i);
    if (match) {
      const token = match[1].toUpperCase();
      if (['MONG', 'BASE'].includes(token)) return 'Móng';
      if (['MAI', 'ROOF'].includes(token)) return 'Mái';
      return `Tầng ${token}`;
    }
    if (obj.boundingBox.page) return `Tầng ${obj.boundingBox.page}`;
    return undefined;
  }
}
