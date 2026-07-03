import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import type {
  DrawingParserInterface,
  DrawingParseResult,
  ParsedPage,
  RawEntity,
} from './drawing-parser.interface';

// ---------------------------------------------------------------------------
// Rich DXF document model — consumed by SceneBuilderService and by parse()
// ---------------------------------------------------------------------------

export type DxfUnits = 'mm' | 'm' | 'inch' | 'unknown';

export interface DxfLayer {
  name: string;
  colorIndex?: number;
}

export type DxfEntity =
  | { kind: 'line'; layer: string; colorIndex?: number; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'pline'; layer: string; colorIndex?: number; closed: boolean; pts: number[] }
  | { kind: 'arc'; layer: string; colorIndex?: number; cx: number; cy: number; r: number; a0: number; a1: number }
  | { kind: 'circle'; layer: string; colorIndex?: number; cx: number; cy: number; r: number }
  | { kind: 'text'; layer: string; colorIndex?: number; x: number; y: number; h: number; rot: number; text: string };

export interface DxfDocument {
  units: DxfUnits;
  layers: DxfLayer[];
  entities: DxfEntity[];
  /** Entities recognized for detection pipeline but not scene geometry (DIMENSION, HATCH, ...) */
  extras: RawEntity[];
  extMin?: { x: number; y: number };
  extMax?: { x: number; y: number };
}

/** AutoCAD Color Index → hex for the 16 standard colors. */
const ACI_HEX: Record<number, string> = {
  1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF',
  5: '#0000FF', 6: '#FF00FF', 7: '#FFFFFF', 8: '#808080',
  9: '#C0C0C0', 10: '#FF0000', 11: '#FF7F7F', 12: '#CC0000',
  13: '#CC6666', 14: '#990000', 15: '#994C4C',
};

export function aciToHex(index?: number): string | null {
  if (index === undefined || index === null) return null;
  return ACI_HEX[index] ?? null;
}

type Tag = { code: number; value: string };

interface DxfBlock {
  name: string;
  baseX: number;
  baseY: number;
  entities: DxfEntity[];
  inserts: RawInsert[];
}

interface RawInsert {
  blockName: string;
  layer: string;
  colorIndex?: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  rot: number; // degrees
}

const BULGE_SEGMENTS_PER_QUARTER = 4; // segments per 90° of bulge arc

@Injectable()
export class DxfParserService implements DrawingParserInterface {
  readonly supportedExtensions = ['dxf'];
  private readonly logger = new Logger(DxfParserService.name);

  async parse(filePath: string): Promise<DrawingParseResult> {
    const raw = fs.readFileSync(filePath);
    if (raw.length >= 4 && raw.toString('ascii', 0, 4) === 'AC10') {
      throw new Error(`File is a binary DWG (${raw.toString('ascii', 0, 6)}), not DXF. Upload as .dwg or re-export as ASCII DXF from AutoCAD.`);
    }
    const doc = this.parseContent(raw.toString('utf-8'));

    const entities: RawEntity[] = doc.entities.map((e) => this.toRawEntity(e)).concat(doc.extras);
    const bbox = this.computeBounds(doc);

    const page: ParsedPage = {
      pageNumber: 1,
      width: bbox.maxX - bbox.minX,
      height: bbox.maxY - bbox.minY,
      text: entities.filter((e) => e.text).map((e) => e.text).join(' '),
      entities,
    };

    this.logger.log(`DXF parsed: ${doc.layers.length} layers, ${entities.length} entities, units=${doc.units}`);
    return {
      pages: [page],
      layers: doc.layers.map((l) => ({ name: l.name, color: l.colorIndex })),
      extMin: { x: bbox.minX, y: bbox.minY },
      extMax: { x: bbox.maxX, y: bbox.maxY },
      metadata: { units: doc.units },
      parserVersion: 'dxf-ascii@2',
    };
  }

  /** Parse ASCII DXF content into the rich document model (INSERTs expanded). */
  parseContent(content: string): DxfDocument {
    const tags = this.tokenize(content);
    const doc: DxfDocument = { units: 'unknown', layers: [], entities: [], extras: [] };
    const blocks = new Map<string, DxfBlock>();

    let i = 0;
    while (i < tags.length) {
      const t = tags[i];
      if (t.code === 0 && t.value === 'SECTION') {
        const nameTag = tags[i + 1];
        const section = nameTag?.code === 2 ? nameTag.value : '';
        i += 2;
        if (section === 'HEADER') i = this.parseHeader(tags, i, doc);
        else if (section === 'TABLES') i = this.parseTables(tags, i, doc);
        else if (section === 'BLOCKS') i = this.parseBlocks(tags, i, blocks);
        else if (section === 'ENTITIES') i = this.parseEntities(tags, i, doc, blocks);
        else i = this.skipSection(tags, i);
      } else {
        i++;
      }
    }
    this.parseExtents(tags, doc);
    return doc;
  }

  // -------------------------------------------------------------------------
  // Tokenizer
  // -------------------------------------------------------------------------

  private tokenize(content: string): Tag[] {
    const lines = content.split(/\r?\n/);
    const tags: Tag[] = [];
    for (let j = 0; j + 1 < lines.length; j += 2) {
      const code = parseInt(lines[j].trim(), 10);
      if (Number.isNaN(code)) continue;
      tags.push({ code, value: lines[j + 1].trim() });
    }
    return tags;
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  private skipSection(tags: Tag[], i: number): number {
    while (i < tags.length && !(tags[i].code === 0 && tags[i].value === 'ENDSEC')) i++;
    return i + 1;
  }

  private parseHeader(tags: Tag[], i: number, doc: DxfDocument): number {
    while (i < tags.length && !(tags[i].code === 0 && tags[i].value === 'ENDSEC')) {
      if (tags[i].code === 9 && tags[i].value === '$INSUNITS') {
        const v = tags[i + 1];
        if (v?.code === 70) {
          const n = parseInt(v.value, 10);
          doc.units = n === 4 ? 'mm' : n === 6 ? 'm' : n === 1 ? 'inch' : 'unknown';
        }
      }
      i++;
    }
    return i + 1;
  }

  private parseExtents(tags: Tag[], doc: DxfDocument) {
    for (let i = 0; i < tags.length - 2; i++) {
      if (tags[i].code !== 9) continue;
      if (tags[i].value === '$EXTMIN') {
        doc.extMin = this.readPoint(tags, i + 1);
      } else if (tags[i].value === '$EXTMAX') {
        doc.extMax = this.readPoint(tags, i + 1);
      }
    }
  }

  private readPoint(tags: Tag[], i: number): { x: number; y: number } {
    let x = 0, y = 0;
    for (let j = i; j < Math.min(i + 4, tags.length); j++) {
      if (tags[j].code === 10) x = parseFloat(tags[j].value) || 0;
      if (tags[j].code === 20) y = parseFloat(tags[j].value) || 0;
    }
    return { x, y };
  }

  private parseTables(tags: Tag[], i: number, doc: DxfDocument): number {
    while (i < tags.length && !(tags[i].code === 0 && tags[i].value === 'ENDSEC')) {
      if (tags[i].code === 0 && tags[i].value === 'LAYER') {
        i++;
        let name = '0';
        let colorIndex: number | undefined;
        let sawName = false;
        while (i < tags.length && tags[i].code !== 0) {
          if (tags[i].code === 2) { name = tags[i].value; sawName = true; }
          if (tags[i].code === 62) colorIndex = Math.abs(parseInt(tags[i].value, 10)) || undefined;
          i++;
        }
        if (sawName) doc.layers.push({ name, colorIndex });
      } else {
        i++;
      }
    }
    return i + 1;
  }

  private parseBlocks(tags: Tag[], i: number, blocks: Map<string, DxfBlock>): number {
    while (i < tags.length && !(tags[i].code === 0 && tags[i].value === 'ENDSEC')) {
      if (tags[i].code === 0 && tags[i].value === 'BLOCK') {
        i++;
        const block: DxfBlock = { name: '', baseX: 0, baseY: 0, entities: [], inserts: [] };
        while (i < tags.length && tags[i].code !== 0) {
          if (tags[i].code === 2) block.name = tags[i].value;
          if (tags[i].code === 10) block.baseX = parseFloat(tags[i].value) || 0;
          if (tags[i].code === 20) block.baseY = parseFloat(tags[i].value) || 0;
          i++;
        }
        // block entities until ENDBLK
        while (i < tags.length && !(tags[i].code === 0 && (tags[i].value === 'ENDBLK' || tags[i].value === 'ENDSEC'))) {
          if (tags[i].code === 0) {
            const type = tags[i].value;
            const { entityTags, next } = this.collectEntityTags(tags, i + 1);
            if (type === 'INSERT') {
              const ins = this.readInsert(entityTags);
              if (ins) block.inserts.push(ins);
              i = next;
            } else if (type === 'POLYLINE') {
              const { entity, next: after } = this.readPolyline(tags, i + 1);
              if (entity) block.entities.push(entity);
              i = after;
            } else {
              const ent = this.buildEntity(type, entityTags);
              if (ent) block.entities.push(ent);
              i = next;
            }
          } else {
            i++;
          }
        }
        if (i < tags.length && tags[i].value === 'ENDBLK') {
          i++;
          while (i < tags.length && tags[i].code !== 0) i++; // skip ENDBLK attributes
        }
        if (block.name) blocks.set(block.name, block);
      } else {
        i++;
      }
    }
    return i + 1;
  }

  private parseEntities(tags: Tag[], i: number, doc: DxfDocument, blocks: Map<string, DxfBlock>): number {
    const sceneTypes = new Set(['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC', 'TEXT', 'MTEXT']);
    const extraTypes = new Set(['DIMENSION', 'LEADER', 'MULTILEADER', 'HATCH', 'VIEWPORT', 'SPLINE']);

    while (i < tags.length && !(tags[i].code === 0 && tags[i].value === 'ENDSEC')) {
      if (tags[i].code !== 0) { i++; continue; }
      const type = tags[i].value;

      if (type === 'POLYLINE') {
        const { entity, next } = this.readPolyline(tags, i + 1);
        if (entity) doc.entities.push(entity);
        i = next;
        continue;
      }

      const { entityTags, next } = this.collectEntityTags(tags, i + 1);
      if (sceneTypes.has(type)) {
        const ent = this.buildEntity(type, entityTags);
        if (ent) doc.entities.push(ent);
      } else if (type === 'INSERT') {
        const ins = this.readInsert(entityTags);
        if (ins) this.expandInsert(ins, blocks, doc.entities, new Set(), 0);
      } else if (extraTypes.has(type)) {
        doc.extras.push(this.genericRawEntity(type, entityTags));
      }
      i = next;
    }
    return i + 1;
  }

  /** Collect all tags of one entity (ordered, repeated codes preserved) until the next code-0. */
  private collectEntityTags(tags: Tag[], i: number): { entityTags: Tag[]; next: number } {
    const entityTags: Tag[] = [];
    while (i < tags.length && tags[i].code !== 0) {
      entityTags.push(tags[i]);
      i++;
    }
    return { entityTags, next: i };
  }

  // -------------------------------------------------------------------------
  // Entity builders (ordered-tag based — repeated group codes accumulate)
  // -------------------------------------------------------------------------

  private buildEntity(type: string, t: Tag[]): DxfEntity | null {
    switch (type) {
      case 'LINE': return this.readLine(t);
      case 'LWPOLYLINE': return this.readLwPolyline(t);
      case 'ARC': return this.readArc(t);
      case 'CIRCLE': return this.readCircle(t);
      case 'TEXT': return this.readText(t, false);
      case 'MTEXT': return this.readText(t, true);
      default: return null;
    }
  }

  private common(t: Tag[]): { layer: string; colorIndex?: number } {
    let layer = '0';
    let colorIndex: number | undefined;
    for (const tag of t) {
      if (tag.code === 8) layer = tag.value;
      if (tag.code === 62) {
        const n = parseInt(tag.value, 10);
        if (!Number.isNaN(n) && n > 0 && n < 256) colorIndex = n; // 0=BYBLOCK, 256=BYLAYER
      }
    }
    return { layer, colorIndex };
  }

  private num(t: Tag[], code: number, def = 0): number {
    const tag = t.find((x) => x.code === code);
    const v = tag ? parseFloat(tag.value) : NaN;
    return Number.isNaN(v) ? def : v;
  }

  private readLine(t: Tag[]): DxfEntity {
    return {
      kind: 'line', ...this.common(t),
      x1: this.num(t, 10), y1: this.num(t, 20),
      x2: this.num(t, 11), y2: this.num(t, 21),
    };
  }

  private readArc(t: Tag[]): DxfEntity {
    return {
      kind: 'arc', ...this.common(t),
      cx: this.num(t, 10), cy: this.num(t, 20), r: this.num(t, 40),
      a0: this.num(t, 50), a1: this.num(t, 51),
    };
  }

  private readCircle(t: Tag[]): DxfEntity {
    return {
      kind: 'circle', ...this.common(t),
      cx: this.num(t, 10), cy: this.num(t, 20), r: this.num(t, 40),
    };
  }

  private readText(t: Tag[], isMtext: boolean): DxfEntity | null {
    // MTEXT: content in code 3 (chunks) then code 1 (final). TEXT: code 1.
    let text = '';
    for (const tag of t) if (tag.code === 3) text += tag.value;
    for (const tag of t) if (tag.code === 1) text += tag.value;
    if (isMtext) text = this.stripMtextFormatting(text);
    text = this.decodeSpecialChars(text);
    if (!text) return null;
    return {
      kind: 'text', ...this.common(t),
      x: this.num(t, 10), y: this.num(t, 20),
      h: this.num(t, 40, 2.5), rot: this.num(t, 50, 0),
      text,
    };
  }

  private stripMtextFormatting(s: string): string {
    const ESC = '';
    return s
      .replace(/\\\\/g, ESC)                              // protect escaped backslash
      .replace(/\\P/g, ' ')                               // paragraph break
      .replace(/\\~/g, ' ')                               // non-breaking space
      .replace(/\\[ACcFfHhQTW][^;\\{}]*;/g, '')           // format codes with args
      .replace(/\\p[^;]*;/g, '')                          // paragraph props
      .replace(/\\[KkLlOo]/g, '')                         // toggle codes
      .replace(/[{}]/g, '')                             // grouping braces
      .replace(//g, '\\');
  }

  private decodeSpecialChars(s: string): string {
    return s.replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø').replace(/%%[pP]/g, '±').trim();
  }

  private readLwPolyline(t: Tag[]): DxfEntity | null {
    const { layer, colorIndex } = this.common(t);
    let closed = false;
    const verts: Array<{ x: number; y: number; bulge: number }> = [];
    for (const tag of t) {
      switch (tag.code) {
        case 70: closed = (parseInt(tag.value, 10) & 1) === 1; break;
        case 10: verts.push({ x: parseFloat(tag.value) || 0, y: 0, bulge: 0 }); break;
        case 20: if (verts.length) verts[verts.length - 1].y = parseFloat(tag.value) || 0; break;
        case 42: if (verts.length) verts[verts.length - 1].bulge = parseFloat(tag.value) || 0; break;
      }
    }
    if (verts.length < 2) return null;
    const pts = this.tessellate(verts, closed);
    return { kind: 'pline', layer, colorIndex, closed, pts };
  }

  /** POLYLINE + VERTEX* + SEQEND. Returns index after SEQEND. */
  private readPolyline(tags: Tag[], i: number): { entity: DxfEntity | null; next: number } {
    const { entityTags, next } = this.collectEntityTags(tags, i);
    const { layer, colorIndex } = this.common(entityTags);
    const flags = this.num(entityTags, 70, 0);
    const closed = (flags & 1) === 1;
    const verts: Array<{ x: number; y: number; bulge: number }> = [];

    let j = next;
    while (j < tags.length && tags[j].code === 0 && tags[j].value === 'VERTEX') {
      const { entityTags: vt, next: after } = this.collectEntityTags(tags, j + 1);
      verts.push({ x: this.num(vt, 10), y: this.num(vt, 20), bulge: this.num(vt, 42, 0) });
      j = after;
    }
    if (j < tags.length && tags[j].code === 0 && tags[j].value === 'SEQEND') {
      const { next: after } = this.collectEntityTags(tags, j + 1);
      j = after;
    }
    if (verts.length < 2) return { entity: null, next: j };
    return { entity: { kind: 'pline', layer, colorIndex, closed, pts: this.tessellate(verts, closed) }, next: j };
  }

  /** Flatten vertices with bulges into a point list [x,y,x,y,...]. */
  private tessellate(verts: Array<{ x: number; y: number; bulge: number }>, closed: boolean): number[] {
    const pts: number[] = [];
    const n = verts.length;
    const segCount = closed ? n : n - 1;
    pts.push(verts[0].x, verts[0].y);
    for (let s = 0; s < segCount; s++) {
      const a = verts[s];
      const b = verts[(s + 1) % n];
      if (a.bulge && Math.abs(a.bulge) > 1e-9) {
        for (const p of this.bulgeArcPoints(a, b, a.bulge)) pts.push(p.x, p.y);
      }
      if (!(closed && s === segCount - 1)) pts.push(b.x, b.y);
    }
    return pts;
  }

  /** Intermediate points (exclusive of endpoints) of a bulge arc from a → b. */
  private bulgeArcPoints(
    a: { x: number; y: number }, b: { x: number; y: number }, bulge: number,
  ): Array<{ x: number; y: number }> {
    const theta = 4 * Math.atan(bulge); // included angle, signed
    const dx = b.x - a.x, dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12) return [];
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // center: midpoint offset along perpendicular
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    const sign = bulge > 0 ? 1 : -1;
    // perpendicular to chord, direction depends on bulge sign and arc size
    const perpX = -dy / chord, perpY = dx / chord;
    const largeArc = Math.abs(theta) > Math.PI ? -1 : 1;
    const cx = mx - sign * largeArc * h * perpX;
    const cy = my - sign * largeArc * h * perpY;

    const startAngle = Math.atan2(a.y - cy, a.x - cx);
    const segments = Math.max(1, Math.ceil(Math.abs(theta) / (Math.PI / 2) * BULGE_SEGMENTS_PER_QUARTER));
    const out: Array<{ x: number; y: number }> = [];
    for (let k = 1; k < segments; k++) {
      const ang = startAngle + (theta * k) / segments;
      out.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // INSERT / block expansion
  // -------------------------------------------------------------------------

  private readInsert(t: Tag[]): RawInsert | null {
    const { layer, colorIndex } = this.common(t);
    const nameTag = t.find((x) => x.code === 2);
    if (!nameTag) return null;
    return {
      blockName: nameTag.value, layer, colorIndex,
      x: this.num(t, 10), y: this.num(t, 20),
      sx: this.num(t, 41, 1) || 1, sy: this.num(t, 42, 1) || 1,
      rot: this.num(t, 50, 0),
    };
  }

  private expandInsert(
    ins: RawInsert,
    blocks: Map<string, DxfBlock>,
    out: DxfEntity[],
    visiting: Set<string>,
    depth: number,
  ) {
    if (depth > 4 || visiting.has(ins.blockName)) return; // cycle / depth guard
    const block = blocks.get(ins.blockName);
    if (!block) return;
    visiting.add(ins.blockName);

    const rad = (ins.rot * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const uniformScale = Math.abs(ins.sx);
    const tx = (px: number, py: number): [number, number] => {
      const lx = (px - block.baseX) * ins.sx;
      const ly = (py - block.baseY) * ins.sy;
      return [ins.x + lx * cos - ly * sin, ins.y + lx * sin + ly * cos];
    };

    for (const e of block.entities) {
      const layer = e.layer === '0' ? ins.layer : e.layer;
      const colorIndex = e.colorIndex ?? ins.colorIndex;
      switch (e.kind) {
        case 'line': {
          const [x1, y1] = tx(e.x1, e.y1);
          const [x2, y2] = tx(e.x2, e.y2);
          out.push({ kind: 'line', layer, colorIndex, x1, y1, x2, y2 });
          break;
        }
        case 'pline': {
          const pts: number[] = [];
          for (let k = 0; k + 1 < e.pts.length; k += 2) {
            const [x, y] = tx(e.pts[k], e.pts[k + 1]);
            pts.push(x, y);
          }
          out.push({ kind: 'pline', layer, colorIndex, closed: e.closed, pts });
          break;
        }
        case 'arc': {
          const [cx, cy] = tx(e.cx, e.cy);
          // Non-uniform / mirrored scale approximated with uniform |sx|
          out.push({ kind: 'arc', layer, colorIndex, cx, cy, r: e.r * uniformScale, a0: e.a0 + ins.rot, a1: e.a1 + ins.rot });
          break;
        }
        case 'circle': {
          const [cx, cy] = tx(e.cx, e.cy);
          out.push({ kind: 'circle', layer, colorIndex, cx, cy, r: e.r * uniformScale });
          break;
        }
        case 'text': {
          const [x, y] = tx(e.x, e.y);
          out.push({ kind: 'text', layer, colorIndex, x, y, h: e.h * Math.abs(ins.sy), rot: e.rot + ins.rot, text: e.text });
          break;
        }
      }
    }

    for (const nested of block.inserts) {
      // transform nested insert origin into world space, compose scale/rotation
      const [nx, ny] = tx(nested.x, nested.y);
      this.expandInsert(
        { ...nested, x: nx, y: ny, sx: nested.sx * ins.sx, sy: nested.sy * ins.sy, rot: nested.rot + ins.rot },
        blocks, out, visiting, depth + 1,
      );
    }
    visiting.delete(ins.blockName);
  }

  // -------------------------------------------------------------------------
  // Mapping to legacy RawEntity (detection pipeline)
  // -------------------------------------------------------------------------

  private toRawEntity(e: DxfEntity): RawEntity {
    const color = e.colorIndex !== undefined ? String(e.colorIndex) : '';
    switch (e.kind) {
      case 'line':
        return { type: 'LINE', layer: e.layer, x: e.x1, y: e.y1, x2: e.x2, y2: e.y2, properties: { color } };
      case 'pline': {
        const vertices: number[][] = [];
        for (let k = 0; k + 1 < e.pts.length; k += 2) vertices.push([e.pts[k], e.pts[k + 1]]);
        return {
          type: 'LWPOLYLINE', layer: e.layer,
          x: e.pts[0] ?? 0, y: e.pts[1] ?? 0,
          x2: e.pts[e.pts.length - 2], y2: e.pts[e.pts.length - 1],
          vertices,
          properties: { color, closed: e.closed ? 1 : 0, vertexCount: vertices.length },
        };
      }
      case 'arc':
        return { type: 'ARC', layer: e.layer, x: e.cx, y: e.cy, radius: e.r, properties: { color, startAngle: e.a0, endAngle: e.a1 } };
      case 'circle':
        return { type: 'CIRCLE', layer: e.layer, x: e.cx, y: e.cy, radius: e.r, properties: { color } };
      case 'text':
        return { type: 'TEXT', layer: e.layer, x: e.x, y: e.y, text: e.text, properties: { color, height: e.h, rotation: e.rot } };
    }
  }

  private genericRawEntity(type: string, t: Tag[]): RawEntity {
    const g: Record<number, string> = {};
    for (const tag of t) if (g[tag.code] === undefined) g[tag.code] = tag.value;
    return {
      type,
      layer: g[8] ?? '0',
      x: parseFloat(g[10] ?? '0') || 0,
      y: parseFloat(g[20] ?? '0') || 0,
      x2: g[11] !== undefined ? parseFloat(g[11]) : undefined,
      y2: g[21] !== undefined ? parseFloat(g[21]) : undefined,
      radius: g[40] !== undefined ? parseFloat(g[40]) : undefined,
      text: g[1] ?? g[3],
      blockName: g[2],
      properties: { handle: g[5] ?? '', color: g[62] ?? '' },
    };
  }

  // -------------------------------------------------------------------------
  // Bounds
  // -------------------------------------------------------------------------

  computeBounds(doc: DxfDocument): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const e of doc.entities) {
      switch (e.kind) {
        case 'line': grow(e.x1, e.y1); grow(e.x2, e.y2); break;
        case 'pline': for (let k = 0; k + 1 < e.pts.length; k += 2) grow(e.pts[k], e.pts[k + 1]); break;
        case 'arc': case 'circle': grow(e.cx - e.r, e.cy - e.r); grow(e.cx + e.r, e.cy + e.r); break;
        case 'text': grow(e.x, e.y); break;
      }
    }
    if (!Number.isFinite(minX)) {
      const lo = doc.extMin ?? { x: 0, y: 0 };
      const hi = doc.extMax ?? { x: 1000, y: 1000 };
      return { minX: lo.x, minY: lo.y, maxX: hi.x, maxY: hi.y };
    }
    return { minX, minY, maxX, maxY };
  }
}
