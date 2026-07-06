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
  | 'layer_override'  // per-project user rule (Tier 2) — highest priority
  | 'layer_map'       // layer name matched LAYER_TYPE_MAP
  | 'label_pattern'   // text label matched regex
  | 'aspect_ratio'    // bounding box ratio heuristic
  | 'geometry'        // shape heuristic (layer-independent, multi-candidate)
  | 'topology'        // spatial-relation refinement (Tier 2.5)
  | 'entity_type'     // DXF entity type fallback
  | 'none';           // unclassified

/** Per-project layer→type override (Tier 2). Undefined discriminator = match any. */
export interface LayerOverride {
  layer: string;      // upper-cased layer name
  color?: number;     // optional ACI discriminator
  lineType?: string;  // optional linetype-name discriminator (upper-cased)
  type: string;       // target type, or 'ignored'
}

// Built-in overrides that always apply. DEFPOINTS is AutoCAD's non-plotting
// dimension-definition layer — never a real object, must be excluded from BOQ.
const BUILTIN_OVERRIDES: LayerOverride[] = [{ layer: 'DEFPOINTS', type: 'ignored' }];

/** One weighted hypothesis. Geometry rules emit several; deterministic rules emit one. */
export interface Candidate {
  type: string;
  prob: number; // 0..1, distribution over the coarse class (not required to sum to 1)
}

export interface DetectionResult {
  objectType: string;   // argmax(candidates) — convenience only, NOT a committed answer for geometry guesses
  confidence: number;   // prob of the top candidate
  candidates: Candidate[];
  ambiguous: boolean;   // true when top-2 candidates are close → must NOT auto-count into BOQ
  matchedRule: DetectionRule;
  reason: string;       // human-readable explanation — used by Explain AI
  fallback: boolean;    // true if result is a best-effort guess
}

export interface DetectedObject extends NormalizedObject {
  detection: DetectionResult;
  // Convenience aliases kept for pipeline compatibility
  objectType: string;
  confidence: number;
  candidates: Candidate[];
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

  detect(objects: NormalizedObject[], overrides: LayerOverride[] = []): DetectedObject[] {
    const stats = this.computeStats(objects);
    const overrideMap = this.buildOverrideMap(overrides);
    const detected = objects.map((obj) => {
      const detection = this.classify(obj, stats, overrideMap);
      const floor = this.inferFloor(obj);
      return {
        ...obj,
        floor: floor ?? obj.floor,
        detection,
        objectType: detection.objectType,
        confidence: detection.confidence,
        candidates: detection.candidates,
      };
    });
    // Tier 2.5 — resolve ambiguous objects from spatial context (in-place).
    this.refineByTopology(detected);
    return detected;
  }

  /** Index overrides by layer|color|lineType for O(1) lookup; built-ins first, user rules win. */
  private buildOverrideMap(overrides: LayerOverride[]): Map<string, LayerOverride> {
    const map = new Map<string, LayerOverride>();
    for (const o of [...BUILTIN_OVERRIDES, ...overrides]) {
      const layer = o.layer.toUpperCase();
      const lt = o.lineType ? o.lineType.toUpperCase() : '*';
      map.set(`${layer}|${o.color ?? '*'}|${lt}`, { ...o, layer });
    }
    return map;
  }

  /** Match an object: most-specific fingerprint (color+linetype) first, widening to any. */
  private matchOverride(obj: NormalizedObject, map: Map<string, LayerOverride>): LayerOverride | undefined {
    const layer = obj.layer.toUpperCase();
    const props = obj.properties ?? {};
    const rawColor = props.colorIndex ?? props.color;
    const color = typeof rawColor === 'number' ? rawColor : parseInt(String(rawColor), 10);
    const c = Number.isFinite(color) ? String(color) : '*';
    const lt = typeof props.lineType === 'string' && props.lineType.trim() ? props.lineType.trim().toUpperCase() : '*';
    // Specificity order: color+linetype → color → linetype → any.
    for (const key of [`${layer}|${c}|${lt}`, `${layer}|${c}|*`, `${layer}|*|${lt}`, `${layer}|*|*`]) {
      const hit = map.get(key);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Build a result from a hypothesis distribution: sort, pick argmax, flag ambiguity. */
  private result(candidates: Candidate[], rule: DetectionRule, reason: string, fallback: boolean): DetectionResult {
    const sorted = candidates.filter((c) => c.prob > 0).sort((a, b) => b.prob - a.prob);
    if (sorted.length === 0) {
      return { objectType: 'unknown', confidence: 0, candidates: [], ambiguous: false, matchedRule: 'none', reason, fallback: true };
    }
    const [top, second] = sorted;
    // Close top-2 → ambiguous: geometry cannot decide, so downstream must not auto-count into BOQ.
    const ambiguous = !!second && top.prob - second.prob < 0.15;
    // confidence is schema-capped at 1 (topology boosts can push a candidate prob above 1).
    return { objectType: top.type, confidence: Math.min(top.prob, 0.99), candidates: sorted, ambiguous, matchedRule: rule, reason, fallback };
  }

  /** Deterministic single-hypothesis rule (layer/label/entity). */
  private single(type: string, prob: number, rule: DetectionRule, reason: string, fallback: boolean): DetectionResult {
    return this.result([{ type, prob }], rule, reason, fallback);
  }

  /**
   * Dataset-relative scale so geometry rules stay unit-agnostic (mm vs m vs inch).
   * Area is measured only on closed polygons (real footprints); tiny noise entities
   * naturally fall below the median so they don't skew "large vs small" comparisons.
   */
  private computeStats(objects: NormalizedObject[]): { medianArea: number; medianLength: number } {
    const areas: number[] = [];
    const lengths: number[] = [];
    for (const obj of objects) {
      const g = this.geometryOf(obj);
      if (g.area > 0) areas.push(g.area);
      if (g.length > 0) lengths.push(g.length);
    }
    return { medianArea: median(areas), medianLength: median(lengths) };
  }

  /** Length, area, closedness and rectangularity from geometry (fallback bbox). */
  private geometryOf(obj: NormalizedObject): {
    length: number; area: number; closed: boolean; rectangularity: number; aspect: number; points: number;
  } {
    const geo = obj.geometry ?? [];
    const { w, h } = obj.boundingBox;
    const points = geo.length;
    let length = 0;
    for (let i = 1; i < points; i++) {
      length += Math.hypot(geo[i][0] - geo[i - 1][0], geo[i][1] - geo[i - 1][1]);
    }
    if (points < 2) length = Math.max(w, h);

    let area = 0;
    if (points >= 3) {
      let a = 0;
      for (let i = 0, j = points - 1; i < points; j = i++) {
        a += (geo[j][0] + geo[i][0]) * (geo[j][1] - geo[i][1]);
      }
      area = Math.abs(a) / 2;
    }
    // closed when first ~ last point relative to perimeter
    const closed =
      points >= 3 &&
      Math.hypot(geo[0][0] - geo[points - 1][0], geo[0][1] - geo[points - 1][1]) < 0.02 * (length || 1);
    if (!closed) area = 0;

    const bboxArea = w * h;
    const rectangularity = bboxArea > 0 && area > 0 ? area / bboxArea : 0;
    const aspect = w > 0 && h > 0 ? Math.max(w, h) / Math.min(w, h) : 1;
    return { length, area, closed, rectangularity, aspect, points };
  }

  private classify(
    obj: NormalizedObject,
    stats?: { medianArea: number; medianLength: number },
    overrides?: Map<string, LayerOverride>,
  ): DetectionResult {
    // 0. Per-project layer override (Tier 2) — user truth beats every heuristic.
    if (overrides?.size) {
      const ov = this.matchOverride(obj, overrides);
      if (ov) {
        const via = ov.color != null ? `${ov.layer} (color ${ov.color})` : ov.layer;
        return this.single(ov.type, 0.98, 'layer_override', `Project rule: layer "${via}" → ${ov.type}`, false);
      }
    }

    // 1. Layer name — exact, prefix, or suffix match (case-insensitive)
    const layerUpper = obj.layer.toUpperCase();
    for (const [key, type] of Object.entries(LAYER_TYPE_MAP)) {
      const k = key.toUpperCase();
      if (layerUpper === k || layerUpper.startsWith(k + '-') || layerUpper.endsWith('-' + k) || layerUpper.includes('-' + k + '-')) {
        return this.single(type, 0.95, 'layer_map', `Layer "${obj.layer}" matched rule "${key}" → ${type}`, false);
      }
    }

    // 2. Label text pattern
    if (obj.text && typeof obj.text === 'string') {
      for (const { pattern, type, hint } of LABEL_PATTERNS) {
        if (pattern.test(obj.text.trim())) {
          return this.single(type, 0.85, 'label_pattern', `${hint} (text: "${obj.text}")`, false);
        }
      }
    }

    // 3. Geometry / topology — layer-independent hypotheses (multi-candidate, never a hard type)
    if (stats) {
      const geometryGuess = this.classifyByGeometry(obj, stats);
      if (geometryGuess) return geometryGuess;
    }

    // 4. DXF entity type fallback
    const fallbackType = ENTITY_TYPE_MAP[obj.rawType];
    if (fallbackType) {
      return this.single(fallbackType, 0.5, 'entity_type', `DXF entity type ${obj.rawType} → ${fallbackType}`, true);
    }

    return this.single('unknown', 0, 'none', 'No matching rule found', true);
  }

  /**
   * Shape-based hypotheses when layer/label give nothing. Geometry alone CANNOT decide
   * a single type — a long rectangle may be beam / wall / slab-strip / footing-strip /
   * ramp; a circle may be column / pile / footing / symbol. So this emits a candidate
   * DISTRIBUTION (fallback:true) for Tier 2 (layer/CAD fingerprint), Tier 2.5 (topology)
   * or Tier 3 (LLM) to resolve. Uses dataset-relative scale (median) → unit-agnostic.
   */
  private classifyByGeometry(
    obj: NormalizedObject,
    stats: { medianArea: number; medianLength: number },
  ): DetectionResult | null {
    const rawType = obj.rawType.toUpperCase();
    const g = this.geometryOf(obj);
    const rel = (v: number, base: number) => v / (base || 1);

    // Radial (circle/arc): could be column, pile, footing or a symbol
    if (rawType === 'CIRCLE' || rawType === 'ARC') {
      const small = g.area > 0 && g.area < stats.medianArea;
      const cands = small
        ? [{ type: 'symbol', prob: 0.35 }, { type: 'pile', prob: 0.3 }, { type: 'column', prob: 0.2 }, { type: 'footing', prob: 0.15 }]
        : [{ type: 'column', prob: 0.35 }, { type: 'footing', prob: 0.3 }, { type: 'pile', prob: 0.2 }, { type: 'symbol', prob: 0.15 }];
      return this.result(cands, 'geometry', `Radial ${rawType} (${small ? 'small' : 'large'}) — column/pile/footing/symbol candidates`, true);
    }

    // Degenerate / noise: tiny footprint relative to dataset → marker/symbol
    if (g.area > 0 && g.area < stats.medianArea * 0.01 && g.length < stats.medianLength * 0.05) {
      return this.result(
        [{ type: 'symbol', prob: 0.7 }, { type: 'polyline', prob: 0.3 }],
        'geometry',
        `Very small element (relative area ${rel(g.area, stats.medianArea).toFixed(3)}) → marker/symbol`,
        true,
      );
    }

    // Closed rectangle → distinguish only linear vs planar; NOT the semantic type
    if (g.closed && g.rectangularity > 0.6) {
      if (g.aspect >= 4) {
        // Linear rectangular object — genuinely ambiguous family
        return this.result(
          [
            { type: 'beam', prob: 0.34 },
            { type: 'wall', prob: 0.3 },
            { type: 'slab', prob: 0.14 }, // dải sàn
            { type: 'footing', prob: 0.12 }, // móng băng
            { type: 'ramp', prob: 0.1 },
          ],
          'geometry',
          `Linear rectangular object (aspect ${g.aspect.toFixed(1)}) — beam/wall/slab-strip/footing/ramp candidates`,
          true,
        );
      }
      const large = g.area >= stats.medianArea;
      return large
        ? this.result(
            [{ type: 'slab', prob: 0.5 }, { type: 'roof', prob: 0.2 }, { type: 'footing', prob: 0.18 }, { type: 'opening', prob: 0.12 }],
            'geometry',
            `Large closed polygon (area ${rel(g.area, stats.medianArea).toFixed(1)}× median) — slab/roof/footing candidates`,
            true,
          )
        : this.result(
            [{ type: 'column', prob: 0.38 }, { type: 'footing', prob: 0.25 }, { type: 'pile', prob: 0.2 }, { type: 'symbol', prob: 0.17 }],
            'geometry',
            `Compact closed polygon (aspect ${g.aspect.toFixed(1)}) — column/footing/pile candidates`,
            true,
          );
    }

    // Open long straight polyline → axis / grid line (or a wall centreline)
    if (!g.closed && g.points <= 3 && g.length >= stats.medianLength) {
      return this.result(
        [{ type: 'axis', prob: 0.55 }, { type: 'wall', prob: 0.28 }, { type: 'polyline', prob: 0.17 }],
        'geometry',
        `Long straight open line (length ${rel(g.length, stats.medianLength).toFixed(1)}× median) → axis/grid or wall centreline`,
        true,
      );
    }

    // Any other polyline with real extent → still better than unknown, but low & spread
    if (g.length > 0) {
      return this.result(
        [{ type: 'polyline', prob: 0.5 }, { type: 'wall', prob: 0.2 }, { type: 'axis', prob: 0.16 }, { type: 'beam', prob: 0.14 }],
        'geometry',
        'Open/irregular polyline — shape inconclusive',
        true,
      );
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Tier 2.5 — topology / spatial-context refinement
  // ---------------------------------------------------------------------------

  /**
   * Re-weight candidates of AMBIGUOUS objects using confidently-classified
   * neighbours (walls, columns, footings). Unit-agnostic: uses each anchor's own
   * bbox as the tolerance, never absolute distances. Boosts existing hypotheses —
   * never forces a type — so a wrong anchor can't fabricate a confident answer.
   */
  private refineByTopology(objects: DetectedObject[]): void {
    const targets = objects.filter((o) => o.detection.ambiguous);
    if (!targets.length) return;

    const isAnchor = (o: DetectedObject) => !o.detection.ambiguous && o.confidence >= 0.7;
    const verticals = objects.filter((o) => isAnchor(o) && ['column', 'footing', 'pile'].includes(o.objectType));
    const walls = objects.filter((o) => isAnchor(o) && o.objectType === 'wall');
    if (!verticals.length && !walls.length) return;

    const vGrid = this.buildGrid(verticals);
    const wGrid = this.buildGrid(walls);

    for (const o of targets) {
      const cands = o.detection.candidates;
      const has = (t: string) => cands.some((c) => c.type === t);

      // (a) Linear element whose two endpoints rest on verticals → structural beam.
      if ((has('beam') || has('wall')) && o.geometry.length >= 2) {
        const p0 = o.geometry[0];
        const p1 = o.geometry[o.geometry.length - 1];
        if (p0 && p1 && vGrid.hits(p0) && vGrid.hits(p1)) {
          this.applyBoost(o, 'beam', 2.2, 'Endpoints rest on columns → spans between supports');
          continue;
        }
      }

      // (b) Compact/short element embedded in a wall run → opening (door/window/lỗ mở).
      const linear = has('beam') || has('wall');
      if (!linear && wGrid.overlaps(o.boundingBox)) {
        this.applyBoost(o, 'opening', 1.8, 'Embedded in a wall run → opening (door/window)', true);
      }
    }
  }

  /** Bucket anchors into a uniform grid sized from their median extent for O(1) neighbour lookup. */
  private buildGrid(anchors: DetectedObject[]) {
    const sizes = anchors.map((a) => Math.max(a.boundingBox.w, a.boundingBox.h)).filter((v) => v > 0);
    const cell = Math.max(median(sizes) * 2, 1e-6);
    const grid = new Map<string, DetectedObject[]>();
    const key = (cx: number, cy: number) => `${cx}:${cy}`;
    for (const a of anchors) {
      const { x, y, w, h } = a.boundingBox;
      for (let cx = Math.floor(x / cell); cx <= Math.floor((x + w) / cell); cx++) {
        for (let cy = Math.floor(y / cell); cy <= Math.floor((y + h) / cell); cy++) {
          const k = key(cx, cy);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(a);
        }
      }
    }
    const near = (px: number, py: number): DetectedObject[] => {
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
      const out: DetectedObject[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(key(cx + dx, cy + dy));
        if (bucket) out.push(...bucket);
      }
      return out;
    };
    return {
      // A point "hits" an anchor if it falls inside the anchor bbox grown by 25% of its size.
      hits: (p: number[]) =>
        near(p[0], p[1]).some((a) => pointInBbox(p[0], p[1], a.boundingBox, 0.25)),
      // A bbox "overlaps" an anchor if their AABBs intersect.
      overlaps: (bb: { x: number; y: number; w: number; h: number }) =>
        near(bb.x + bb.w / 2, bb.y + bb.h / 2).some((a) => bboxOverlap(bb, a.boundingBox)),
    };
  }

  /**
   * Multiply the matched candidate's probability (or inject it) and re-derive the
   * result. Keeps fallback:true — topology strengthens a guess, it is not ground truth.
   */
  private applyBoost(o: DetectedObject, type: string, factor: number, reason: string, allowInject = false): void {
    const cands = o.detection.candidates.map((c) => ({ ...c }));
    const hit = cands.find((c) => c.type === type);
    if (hit) hit.prob *= factor;
    else if (allowInject) cands.push({ type, prob: 0.55 }); // strong enough to lead when topology is decisive
    else return;

    const refined = this.result(cands, 'topology', `${o.detection.reason} · Topology: ${reason}`, true);
    o.detection = refined;
    o.objectType = refined.objectType;
    o.confidence = refined.confidence;
    o.candidates = refined.candidates;
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Box = { x: number; y: number; w: number; h: number };

/** Point inside bbox grown by `margin` × its size on each side (unit-agnostic tolerance). */
function pointInBbox(px: number, py: number, b: Box, margin: number): boolean {
  const mx = b.w * margin, my = b.h * margin;
  return px >= b.x - mx && px <= b.x + b.w + mx && py >= b.y - my && py <= b.y + b.h + my;
}

/** Axis-aligned bbox intersection test. */
function bboxOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
