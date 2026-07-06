import {
  computeTakeoffRows,
  isCountableObject,
  EngineDrawingObject,
  TakeoffAssumptions,
} from './takeoff-engine.service';

const ASSUMPTIONS: TakeoffAssumptions = { floorHeight: 3, wallThickness: 0.2, beamDepth: 0.4 };

// A straight horizontal wall 5 m long (factor 1 → already metres).
function wall(id: string, extra: Partial<EngineDrawingObject> = {}): EngineDrawingObject {
  return { type: 'wall', geometry: [[0, 0], [5, 0]], boundingBox: { x: 0, y: 0, w: 5, h: 0.2 }, ...extra };
}

describe('QS gate — ambiguous/ignored excluded from takeoff', () => {
  it('isCountableObject rejects ambiguous, ignored, unknown', () => {
    expect(isCountableObject(wall('a'))).toBe(true);
    expect(isCountableObject(wall('a', { ambiguous: true }))).toBe(false);
    expect(isCountableObject({ type: 'ignored', boundingBox: { w: 1, h: 1 } })).toBe(false);
    expect(isCountableObject({ type: 'unknown', boundingBox: { w: 1, h: 1 } })).toBe(false);
  });

  it('an ambiguous wall does not contribute quantity, a settled one does', () => {
    const settled = computeTakeoffRows([wall('a')], 1, ASSUMPTIONS, {});
    const ambiguous = computeTakeoffRows([wall('a', { ambiguous: true })], 1, ASSUMPTIONS, {});
    const wallQty = (rows: ReturnType<typeof computeTakeoffRows>) =>
      rows.filter((r) => r.group === 'wall').reduce((s, r) => s + r.quantity, 0);
    expect(wallQty(settled)).toBeGreaterThan(0);
    expect(wallQty(ambiguous)).toBe(0);
  });
});
