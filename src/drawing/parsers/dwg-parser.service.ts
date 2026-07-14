import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type {
  DrawingParserInterface,
  DrawingParseResult,
  ParsedPage,
  RawEntity,
} from './drawing-parser.interface';

/**
 * Coerce a libredwg text field to a plain string.
 * libredwg-web sometimes returns text as an object ({ text } / { value }) —
 * without this, downstream renders "[object Object]".
 * Also strips MTEXT inline format codes (\P, {\fArial;...}, %%c...).
 *
 * keepLineBreaks: \P (MTEXT paragraph break) → '\n' so the adapter can split
 * into multiple text entities. Default (false) flattens to a single line
 * (TEXT/ATTRIB/DIMENSION callers).
 */
export function coerceDwgText(raw: unknown, opts?: { keepLineBreaks?: boolean }): string {
  let s: unknown = raw;
  if (s !== null && typeof s === 'object') {
    s = (s as any).text ?? (s as any).value ?? '';
  }
  if (typeof s !== 'string') s = s === null || s === undefined ? '' : String(s);
  const cleaned = (s as string)
    .replace(/\\P/g, '\n')                 // paragraph break
    .replace(/\\[A-Za-z][^;{}\\]*;/g, '')  // format codes: \fArial|b0;, \H2.5x;, \C1;
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±');
  if (opts?.keepLineBreaks) {
    return cleaned
      .split('\n')
      .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
      .filter((l) => l.length > 0)
      .join('\n');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

/** Block definition extracted from db.tables.BLOCK_RECORD — entities are block-local. */
export interface DwgBlockDef {
  basePoint: { x: number; y: number };
  entities: RawEntity[];
}

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

    // dwg_read_data returns Dwg_Data pointer on success, undefined on failure. NHƯNG
    // với file lớn/phức tạp (vd bản KẾT CẤU 20MB+) WASM có thể THROW "memory access out
    // of bounds" — không được bắt sẽ crash worker VÀ để module ở trạng thái ABORTED
    // trong _cache → mọi parse sau cũng chết. Bắt → fail gọn + reset cache.
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    let dwgPtr: number | undefined | null;
    try {
      dwgPtr = lib.dwg_read_data(uint8, Dwg_File_Type.DWG);
    } catch (err) {
      this._cache = null; // module đã abort → buộc tạo mới cho lần sau
      throw new Error(
        `Không đọc được bản vẽ "${path.basename(filePath)}" (${sizeMB}MB): libredwg lỗi bộ nhớ/định dạng trên file lớn. ` +
          `Thử Save As sang DWG bản mới (AutoCAD 2018+), hoặc PURGE/tách bản vẽ cho nhẹ rồi upload lại. [${(err as Error).message}]`,
      );
    }
    if (dwgPtr === undefined || dwgPtr === null) {
      throw new Error(`libredwg: cannot read DWG — unsupported version or corrupt file (${path.basename(filePath)})`);
    }
    this.logger.log(`[DwgParser] dwg_read_data OK in ${Date.now() - t0}ms, ptr=${dwgPtr}`);

    // 3. Convert WASM struct → JS database (cũng có thể throw trên file nặng).
    const t1 = Date.now();
    let db: any;
    try {
      db = lib.convert(dwgPtr);
    } catch (err) {
      try { lib.dwg_free(dwgPtr); } catch { /* module có thể đã abort */ }
      this._cache = null;
      throw new Error(
        `Không dựng được dữ liệu bản vẽ "${path.basename(filePath)}" (${sizeMB}MB): quá lớn/phức tạp. ` +
          `PURGE hoặc tách bản vẽ rồi thử lại. [${(err as Error).message}]`,
      );
    }
    lib.dwg_free(dwgPtr);
    this.logger.log(`[DwgParser] convert OK in ${Date.now() - t1}ms, version=${(db.header as any)?.version ?? '?'}`);

    // 4. Extract
    const layers = this.extractLayers(db);

    // Debug raw structure from libredwg
    const rawAll: any[] = db?.entities ?? [];
    const rawTypeCounts: Record<string, number> = {};
    for (const e of rawAll) rawTypeCounts[e.type ?? 'null'] = (rawTypeCounts[e.type ?? 'null'] ?? 0) + 1;
    this.logger.log(`[DwgParser] raw type counts: ${JSON.stringify(rawTypeCounts)}`);
    // Log raw structure of first TEXT, HATCH, DIMENSION entity for field discovery.
    // BigInt-safe: libredwg đôi khi trả field BigInt (vd DIMENSION) → JSON.stringify
    // NÉM "Do not know how to serialize a BigInt" và làm SẬP CẢ parse → rơi nhầm sang
    // converter ("DWG không hỗ trợ"). Replacer đổi BigInt→string để log không bao giờ crash.
    const bnSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    const firstText  = rawAll.find(e => e.type === 'TEXT');
    const firstHatch = rawAll.find(e => e.type === 'HATCH');
    const firstDim   = rawAll.find(e => e.type === 'DIMENSION');
    if (firstText)  this.logger.log(`[DwgParser] raw TEXT keys: ${JSON.stringify(Object.keys(firstText))} | sample: ${JSON.stringify(firstText, bnSafe)}`);
    if (firstHatch) this.logger.log(`[DwgParser] raw HATCH keys: ${JSON.stringify(Object.keys(firstHatch))} | sample: ${JSON.stringify(firstHatch, bnSafe)}`);
    if (firstDim)   this.logger.log(`[DwgParser] raw DIM keys: ${JSON.stringify(Object.keys(firstDim))} | sample: ${JSON.stringify(firstDim, bnSafe)}`);
    // Log space distribution to see Paper Space vs Model Space
    const spaceCounts: Record<string, number> = {};
    for (const e of rawAll) {
      const sp = String(e.inPaperSpace ?? e.space ?? 'model');
      spaceCounts[sp] = (spaceCounts[sp] ?? 0) + 1;
    }
    this.logger.log(`[DwgParser] space distribution: ${JSON.stringify(spaceCounts)}`);
    // Log first INSERT to see its fields
    const firstInsert = rawAll.find(e => e.type === 'INSERT');
    if (firstInsert) this.logger.log(`[DwgParser] raw INSERT sample: ${JSON.stringify(firstInsert, bnSafe)}`);
    // Log available top-level keys of db to see if blocks/layouts exist
    this.logger.log(`[DwgParser] db keys: ${Object.keys(db ?? {}).join(', ')}`);
    // Check block definitions in multiple possible locations
    const blockObj = db?.blocks ?? db?.blockDefs ?? db?.blockRecords ?? {};
    const blockKeys = Array.isArray(blockObj) ? blockObj.map((b: any) => b.name ?? b.blockName ?? '?') : Object.keys(blockObj);
    this.logger.log(`[DwgParser] blocks (defs): ${blockKeys.length} — first 10: ${blockKeys.slice(0, 10).join(', ')}`);
    // If blocks is array, log first non-asterisk block's entity count
    if (Array.isArray(blockObj)) {
      const firstUserBlock = blockObj.find((b: any) => !(b.name ?? '').startsWith('*'));
      if (firstUserBlock) {
        const ents = firstUserBlock.entities ?? firstUserBlock.items ?? [];
        this.logger.log(`[DwgParser] sample block "${firstUserBlock.name}": ${ents.length} entities inside`);
      }
    } else if (typeof blockObj === 'object') {
      const firstKey = blockKeys.find(k => !k.startsWith('*'));
      if (firstKey) {
        const blk = blockObj[firstKey];
        const ents = blk?.entities ?? blk?.items ?? [];
        this.logger.log(`[DwgParser] sample block "${firstKey}": ${ents.length} entities inside`);
      }
    }
    if (db?.layouts) this.logger.log(`[DwgParser] layouts: ${JSON.stringify(Object.keys(db.layouts))}`);

    const entities = this.extractEntities(db);
    const blocks = this.extractBlocks(db);
    this.logger.log(`[DwgParser] block defs (BLOCK_RECORD): ${Object.keys(blocks).length}`);
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
      metadata: {
        version: (db.header as any)?.version ?? 'unknown',
        fileSize,
        insunits: (db.header as any)?.INSUNITS,
        blocks,
      },
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

  /**
   * Block definitions live in db.tables.BLOCK_RECORD.entries (NOT db.blocks).
   * Skips system blocks (*Model_Space, *Paper_Space, anonymous *X/*D).
   */
  private extractBlocks(db: any): Record<string, DwgBlockDef> {
    const entries: any[] = db?.tables?.BLOCK_RECORD?.entries ?? [];
    const blocks: Record<string, DwgBlockDef> = {};
    for (const rec of entries) {
      const name: string = rec?.name ?? '';
      if (!name || name.startsWith('*')) continue;
      const raw: any[] = rec?.entities ?? [];
      if (!raw.length) continue;
      const mapped: RawEntity[] = [];
      for (const e of raw) {
        const m = this.mapEntity(e);
        if (m) mapped.push(m);
      }
      if (mapped.length) {
        blocks[name] = {
          basePoint: { x: rec?.basePoint?.x ?? 0, y: rec?.basePoint?.y ?? 0 },
          entities: mapped,
        };
      }
    }
    return blocks;
  }

  private extractEntities(db: any): RawEntity[] {
    const raw: any[] = db?.entities ?? [];
    const result: RawEntity[] = [];
    let skippedPaperSpace = 0;
    const unhandled: Record<string, number> = {};

    for (const e of raw) {
      // Skip Paper Space entities — title blocks / viewports, not model geometry
      if (e.inPaperSpace || e.space === 1 || e.space === 'paper') {
        skippedPaperSpace++;
        continue;
      }
      const mapped = this.mapEntity(e);
      if (mapped) {
        result.push(mapped);
      } else {
        unhandled[e.type ?? 'null'] = (unhandled[e.type ?? 'null'] ?? 0) + 1;
      }
    }

    if (skippedPaperSpace > 0) {
      this.logger.log(`[DwgParser] skipped ${skippedPaperSpace} Paper Space entities`);
    }
    if (Object.keys(unhandled).length) {
      this.logger.log(`[DwgParser] UNHANDLED types (dropped): ${JSON.stringify(unhandled)}`);
    }

    // Log top-10 outliers (entities with coordinates far from median)
    this.logOutliers(result);

    return result;
  }

  private logOutliers(entities: RawEntity[]): void {
    if (!entities.length) return;
    const xs = entities.map(e => e.x).filter(isFinite).sort((a, b) => a - b);
    const ys = entities.map(e => e.y).filter(isFinite).sort((a, b) => a - b);
    if (!xs.length) return;
    const medX = xs[Math.floor(xs.length / 2)];
    const medY = ys[Math.floor(ys.length / 2)];
    const outliers = entities
      .map(e => ({ e, d: Math.hypot(e.x - medX, e.y - medY) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 10);
    const table = outliers
      .map(({ e, d }) => `  ${e.type} layer=${e.layer} handle=${e.properties?.handle ?? '?'} x=${Math.round(e.x)} y=${Math.round(e.y)} d=${Math.round(d)}`)
      .join('\n');
    this.logger.log(`[DwgParser] median center=(${Math.round(medX)},${Math.round(medY)}) top-10 outliers:\n${table}`);
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
        return { ...base, type: 'TEXT',
          x: e.startPoint?.x ?? 0, y: e.startPoint?.y ?? 0,
          text: coerceDwgText(e.text),
          properties: { ...base.properties,
            textHeight: e.textHeight ?? 0,
            rotation:   e.rotation ?? 0,
            halign:     e.halign ?? 0,
            valign:     e.valign ?? 0,
          },
        };
      }

      case 'ATTRIB': {
        return { ...base, type: 'TEXT',
          x: e.insertionPoint?.x ?? e.startPoint?.x ?? 0,
          y: e.insertionPoint?.y ?? e.startPoint?.y ?? 0,
          text: coerceDwgText(e.text),
          properties: { ...base.properties,
            textHeight: e.textHeight ?? 0,
            rotation:   e.rotation ?? 0,
          },
        };
      }

      case 'MTEXT': {
        const cleanText = coerceDwgText(e.text, { keepLineBreaks: true });
        return { ...base, type: 'MTEXT',
          x: e.insertionPoint?.x ?? 0, y: e.insertionPoint?.y ?? 0,
          text: cleanText,
          properties: { ...base.properties,
            textHeight: e.charHeight ?? e.textHeight ?? 0,
            rotation:   e.rotation ?? 0,
          },
        };
      }

      case 'INSERT': {
        const ix = e.insertionPoint?.x ?? 0, iy = e.insertionPoint?.y ?? 0;
        // ATTRIB sub-entities carry their own WORLD insertionPoint — map them
        // as plain TEXT so the adapter renders them without the insert transform.
        const attribsRaw: any[] = e.attribs ?? e.attributes ?? [];
        const attribs: RawEntity[] = [];
        for (const a of attribsRaw) {
          const m = this.mapEntity(a);
          if (m && m.text) attribs.push(m);
        }
        return { ...base, type: 'INSERT',
          x: ix, y: iy,
          blockName: e.name ?? e.blockName,
          attribs: attribs.length ? attribs : undefined,
          properties: { ...base.properties,
            blockName: e.name ?? e.blockName ?? '',
            scaleX: e.scaleFactors?.x ?? e.xScale ?? 1,
            scaleY: e.scaleFactors?.y ?? e.yScale ?? 1,
            rotation: e.rotation ?? 0,
          },
        };
      }

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
        // boundaryPaths[].vertices[] is the correct field (confirmed from raw entity log)
        const paths: any[] = e.boundaryPaths ?? [];
        const allPts: number[][] = [];
        for (const path of paths) {
          const verts: any[] = path.vertices ?? [];
          for (const v of verts) allPts.push([v.x ?? 0, v.y ?? 0]);
          // Close each path loop
          if (verts.length > 1) allPts.push([verts[0].x ?? 0, verts[0].y ?? 0]);
        }
        const seed = e.seedPoints?.[0];
        return { ...base, type: 'HATCH',
          x: seed?.x ?? (allPts[0]?.[0] ?? 0),
          y: seed?.y ?? (allPts[0]?.[1] ?? 0),
          vertices: allPts.length > 1 ? allPts : undefined,
          properties: { ...base.properties, patternName: e.patternName ?? '', solidFill: e.solidFill ?? 0 },
        };
      }

      case 'DIMENSION': {
        // Use confirmed field names from raw entity log
        const p1  = e.subDefinitionPoint1;
        const p2  = e.subDefinitionPoint2;
        const pD  = e.definitionPoint;
        const pTx = e.textPoint;
        const dimPts: number[][] = [];
        if (p1) dimPts.push([p1.x, p1.y]);
        if (p2) dimPts.push([p2.x, p2.y]);
        if (pD && pD.x !== 0) dimPts.push([pD.x, pD.y]);
        const measurement = e.measurement ?? 0;
        const text = coerceDwgText(e.text) || (measurement > 0 ? String(Math.round(measurement)) : '');
        return { ...base, type: 'DIMENSION',
          x: pTx?.x ?? (p1?.x ?? 0),
          y: pTx?.y ?? (p1?.y ?? 0),
          vertices: dimPts.length >= 2 ? dimPts : undefined,
          text,
          properties: { ...base.properties, measurement, textHeight: e.textHeight ?? 0 },
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

      // Old-style 3D polylines — vertices stored as VERTEX entities in sequence.
      // libredwg-web may inline them as `e.vertices[]` or expose as child entities.
      case 'POLYLINE':
      case '2DPOLYLINE':
      case '3DPOLYLINE': {
        // Try inline vertices first (libredwg-web may flatten them)
        let verts: any[] = e.vertices ?? e.points ?? [];
        if (!verts.length && Array.isArray(e.entities)) {
          verts = (e.entities as any[]).filter(v => v.type === 'VERTEX' || v.type === '2DVERTEX' || v.type === '3DVERTEX');
        }
        const pts = verts.map((v: any) => [v.x ?? v.position?.x ?? 0, v.y ?? v.position?.y ?? 0]);
        const v0 = pts[0];
        return { ...base, type: 'LWPOLYLINE',
          x: v0?.[0] ?? 0, y: v0?.[1] ?? 0,
          vertices: pts.length > 1 ? pts : undefined,
          properties: { ...base.properties, vertexCount: pts.length } };
      }

      // SOLID / TRACE — filled quadrilateral (4-corner shape)
      case 'SOLID':
      case 'TRACE': {
        const pts: number[][] = [];
        if (e.corner1) pts.push([e.corner1.x, e.corner1.y]);
        if (e.corner2) pts.push([e.corner2.x, e.corner2.y]);
        if (e.corner3) pts.push([e.corner3.x, e.corner3.y]);
        if (e.corner4) pts.push([e.corner4.x, e.corner4.y]);
        if (pts.length > 0) pts.push(pts[0]); // close
        return pts.length > 1
          ? { ...base, type: 'LWPOLYLINE', x: pts[0][0], y: pts[0][1], vertices: pts, properties: base.properties }
          : null;
      }

      // LEADER / MULTILEADER — annotation leader lines
      case 'LEADER': {
        const verts: any[] = e.vertices ?? e.points ?? [];
        const pts = verts.map((v: any) => [v.x ?? 0, v.y ?? 0]);
        return pts.length >= 2
          ? { ...base, type: 'LINE', x: pts[0][0], y: pts[0][1], vertices: pts, properties: base.properties }
          : null;
      }
      case 'MULTILEADER':
      case 'MLEADER': {
        // Try to get leader line points
        const ctx = e.leaderLineContextData ?? e.context ?? {};
        const lines: any[] = ctx.leaderLines ?? ctx.lines ?? e.leaderLines ?? [];
        const allPts: number[][] = [];
        for (const line of lines) {
          const pts: any[] = line.points ?? line.vertices ?? [];
          for (const p of pts) allPts.push([p.x ?? 0, p.y ?? 0]);
        }
        if (!allPts.length && e.contentPoint) {
          allPts.push([e.contentPoint.x, e.contentPoint.y]);
        }
        return allPts.length >= 2
          ? { ...base, type: 'LINE', x: allPts[0][0], y: allPts[0][1], vertices: allPts, properties: base.properties }
          : null;
      }

      // WIPEOUT — rectangular mask (treat as polyline outline)
      case 'WIPEOUT':
      case 'IMAGE': {
        const bb = e.boundary ?? e.clippingBoundary ?? {};
        const pts: number[][] = [];
        if (bb.vertices) for (const v of bb.vertices) pts.push([v.x, v.y]);
        else if (e.insertionPoint && e.width && e.height) {
          const px = e.insertionPoint.x, py = e.insertionPoint.y;
          const w = e.width ?? 0, h = e.height ?? 0;
          pts.push([px, py], [px + w, py], [px + w, py + h], [px, py + h], [px, py]);
        }
        return pts.length >= 2
          ? { ...base, type: 'LWPOLYLINE', x: pts[0][0], y: pts[0][1], vertices: pts, properties: base.properties }
          : null;
      }

      // RAY / XLINE — construction lines (ignore — extend to infinity)
      case 'RAY':
      case 'XLINE':
        return null;

      default:
        return null;
    }
  }

  private extractExtents(
    db: any,
    entities: RawEntity[],
  ): { extMin: { x: number; y: number }; extMax: { x: number; y: number } } {
    // Try header EXTMIN/EXTMAX first (most accurate — set by AutoCAD on save)
    const h = db?.header as any;
    if (h?.extMin && h?.extMax &&
        isFinite(h.extMin.x) && isFinite(h.extMax.x) &&
        Math.abs(h.extMax.x - h.extMin.x) < 1e8) {
      return { extMin: { x: h.extMin.x, y: h.extMin.y }, extMax: { x: h.extMax.x, y: h.extMax.y } };
    }

    if (entities.length === 0) {
      return { extMin: { x: 0, y: 0 }, extMax: { x: 1000, y: 1000 } };
    }

    // Collect coordinates and use 1%-99% percentile to drop outliers
    const xs: number[] = [], ys: number[] = [];
    for (const e of entities) {
      if (isFinite(e.x)) xs.push(e.x);
      if (isFinite(e.y)) ys.push(e.y);
      if (e.x2 !== undefined && isFinite(e.x2)) xs.push(e.x2);
      if (e.y2 !== undefined && isFinite(e.y2)) ys.push(e.y2);
    }
    if (!xs.length) return { extMin: { x: 0, y: 0 }, extMax: { x: 1000, y: 1000 } };

    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);

    const p = (arr: number[], pct: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * pct)))];
    return {
      extMin: { x: p(xs, 0.01), y: p(ys, 0.01) },
      extMax: { x: p(xs, 0.99), y: p(ys, 0.99) },
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
