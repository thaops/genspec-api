import { countObjectClusters, EngineDrawingObject } from './takeoff-engine.service';

// factor 1 → toạ độ đã là mét. eps mặc định 25m.
function wallAt(x: number, y: number): EngineDrawingObject {
  return { type: 'wall', geometry: [[x, y], [x + 3, y]], boundingBox: { x, y, w: 3, h: 0.2 } };
}

// Một cụm dày đặc quanh gốc (kích thước < eps).
function cluster(cx: number, cy: number, n = 10): EngineDrawingObject[] {
  return Array.from({ length: n }, (_, i) => wallAt(cx + (i % 5) * 2, cy + Math.floor(i / 5) * 2));
}

describe('countObjectClusters — phát hiện DWG nhiều bản vẽ con', () => {
  it('một mặt bằng liền khối → 1 cụm', () => {
    const r = countObjectClusters(cluster(0, 0, 12), 1);
    expect(r.clusters).toBe(1);
  });

  it('hai mặt bằng cách xa > eps → 2 cụm', () => {
    const objs = [...cluster(0, 0, 12), ...cluster(500, 0, 12)]; // cách 500m >> 25m
    const r = countObjectClusters(objs, 1);
    expect(r.clusters).toBe(2);
    expect(Math.round(r.spanM)).toBeGreaterThan(400);
  });

  it('factor quy đổi đúng: toạ độ mm với factor 0.001', () => {
    const mm = (o: EngineDrawingObject): EngineDrawingObject => ({
      ...o,
      boundingBox: { ...o.boundingBox, x: o.boundingBox.x! * 1000, y: o.boundingBox.y! * 1000, w: o.boundingBox.w * 1000, h: o.boundingBox.h * 1000 },
    });
    const objs = [...cluster(0, 0, 12), ...cluster(500, 0, 12)].map(mm);
    const r = countObjectClusters(objs, 0.001);
    expect(r.clusters).toBe(2);
  });

  it('quá ít đối tượng (<8) → không kết luận nhiều cụm', () => {
    expect(countObjectClusters(cluster(0, 0, 3), 1).clusters).toBe(1);
  });
});
