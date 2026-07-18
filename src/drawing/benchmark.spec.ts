import * as fs from 'fs';
import * as path from 'path';
import {
  computeTakeoffRows,
  computeMepRows,
  kcLinearRows,
  roundColumnGroups,
  objectClusters,
  rowKeysForDiscipline,
  EngineDrawingObject,
  TakeoffAssumptions,
} from '../estimate/takeoff-engine.service';

/**
 * BENCHMARK REGRESSION — khoá hành vi V1-V7 + block-level trên 4 bản THUC HANH 2 THẬT,
 * chạy từ FIXTURE detected-objects (không cần file DWG). Sửa engine hỏng chỗ này → đỏ.
 */
const DIR = path.join(__dirname, '__fixtures__');
const A: TakeoffAssumptions = { floorHeight: 3.3, wallThickness: 0.22, beamDepth: 0.4 };

function load(disc: string): { objects: EngineDrawingObject[]; unitFactor: number } {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, `${disc}.json`), 'utf-8'));
  return { objects: raw.objects as EngineDrawingObject[], unitFactor: raw.unitFactor ?? 0.001 };
}
function typeCounts(objs: EngineDrawingObject[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const o of objs) m[o.type] = (m[o.type] ?? 0) + 1;
  return m;
}

describe('benchmark — nhận diện theo bộ môn (V1/V2 + block-level)', () => {
  it('KT: tường CHỈ mặt bằng (V2 loại mặt đứng/mặt cắt), không có MEP', () => {
    const tc = typeCounts(load('KT').objects);
    expect(tc.wall).toBe(18); // 713 → 18 (mặt đứng/mặt cắt đã loại)
    expect(tc.pipe ?? 0).toBe(0);
    expect(tc.valve ?? 0).toBe(0);
  });

  it('KC: cấu kiện kết cấu giữ nguyên (không bị V1/V2 làm giảm)', () => {
    const tc = typeCounts(load('KC').objects);
    expect(tc.column).toBe(76);
    expect(tc.beam).toBe(38);
    expect(tc.footing).toBe(12);
    expect(tc.slab).toBe(121);
  });

  it('DIEN: KHÔNG có cột/tường giả (V1), có đèn', () => {
    const tc = typeCounts(load('DIEN').objects);
    expect(tc.column ?? 0).toBe(0);
    expect(tc.wall ?? 0).toBe(0);
    expect(tc.light).toBe(136);
  });

  it('NUOC: KHÔNG có cột/tường giả (V1); có ống + van (block-level)', () => {
    const tc = typeCounts(load('NUOC').objects);
    expect(tc.column ?? 0).toBe(0);
    expect(tc.wall ?? 0).toBe(0);
    expect(tc.pipe).toBeGreaterThan(400);
    expect(tc.valve).toBeGreaterThanOrEqual(50); // block "VAN" ~55
  });
});

describe('benchmark — takeoff engine (số khối lượng)', () => {
  it('KC: cột tròn xác nhận → ~44 cột; dầm nét đơn đo được', () => {
    const { objects, unitFactor } = load('KC');
    const f = unitFactor || 0.001;
    const round = roundColumnGroups(objects, f);
    expect(round.count).toBeGreaterThanOrEqual(40);
    expect(round.count).toBeLessThanOrEqual(50);
    const allowed = rowKeysForDiscipline('KC');
    const kc = kcLinearRows(objects, f, A, allowed);
    expect(kc.rows.some((r) => r.key === 'beam_concrete')).toBe(true);
  });

  it('NUOC: bản MEP tách được cụm (clustering có object MEP)', () => {
    const { objects, unitFactor } = load('NUOC');
    const { clusters } = objectClusters(objects, unitFactor || 0.001);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    const mep = computeMepRows(objects as any, unitFactor || 0.001, rowKeysForDiscipline('NUOC'));
    expect(mep.some((r) => r.name.toLowerCase().includes('ống'))).toBe(true);
  });

  it('KT: bóc toàn bản → khối lượng tường HỢP LÝ (không phồng 50×)', () => {
    const { objects, unitFactor } = load('KT');
    const rows = computeTakeoffRows(objects, unitFactor || 0.001, A, {}, rowKeysForDiscipline('KT'));
    const wallArea = rows.find((r) => r.key === 'wall_area');
    // Trước V2: ~28.594 m². Sau: chỉ tường mặt bằng → vài trăm m².
    if (wallArea) expect(wallArea.quantity).toBeLessThan(3000);
  });
});
