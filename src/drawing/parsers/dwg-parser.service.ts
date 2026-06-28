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
    const fileSize = fs.statSync(filePath).size;
    this.logger.log(`[DwgParser] start file=${path.basename(filePath)} size=${(fileSize / 1024).toFixed(1)}KB`);

    // 1. Load WASM (cached after first call)
    const wasmLoaded = this._cache !== null;
    const { lib, Dwg_File_Type } = await this.getLib();
    if (!wasmLoaded) this.logger.log(`[DwgParser] WASM initialized`);

    // 2. Read file into WASM memory
    const t0 = Date.now();
    const buffer = fs.readFileSync(filePath);
    const uint8 = new Uint8Array(buffer);
    this.logger.log(`[DwgParser] calling dwg_read_data (${uint8.length} bytes)`);

    // dwg_read_data returns Dwg_Data pointer (number) on success, undefined on failure.
    // Non-fatal parse warnings are console.warn'd internally; only OUTOFMEM throws.
    const dwgPtr = lib.dwg_read_data(uint8, Dwg_File_Type.DWG);
    if (dwgPtr === undefined || dwgPtr === null) {
      throw new Error(`libredwg: cannot read DWG — unsupported version or corrupt file (${path.basename(filePath)})`);
    }
    this.logger.log(`[DwgParser] dwg_read_data OK in ${Date.now() - t0}ms, ptr=${dwgPtr}`);

    // 3. Convert WASM struct → JS database
    const t1 = Date.now();
    const db = lib.convert(dwgPtr);
    lib.dwg_free(dwgPtr);
    this.logger.log(`[DwgParser] convert OK in ${Date.now() - t1}ms, version=${(db.header as any)?.version ?? '?'}`);

    // 4. Extract
    const layers = this.extractLayers(db);

    // Debug raw structure from libredwg
    const rawAll: any[] = db?.entities ?? [];
    const rawTypeCounts: Record<string, number> = {};
    for (const e of rawAll) rawTypeCounts[e.type ?? 'null'] = (rawTypeCounts[e.type ?? 'null'] ?? 0) + 1;
    this.logger.log(`[DwgParser] raw type counts: ${JSON.stringify(rawTypeCounts)}`);
    // Log raw structure of first TEXT, HATCH, DIMENSION entity for field discovery
    const firstText  = rawAll.find(e => e.type === 'TEXT');
    const firstHatch = rawAll.find(e => e.type === 'HATCH');
    const firstDim   = rawAll.find(e => e.type === 'DIMENSION');
    if (firstText)  this.logger.log(`[DwgParser] raw TEXT keys: ${JSON.stringify(Object.keys(firstText))} | sample: ${JSON.stringify(firstText)}`);
    if (firstHatch) this.logger.log(`[DwgParser] raw HATCH keys: ${JSON.stringify(Object.keys(firstHatch))} | sample: ${JSON.stringify(firstHatch)}`);
    if (firstDim)   this.logger.log(`[DwgParser] raw DIM keys: ${JSON.stringify(Object.keys(firstDim))} | sample: ${JSON.stringify(firstDim)}`);
    // Log available top-level keys of db to see if blocks/layouts exist
    this.logger.log(`[DwgParser] db keys: ${Object.keys(db ?? {}).join(', ')}`);
    const blockKeys = Object.keys(db?.blocks ?? {});
    this.logger.log(`[DwgParser] blocks: ${blockKeys.length} defs — ${blockKeys.slice(0, 10).join(', ')}`);
    if (db?.layouts) this.logger.log(`[DwgParser] layouts: ${JSON.stringify(Object.keys(db.layouts))}`);

    const entities = this.extractEntities(db);
    const { extMin, extMax } = this.extractExtents(db, entities);
    this.logger.log(`[DwgParser] extracted: layers=${layers.length}, entities=${entities.length}, extents=(${extMin.x.toFixed(1)},${extMin.y.toFixed(1)})→(${extMax.x.toFixed(1)},${extMax.y.toFixed(1)})`);

    const page: ParsedPage = {
      pageNumber: 1,
      width:  extMax.x - extMin.x,
      height: extMax.y - extMin.y,
      text: entities.filter((e) => e.text).map((e) => e.text).join(' '),
      entities,
    };

    this.logger.log(`[DwgParser] done total=${Date.now() - t0}ms`);

    return {
      pages: [page],
      layers,
      extMin,
      extMax,
      metadata: { version: (db.header as any)?.version ?? 'unknown', fileSize },
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
        handle:     e.handle     ?? '',
        colorIndex: e.colorIndex ?? 256,  // 256 = ByLayer
        lineweight: e.lineweight ?? e.lineWeight ?? -1, // -1 = ByLayer
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

      case 'TEXT': {
        const textStr = e.text ?? e.textValue ?? e.textString ?? '';
        return { ...base, type: 'TEXT',
          x: e.startPoint?.x ?? e.insertionPoint?.x ?? 0,
          y: e.startPoint?.y ?? e.insertionPoint?.y ?? 0,
          text: textStr,
          properties: { ...base.properties,
            textHeight: e.height ?? e.textHeight ?? 0,
            rotation:   e.rotation ?? 0,
          },
        };
      }

      case 'MTEXT': {
        const rawText = e.text ?? e.textValue ?? e.textString ?? '';
        // Strip MText RTF-style codes: \P (paragraph), \f{...} (font), etc.
        const cleanText = rawText.replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim();
        return { ...base, type: 'MTEXT',
          x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0,
          text: cleanText,
          properties: { ...base.properties,
            textHeight: e.charHeight ?? e.height ?? 0,
            rotation:   e.rotation ?? 0,
          },
        };
      }

      case 'INSERT':
        return { ...base, type: 'INSERT',
          x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0,
          blockName: e.name };

      case 'LWPOLYLINE': {
        const verts: any[] = e.vertices ?? [];
        const v0 = verts[0];
        const pts = verts.map((v: any) => [v.x ?? 0, v.y ?? 0]);
        return { ...base, type: 'LWPOLYLINE',
          x: v0?.x ?? 0, y: v0?.y ?? 0,
          vertices: pts.length > 0 ? pts : undefined,
          properties: { ...base.properties, vertexCount: verts.length } };
      }

      case 'HATCH': {
        // Extract boundary loops as vertices for outline rendering
        const loops: any[] = e.loops ?? e.boundaryPaths ?? e.paths ?? [];
        const allPts: number[][] = [];
        for (const loop of loops) {
          const segs: any[] = loop.segs ?? loop.segments ?? loop.edges ?? [];
          for (const seg of segs) {
            if (seg.type === 1 || seg.type === 'LINE') {
              if (seg.start) allPts.push([seg.start.x, seg.start.y]);
              if (seg.end) allPts.push([seg.end.x, seg.end.y]);
            } else if (seg.pts || seg.polylinePts) {
              const verts: any[] = seg.pts ?? seg.polylinePts ?? [];
              for (const v of verts) allPts.push([v.x ?? v[0] ?? 0, v.y ?? v[1] ?? 0]);
            }
          }
        }
        const seed = e.seedPoints?.[0];
        return { ...base, type: 'HATCH',
          x: seed?.x ?? (allPts[0]?.[0] ?? 0),
          y: seed?.y ?? (allPts[0]?.[1] ?? 0),
          vertices: allPts.length > 1 ? allPts : undefined,
          properties: { ...base.properties, patternName: e.name ?? e.patternName ?? '' },
        };
      }

      case 'DIMENSION': {
        // Extract dimension line endpoints for rendering
        const dimPts: number[][] = [];
        if (e.defPoint)    dimPts.push([e.defPoint.x, e.defPoint.y]);
        if (e.defPoint2)   dimPts.push([e.defPoint2.x, e.defPoint2.y]);
        if (e.dimLinePoint) dimPts.push([e.dimLinePoint.x, e.dimLinePoint.y]);
        if (e.clonePoint)  dimPts.push([e.clonePoint.x, e.clonePoint.y]);
        const txtPt = e.textMidPt ?? e.textPosition;
        return { ...base, type: 'DIMENSION',
          x: txtPt?.x ?? (dimPts[0]?.[0] ?? 0),
          y: txtPt?.y ?? (dimPts[0]?.[1] ?? 0),
          vertices: dimPts.length >= 2 ? dimPts : undefined,
          text: e.text ?? e.textValue ?? '',
          properties: { ...base.properties,
            textHeight: e.textHeight ?? e.height ?? 0,
          },
        };
      }

      case 'SPLINE': {
        const cps: any[] = e.controlPoints ?? e.fitPoints ?? [];
        const cp0 = cps[0];
        const pts = cps.map((p: any) => [p.x ?? 0, p.y ?? 0]);
        return { ...base, type: 'SPLINE',
          x: cp0?.x ?? 0, y: cp0?.y ?? 0,
          vertices: pts.length > 1 ? pts : undefined,
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
