import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { DxfEntity } from '../parsers/dxf-parser.service';
import type { RawPdfPage } from '../parsers/pdf-parser.service';

export interface NormalizedObject {
  stableId: string;
  rawType: string;     // original entity type before classification
  layer: string;
  boundingBox: { x: number; y: number; w: number; h: number; page?: number };
  geometry: number[][];
  text?: string;
  properties: Record<string, string | number>;
}

/**
 * Normalizes raw parser output into a uniform shape.
 *
 * Responsibility:
 *   - Compute deterministic stableId (survives re-parse)
 *   - Convert geometry to bounding box
 *   - Extract text / dimension values as properties
 *
 * Does NOT classify type (beam/column/...) — that's DetectorService.
 */
@Injectable()
export class DrawingNormalizerService {
  fromDxfEntities(
    drawingId: string,
    entities: DxfEntity[],
  ): NormalizedObject[] {
    return entities.map((e) => {
      const bb = this.dxfBoundingBox(e);
      const stableId = this.makeStableId(drawingId, e.layer, e.type, bb);

      const properties: Record<string, string | number> = {};
      if (e.text) properties.text = e.text;
      if (e.blockName) properties.blockName = e.blockName;
      if (e.radius != null) properties.radius = e.radius;
      if (e.color != null) properties.color = e.color;

      return {
        stableId,
        rawType: e.type,
        layer: e.layer,
        boundingBox: bb,
        geometry: this.dxfGeometry(e),
        text: e.text,
        properties,
      };
    });
  }

  fromPdfPage(
    drawingId: string,
    page: RawPdfPage,
    labels: string[],
    dimensions: string[],
  ): NormalizedObject[] {
    const objects: NormalizedObject[] = [];

    // Each label becomes a candidate object for classification
    for (const label of labels) {
      const bb = { x: 0, y: 0, w: page.width, h: page.height, page: page.pageNumber };
      objects.push({
        stableId: this.makeStableId(drawingId, 'PDF', 'TEXT', bb, label),
        rawType: 'TEXT',
        layer: 'PDF',
        boundingBox: bb,
        geometry: [],
        text: label,
        properties: { label, page: page.pageNumber },
      });
    }

    // Each dimension string becomes a DIMENSION candidate
    for (const dim of dimensions) {
      const bb = { x: 0, y: 0, w: page.width, h: page.height, page: page.pageNumber };
      objects.push({
        stableId: this.makeStableId(drawingId, 'PDF', 'DIMENSION', bb, dim),
        rawType: 'DIMENSION',
        layer: 'PDF',
        boundingBox: bb,
        geometry: [],
        text: dim,
        properties: { dimension: dim, page: page.pageNumber },
      });
    }

    return objects;
  }

  /**
   * Deterministic stableId: SHA-1 of (drawingId + layer + type + rounded bbox + seed).
   * Rounded to 10-unit grid so minor re-parse jitter doesn't break identity.
   */
  private makeStableId(
    drawingId: string,
    layer: string,
    type: string,
    bb: { x: number; y: number; w: number; h: number },
    seed = '',
  ): string {
    const grid = 10;
    const key = [
      drawingId,
      layer,
      type,
      Math.round(bb.x / grid) * grid,
      Math.round(bb.y / grid) * grid,
      Math.round(bb.w / grid) * grid,
      Math.round(bb.h / grid) * grid,
      seed,
    ].join('|');
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  }

  private dxfBoundingBox(e: DxfEntity) {
    const x1 = e.x, y1 = e.y;
    const x2 = e.x2 ?? e.x, y2 = e.y2 ?? e.y;
    const r = e.radius ?? 0;
    return {
      x: Math.min(x1, x2) - r,
      y: Math.min(y1, y2) - r,
      w: Math.abs(x2 - x1) + r * 2 || r * 2 || 1,
      h: Math.abs(y2 - y1) + r * 2 || r * 2 || 1,
    };
  }

  private dxfGeometry(e: DxfEntity): number[][] {
    if (e.x2 !== undefined && e.y2 !== undefined) {
      return [[e.x, e.y], [e.x2, e.y2]];
    }
    return [[e.x, e.y]];
  }
}
