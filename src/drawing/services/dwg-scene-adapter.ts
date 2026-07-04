/**
 * Pure adapter: DwgParserService result (libredwg-web WASM) → DxfDocument,
 * which SceneBuilderService turns into scene contract v1.
 *
 * Angle units: libredwg-web returns RADIANS (its own svgConverter does
 * `rotation * 180/PI`). Scene contract uses DEGREES → converted here.
 *
 * INSERT: block definitions come from db.tables.BLOCK_RECORD (exposed by
 * DwgParserService in metadata.blocks). If the referenced block exists,
 * entities are expanded ONE level (scale/rotate/translate). Nested INSERTs
 * inside a block, and missing blocks, degrade to a marker: small circle
 * (~0.5% of drawing diagonal) + block name text at the insertion point.
 */
import type { DrawingParseResult, RawEntity } from '../parsers/drawing-parser.interface';
import type { DwgBlockDef } from '../parsers/dwg-parser.service';
import { coerceDwgText } from '../parsers/dwg-parser.service';
import type { DxfDocument, DxfEntity, DxfUnits } from '../parsers/dxf-parser.service';

const RAD2DEG = 180 / Math.PI;

export interface DwgAdaptResult {
  doc: DxfDocument;
  /** Entity types not representable in scene v1 (counts, for logging). */
  dropped: Record<string, number>;
}

type Affine = (x: number, y: number) => [number, number];

function num(v: unknown, d = 0): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && isFinite(n) ? n : d;
}

/** colorIndex 0 (ByBlock) / 256 (ByLayer) → undefined so layer color resolves. */
function colorOf(e: RawEntity): number | undefined {
  const idx = num(e.properties?.colorIndex, 256);
  return idx > 0 && idx < 256 ? idx : undefined;
}

function mapUnits(insunits: unknown): DxfUnits {
  switch (num(insunits, -1)) {
    case 4: return 'mm';
    case 6: return 'm';
    case 1: return 'inch';
    default: return 'unknown';
  }
}

export function adaptDwgToDxfDocument(result: DrawingParseResult): DwgAdaptResult {
  const dropped: Record<string, number> = {};
  const drop = (type: string) => { dropped[type] = (dropped[type] ?? 0) + 1; };

  const blocks = (result.metadata?.blocks ?? {}) as Record<string, DwgBlockDef>;
  const diag = Math.hypot(
    result.extMax.x - result.extMin.x,
    result.extMax.y - result.extMin.y,
  );
  const markerR = Math.max(diag * 0.005, 1e-6);

  const entities: DxfEntity[] = [];
  const identity: Affine = (x, y) => [x, y];

  const rawEntities = result.pages.flatMap((p) => p.entities);
  for (const e of rawEntities) {
    convertEntity(e, identity, 1, 0, entities, drop, blocks, markerR, true);
  }

  return {
    doc: {
      units: mapUnits(result.metadata?.insunits),
      layers: result.layers.map((l) => ({ name: l.name, colorIndex: l.color })),
      entities,
      extras: [],
      extMin: result.extMin,
      extMax: result.extMax,
    },
    dropped,
  };
}

/**
 * Convert one RawEntity → scene entities, applying `tf` (block transform),
 * `scaleMag` (avg |scale| for radii/text height) and `rotDeg` (added to angles).
 */
function convertEntity(
  e: RawEntity,
  tf: Affine,
  scaleMag: number,
  rotDeg: number,
  out: DxfEntity[],
  drop: (t: string) => void,
  blocks: Record<string, DwgBlockDef>,
  markerR: number,
  allowExpand: boolean,
): void {
  const layer = e.layer ?? '0';
  const colorIndex = colorOf(e);

  const pushPline = (pts: number[][], closed: boolean) => {
    if (pts.length < 2) return;
    const flat: number[] = [];
    for (const [x, y] of pts) {
      const [tx, ty] = tf(x, y);
      flat.push(tx, ty);
    }
    out.push({ kind: 'pline', layer, colorIndex, closed, pts: flat });
  };

  const pushText = (x: number, y: number, raw: unknown, h: number, rot: number) => {
    const s = coerceDwgText(raw);
    if (!s) return;
    const [tx, ty] = tf(x, y);
    out.push({ kind: 'text', layer, colorIndex, x: tx, y: ty, h: h * scaleMag, rot, text: s });
  };

  switch (e.type) {
    case 'LINE': {
      // LEADER/MLEADER were mapped to type LINE with a vertices polyline
      if (e.vertices && e.vertices.length >= 2) { pushPline(e.vertices, false); return; }
      if (e.x2 === undefined || e.y2 === undefined) return;
      const [x1, y1] = tf(e.x, e.y);
      const [x2, y2] = tf(e.x2, e.y2);
      out.push({ kind: 'line', layer, colorIndex, x1, y1, x2, y2 });
      return;
    }

    case 'LWPOLYLINE': {
      const verts = e.vertices ?? [];
      if (verts.length < 2) { drop('LWPOLYLINE_EMPTY'); return; }
      const first = verts[0], last = verts[verts.length - 1];
      const closed = verts.length > 2 && first[0] === last[0] && first[1] === last[1];
      pushPline(closed ? verts.slice(0, -1) : verts, closed);
      return;
    }

    case 'ARC': {
      const [cx, cy] = tf(e.x, e.y);
      const a0 = num(e.properties?.startAngle) * RAD2DEG + rotDeg; // radians → degrees
      const a1 = num(e.properties?.endAngle) * RAD2DEG + rotDeg;
      out.push({ kind: 'arc', layer, colorIndex, cx, cy, r: num(e.radius) * scaleMag, a0, a1 });
      return;
    }

    case 'CIRCLE': {
      const [cx, cy] = tf(e.x, e.y);
      out.push({ kind: 'circle', layer, colorIndex, cx, cy, r: num(e.radius) * scaleMag });
      return;
    }

    case 'ELLIPSE': {
      // Approximate as circle with major radius — better than dropping
      const [cx, cy] = tf(e.x, e.y);
      const r = num(e.radius) * scaleMag;
      if (r > 0) out.push({ kind: 'circle', layer, colorIndex, cx, cy, r });
      else drop('ELLIPSE');
      return;
    }

    case 'TEXT':
    case 'MTEXT': {
      pushText(e.x, e.y, e.text,
        num(e.properties?.textHeight),
        num(e.properties?.rotation) * RAD2DEG + rotDeg);
      return;
    }

    case 'DIMENSION': {
      if (e.vertices && e.vertices.length >= 2) pushPline(e.vertices, false);
      pushText(e.x, e.y, e.text, num(e.properties?.textHeight), 0);
      return;
    }

    case 'HATCH': {
      // boundary loops flattened by parser — render as thin closed pline so the
      // hatched region is visible (definition lines intentionally dropped)
      const verts = e.vertices ?? [];
      if (verts.length >= 3) pushPline(verts, true);
      else drop('HATCH_EMPTY');
      return;
    }

    case 'INSERT': {
      const name = String(e.blockName ?? e.properties?.blockName ?? '');
      const def = blocks[name];
      if (def && allowExpand) {
        const sx = num(e.properties?.scaleX, 1) || 1;
        const sy = num(e.properties?.scaleY, 1) || 1;
        const rot = num(e.properties?.rotation); // radians
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const [ix, iy] = tf(e.x, e.y);
        const bx = def.basePoint.x, by = def.basePoint.y;
        const child: Affine = (x, y) => {
          const lx = (x - bx) * sx, ly = (y - by) * sy;
          return [ix + lx * cos - ly * sin, iy + lx * sin + ly * cos];
        };
        const childMag = scaleMag * (Math.abs(sx) + Math.abs(sy)) / 2;
        const childRot = rotDeg + rot * RAD2DEG;
        for (const be of def.entities) {
          // one-level expansion only: nested INSERT degrades to marker
          convertEntity(be, child, childMag, childRot, out, drop, blocks, markerR, false);
        }
      } else {
        // No definition (or nested) → marker so user still sees position
        const [cx, cy] = tf(e.x, e.y);
        out.push({ kind: 'circle', layer, colorIndex, cx, cy, r: markerR * scaleMag });
        if (name) out.push({ kind: 'text', layer, colorIndex, x: cx + markerR * 1.2, y: cy, h: markerR * scaleMag, rot: 0, text: name });
        if (def && !allowExpand) drop('INSERT_NESTED');
      }
      return;
    }

    default:
      drop(e.type ?? 'UNKNOWN');
  }
}
