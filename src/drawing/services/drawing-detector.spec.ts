import { DrawingDetectorService, LayerOverride, NormalizedObject } from './drawing-detector.service';

// Minimal NormalizedObject builder for detector unit tests.
function obj(p: Partial<NormalizedObject> & { layer: string; stableId: string }): NormalizedObject {
  const w = p.boundingBox?.w ?? 10;
  const h = p.boundingBox?.h ?? 10;
  return {
    stableId: p.stableId,
    rawType: p.rawType ?? 'LWPOLYLINE',
    layer: p.layer,
    boundingBox: p.boundingBox ?? { x: 0, y: 0, w, h },
    geometry: p.geometry ?? [],
    properties: p.properties ?? {},
    text: p.text,
  } as NormalizedObject;
}

// A closed rectangle polygon at (x,y) size w×h.
function rect(x: number, y: number, w: number, h: number): number[][] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
}

describe('DrawingDetectorService — tier behaviour', () => {
  const svc = new DrawingDetectorService();

  it('Tier 1: unknown-layer elongated rectangle → ambiguous candidate distribution, not a hard type', () => {
    const bb = { x: 0, y: 0, w: 4000, h: 200 };
    const [d] = svc.detect([obj({ stableId: 'a', layer: 'RANDOM', boundingBox: bb, geometry: rect(0, 0, 4000, 200) })]);
    expect(d.detection.matchedRule).toBe('geometry');
    expect(d.detection.ambiguous).toBe(true);
    expect(d.candidates.length).toBeGreaterThan(1);
    // beam & wall both present, neither dominates
    const types = d.candidates.map((c) => c.type);
    expect(types).toContain('beam');
    expect(types).toContain('wall');
  });

  it('Tier 2: layer override wins with high confidence and clears ambiguity', () => {
    const overrides: LayerOverride[] = [{ layer: 'MANH', type: 'wall' }];
    const [d] = svc.detect([obj({ stableId: 'a', layer: 'MANH', geometry: rect(0, 0, 4000, 200), boundingBox: { x: 0, y: 0, w: 4000, h: 200 } })], overrides);
    expect(d.detection.matchedRule).toBe('layer_override');
    expect(d.objectType).toBe('wall');
    expect(d.confidence).toBeGreaterThanOrEqual(0.95);
    expect(d.detection.ambiguous).toBe(false);
  });

  it('Tier 2 fingerprint: same layer, different linetype → different type', () => {
    const overrides: LayerOverride[] = [
      { layer: 'W', lineType: 'DASHED', type: 'opening' },
      { layer: 'W', type: 'wall' },
    ];
    const solid = obj({ stableId: 's', layer: 'W', geometry: rect(0, 0, 3000, 200), boundingBox: { x: 0, y: 0, w: 3000, h: 200 } });
    const dashed = obj({ stableId: 'd', layer: 'W', properties: { lineType: 'DASHED' }, geometry: rect(0, 0, 3000, 200), boundingBox: { x: 0, y: 0, w: 3000, h: 200 } });
    const [ds, dd] = svc.detect([solid, dashed], overrides);
    expect(ds.objectType).toBe('wall');
    expect(dd.objectType).toBe('opening');
  });

  it('built-in: DEFPOINTS → ignored', () => {
    const [d] = svc.detect([obj({ stableId: 'a', layer: 'DEFPOINTS', geometry: rect(0, 0, 100, 100), boundingBox: { x: 0, y: 0, w: 100, h: 100 } })]);
    expect(d.objectType).toBe('ignored');
  });

  it('Tier 2.5 topology: ambiguous linear whose two ends sit on columns → beam boosted', () => {
    const cols: LayerOverride[] = [{ layer: 'COT', type: 'column' }];
    // Two confident columns at x≈0 and x≈4000
    const c1 = obj({ stableId: 'c1', layer: 'COT', geometry: rect(-100, -100, 200, 200), boundingBox: { x: -100, y: -100, w: 200, h: 200 } });
    const c2 = obj({ stableId: 'c2', layer: 'COT', geometry: rect(3900, -100, 200, 200), boundingBox: { x: 3900, y: -100, w: 200, h: 200 } });
    // Ambiguous elongated rectangle spanning between them (unknown layer)
    const beam = obj({ stableId: 'b', layer: 'RANDOM', geometry: rect(0, 0, 4000, 200), boundingBox: { x: 0, y: 0, w: 4000, h: 200 } });

    const withoutCtx = svc.detect([beam]).find((o) => o.stableId === 'b')!;
    expect(withoutCtx.detection.ambiguous).toBe(true); // no context → stays unresolved

    const detected = svc.detect([c1, c2, beam], cols);
    const b = detected.find((o) => o.stableId === 'b')!;
    expect(b.detection.matchedRule).toBe('topology');
    expect(b.objectType).toBe('beam');
  });
});
