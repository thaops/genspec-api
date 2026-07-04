import { Injectable } from '@nestjs/common';
import { DxfDocument, DxfEntity, aciToHex } from '../parsers/dxf-parser.service';

// ---------------------------------------------------------------------------
// Scene contract v1 — FE renders this directly. DO NOT change shape.
// ---------------------------------------------------------------------------

export type SceneEntity =
  | { t: 'line'; layer: string; color: string | null; p: [number, number, number, number] }
  | { t: 'pline'; layer: string; color: string | null; closed: boolean; pts: number[] }
  | { t: 'arc'; layer: string; color: string | null; cx: number; cy: number; r: number; a0: number; a1: number }
  | { t: 'circle'; layer: string; color: string | null; cx: number; cy: number; r: number }
  | { t: 'text'; layer: string; color: string | null; x: number; y: number; h: number; rot: number; s: string };

export interface DrawingScene {
  version: 1;
  units: 'mm' | 'm' | 'inch' | 'unknown';
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  layers: Array<{ name: string; color: string | null; entityCount: number }>;
  entities: SceneEntity[];
  truncated?: boolean;
}

export const SCENE_MAX_ENTITIES = 60_000;

@Injectable()
export class SceneBuilderService {
  /**
   * Pure transform: DxfDocument → Scene contract v1.
   * Y axis stays in CAD coordinates (Y up) — FE flips.
   */
  build(doc: DxfDocument, maxEntities = SCENE_MAX_ENTITIES): DrawingScene {
    const layerColor = new Map<string, number | undefined>();
    for (const l of doc.layers) layerColor.set(l.name, l.colorIndex);

    const resolveColor = (e: DxfEntity): string | null => {
      const idx = e.colorIndex ?? layerColor.get(e.layer);
      return aciToHex(idx);
    };

    // Priority when capping: lines/plines first, then arcs/circles/text
    const primary: SceneEntity[] = [];
    const secondary: SceneEntity[] = [];
    for (const e of doc.entities) {
      const color = resolveColor(e);
      switch (e.kind) {
        case 'line':
          primary.push({ t: 'line', layer: e.layer, color, p: [e.x1, e.y1, e.x2, e.y2] });
          break;
        case 'pline':
          primary.push({ t: 'pline', layer: e.layer, color, closed: e.closed, pts: e.pts });
          break;
        case 'arc':
          secondary.push({ t: 'arc', layer: e.layer, color, cx: e.cx, cy: e.cy, r: e.r, a0: e.a0, a1: e.a1 });
          break;
        case 'circle':
          secondary.push({ t: 'circle', layer: e.layer, color, cx: e.cx, cy: e.cy, r: e.r });
          break;
        case 'text': {
          // Defensive: never let a non-string reach FE ("[object Object]")
          const raw: unknown = e.text;
          const s = typeof raw === 'string'
            ? raw
            : raw !== null && typeof raw === 'object'
              ? String((raw as any).text ?? (raw as any).value ?? '')
              : raw === null || raw === undefined ? '' : String(raw);
          if (s) secondary.push({ t: 'text', layer: e.layer, color, x: e.x, y: e.y, h: e.h, rot: e.rot, s });
          break;
        }
      }
    }

    const total = primary.length + secondary.length;
    let entities: SceneEntity[];
    let truncated = false;
    if (total > maxEntities) {
      truncated = true;
      entities = primary.slice(0, maxEntities);
      if (entities.length < maxEntities) {
        entities = entities.concat(secondary.slice(0, maxEntities - entities.length));
      }
    } else {
      entities = primary.concat(secondary);
    }

    // Layer entity counts (of entities actually included)
    const counts = new Map<string, number>();
    for (const e of entities) counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
    const layerNames = new Set<string>(doc.layers.map((l) => l.name));
    for (const name of counts.keys()) layerNames.add(name);
    const layers = Array.from(layerNames).map((name) => ({
      name,
      color: aciToHex(layerColor.get(name)),
      entityCount: counts.get(name) ?? 0,
    }));

    const bbox = this.bboxOf(entities, doc);

    const scene: DrawingScene = {
      version: 1,
      units: doc.units,
      bbox,
      layers,
      entities,
    };
    if (truncated) scene.truncated = true;
    return scene;
  }

  private bboxOf(entities: SceneEntity[], doc: DxfDocument): DrawingScene['bbox'] {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const e of entities) {
      switch (e.t) {
        case 'line': grow(e.p[0], e.p[1]); grow(e.p[2], e.p[3]); break;
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
