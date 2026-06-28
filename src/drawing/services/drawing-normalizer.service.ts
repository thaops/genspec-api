import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { RawEntity, ParsedPage } from '../parsers/drawing-parser.interface';

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

@Injectable()
export class DrawingNormalizerService {
  fromPages(drawingId: string, pages: ParsedPage[]): NormalizedObject[] {
    return pages.flatMap((page) =>
      page.entities.map((e) => this.entityToObject(drawingId, e, page.pageNumber))
    );
  }

  private entityToObject(
    drawingId: string,
    e: RawEntity,
    pageNumber: number,
  ): NormalizedObject {
    const bb = this.boundingBox(e, pageNumber);
    // Include handle (unique per entity in DWG/DXF) to prevent hash collision
    // when multiple entities share the same layer, type, and snapped position.
    const handle = String(e.properties?.handle ?? '');
    const stableId = this.makeStableId(drawingId, e.layer, e.type, bb, `${handle}|${e.text ?? ''}`);
    const properties: Record<string, string | number> = { ...e.properties };
    if (e.text) properties.text = e.text;
    if (e.blockName) properties.blockName = e.blockName;
    if (e.radius != null) properties.radius = e.radius;
    return { stableId, rawType: e.type, layer: e.layer, boundingBox: bb, geometry: this.geometry(e), text: e.text, properties };
  }

  private boundingBox(e: RawEntity, page: number) {
    const r = e.radius ?? 0;
    if (e.vertices && e.vertices.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [vx, vy] of e.vertices) {
        minX = Math.min(minX, vx); maxX = Math.max(maxX, vx);
        minY = Math.min(minY, vy); maxY = Math.max(maxY, vy);
      }
      const w = maxX - minX || 1;
      const h = maxY - minY || 1;
      return { x: minX, y: minY, w, h, page };
    }
    const x1 = e.x, y1 = e.y;
    const x2 = e.x2 ?? e.x, y2 = e.y2 ?? e.y;
    return {
      x: Math.min(x1, x2) - r,
      y: Math.min(y1, y2) - r,
      w: Math.abs(x2 - x1) + r * 2 || r * 2 || 1,
      h: Math.abs(y2 - y1) + r * 2 || r * 2 || 1,
      page,
    };
  }

  private geometry(e: RawEntity): number[][] {
    if (e.vertices && e.vertices.length > 0) return e.vertices;
    if (e.x2 !== undefined && e.y2 !== undefined) return [[e.x, e.y], [e.x2, e.y2]];
    return [[e.x, e.y]];
  }

  private makeStableId(
    drawingId: string,
    layer: string,
    type: string,
    bb: { x: number; y: number; w: number; h: number },
    seed = '',
  ): string {
    const g = 10;
    const key = [drawingId, layer, type,
      Math.round(bb.x / g) * g, Math.round(bb.y / g) * g,
      Math.round(bb.w / g) * g, Math.round(bb.h / g) * g,
      seed,
    ].join('|');
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  }
}
