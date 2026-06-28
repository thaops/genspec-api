import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type {
  DrawingParserInterface,
  DrawingParseResult,
  ParsedPage,
  RawEntity,
} from './drawing-parser.interface';

@Injectable()
export class DwgParserService implements DrawingParserInterface {
  readonly supportedExtensions = ['dwg'];
  private readonly logger = new Logger(DwgParserService.name);

  // LibreDwg WASM module + types — loaded once, cached
  private _cache: { lib: any; Dwg_File_Type: any } | null = null;

  async parse(filePath: string): Promise<DrawingParseResult> {
    this.logger.log(`[DwgParser] Parsing: ${filePath}`);

    const { lib, Dwg_File_Type } = await this.getLib();
    const buffer = fs.readFileSync(filePath);
    const uint8 = new Uint8Array(buffer);

    const rawDwg = lib.dwg_read_data(uint8, Dwg_File_Type.DWG);
    if (rawDwg.error !== 0) {
      throw new Error(`libredwg error code ${rawDwg.error} reading ${filePath}`);
    }

    const db = lib.convert(rawDwg);
    lib.dwg_free(rawDwg);

    const layers = this.extractLayers(db);
    const entities = this.extractEntities(db);
    const { extMin, extMax } = this.extractExtents(db, entities);

    const page: ParsedPage = {
      pageNumber: 1,
      width:  extMax.x - extMin.x,
      height: extMax.y - extMin.y,
      text: entities.filter((e) => e.text).map((e) => e.text).join(' '),
      entities,
    };

    this.logger.log(`[DwgParser] Done: ${layers.length} layers, ${entities.length} entities`);

    return {
      pages: [page],
      layers,
      extMin,
      extMax,
      metadata: { version: (db.header as any)?.version ?? 'unknown' },
      parserVersion: 'libredwg-web@wasm',
    };
  }

  private extractLayers(db: any): Array<{ name: string; color?: number; visible?: boolean }> {
    const entries: any[] = db?.tables?.LAYER?.entries ?? [];
    return entries.map((l: any) => ({
      name:    l.name ?? '0',
      color:   l.colorIndex,
      visible: !l.off,
    }));
  }

  private extractEntities(db: any): RawEntity[] {
    const raw: any[] = db?.entities ?? [];
    const result: RawEntity[] = [];

    for (const e of raw) {
      const mapped = this.mapEntity(e);
      if (mapped) result.push(mapped);
    }

    return result;
  }

  private mapEntity(e: any): RawEntity | null {
    const base = {
      layer: e.layer ?? '0',
      properties: {
        handle:     e.handle    ?? '',
        colorIndex: e.colorIndex ?? '',
      },
    };

    switch (e.type) {
      case 'LINE':
        return { ...base, type: 'LINE',
          x: e.startPoint?.x ?? 0, y: e.startPoint?.y ?? 0,
          x2: e.endPoint?.x,       y2: e.endPoint?.y };

      case 'CIRCLE':
        return { ...base, type: 'CIRCLE',
          x: e.center?.x ?? 0, y: e.center?.y ?? 0,
          radius: e.radius };

      case 'ARC':
        return { ...base, type: 'ARC',
          x: e.center?.x ?? 0, y: e.center?.y ?? 0,
          radius: e.radius,
          properties: { ...base.properties, startAngle: e.startAngle ?? 0, endAngle: e.endAngle ?? 0 } };

      case 'TEXT':
        return { ...base, type: 'TEXT',
          x: e.startPoint?.x ?? 0, y: e.startPoint?.y ?? 0,
          text: e.text };

      case 'MTEXT':
        return { ...base, type: 'MTEXT',
          x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0,
          text: e.text };

      case 'INSERT':
        return { ...base, type: 'INSERT',
          x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0,
          blockName: e.name };

      case 'LWPOLYLINE': {
        const v0 = e.vertices?.[0];
        return { ...base, type: 'LWPOLYLINE',
          x: v0?.x ?? 0, y: v0?.y ?? 0,
          properties: { ...base.properties, vertexCount: e.vertices?.length ?? 0 } };
      }

      case 'HATCH':
        return { ...base, type: 'HATCH',
          x: e.seedPoints?.[0]?.x ?? 0, y: e.seedPoints?.[0]?.y ?? 0 };

      case 'DIMENSION':
        return { ...base, type: 'DIMENSION',
          x: e.textMidPt?.x ?? 0, y: e.textMidPt?.y ?? 0,
          text: e.text };

      case 'SPLINE': {
        const cp0 = e.controlPoints?.[0];
        return { ...base, type: 'SPLINE',
          x: cp0?.x ?? 0, y: cp0?.y ?? 0,
          properties: { ...base.properties, degree: e.degree ?? 3 } };
      }

      case 'ELLIPSE':
        return { ...base, type: 'ELLIPSE',
          x: e.center?.x ?? 0, y: e.center?.y ?? 0,
          radius: e.majorAxisEndPoint ? Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y) : 0 };

      case 'POINT':
        return { ...base, type: 'POINT',
          x: e.position?.x ?? 0, y: e.position?.y ?? 0 };

      default:
        return null;
    }
  }

  private extractExtents(
    db: any,
    entities: RawEntity[],
  ): { extMin: { x: number; y: number }; extMax: { x: number; y: number } } {
    // Try header EXTMIN/EXTMAX first
    const h = db?.header as any;
    if (h?.extMin && h?.extMax) {
      return { extMin: { x: h.extMin.x, y: h.extMin.y }, extMax: { x: h.extMax.x, y: h.extMax.y } };
    }

    // Compute from entities
    if (entities.length === 0) {
      return { extMin: { x: 0, y: 0 }, extMax: { x: 1000, y: 1000 } };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of entities) {
      minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x);
      minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y);
      if (e.x2 !== undefined) { minX = Math.min(minX, e.x2); maxX = Math.max(maxX, e.x2); }
      if (e.y2 !== undefined) { minY = Math.min(minY, e.y2); maxY = Math.max(maxY, e.y2); }
    }

    return {
      extMin: { x: minX, y: minY },
      extMax: { x: maxX, y: maxY },
    };
  }

  private async getLib(): Promise<{ lib: any; Dwg_File_Type: any }> {
    if (this._cache) return this._cache;

    // Must use new Function() to prevent SWC from compiling to require().
    // @mlightcad/libredwg-web is ESM-only (wasm glue uses import.meta.url),
    // which cannot be loaded via require() in Node.js CJS context.
    const { LibreDwg, Dwg_File_Type } = await (new Function('u', 'return import(u)'))('@mlightcad/libredwg-web');
    const wasmDir = path.join(process.cwd(), 'node_modules/@mlightcad/libredwg-web/wasm/');
    this.logger.log(`[DwgParser] Loading WASM from: ${wasmDir}`);
    const lib = await LibreDwg.create(wasmDir);
    this.logger.log(`[DwgParser] WASM loaded`);
    this._cache = { lib, Dwg_File_Type };
    return this._cache;
  }
}
