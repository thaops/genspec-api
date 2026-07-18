import {
  roundColumnGroups,
  roundColumnRows,
  isRoundColumnSection,
  TakeoffAssumptions,
  EngineDrawingObject,
} from './takeoff-engine.service';

const A: TakeoffAssumptions = { floorHeight: 3.3, wallThickness: 0.22, beamDepth: 0.4 };
const MM = 0.001;

/** Cột tròn (CIRCLE) ambiguous, đường kính dMm, tại (x,y). */
function circle(id: string, x: number, y: number, dMm: number, rawType = 'CIRCLE'): EngineDrawingObject {
  return { type: 'column', rawType, ambiguous: true, boundingBox: { x, y, w: dMm, h: dMm } } as any;
}

describe('isRoundColumnSection', () => {
  it('nhận CIRCLE/ARC bbox vuông, loại LINE/chữ nhật/non-ambiguous', () => {
    expect(isRoundColumnSection(circle('a', 0, 0, 300))).toBe(true);
    expect(isRoundColumnSection(circle('b', 0, 0, 300, 'ARC'))).toBe(true);
    // chữ nhật (bbox lệch) → không phải tròn
    expect(isRoundColumnSection({ type: 'column', rawType: 'CIRCLE', ambiguous: true, boundingBox: { w: 300, h: 100 } } as any)).toBe(false);
    // non-ambiguous → đã đo đường thường, không thuộc nhóm này
    expect(isRoundColumnSection({ type: 'column', rawType: 'CIRCLE', ambiguous: false, boundingBox: { w: 300, h: 300 } } as any)).toBe(false);
    // LINE → không
    expect(isRoundColumnSection({ type: 'column', rawType: 'LINE', ambiguous: true, boundingBox: { w: 300, h: 300 } } as any)).toBe(false);
  });
});

describe('roundColumnGroups', () => {
  it('ĐẾM theo tâm: 3 cung đồng tâm = 1 cột, không phải 3', () => {
    // 3 cung cùng tâm (~cách <200 đơn vị) + 1 cột riêng
    const objs = [
      circle('c1a', 0, 0, 300),
      circle('c1b', 10, 10, 340), // cùng tâm ~, bán kính lớn hơn
      circle('c1c', -10, -10, 320),
      circle('c2', 5000, 5000, 300),
    ];
    const g = roundColumnGroups(objs, MM);
    expect(g.count).toBe(2); // 2 tâm, KHÔNG phải 4 cung
  });

  it('diện tích = πr² (KHÔNG phải bbox d²)', () => {
    const objs = [circle('c', 0, 0, 400)]; // d=400mm=0.4m, r=0.2m
    const g = roundColumnGroups(objs, MM);
    expect(g.totalArea).toBeCloseTo(Math.PI * 0.2 * 0.2, 3); // 0.1257 m², KHÔNG phải 0.16 (bbox)
    expect(g.totalArea).not.toBeCloseTo(0.16, 2);
    expect(g.totalPerimeter).toBeCloseTo(2 * Math.PI * 0.2, 3);
  });

  it('lấy bán kính LỚN NHẤT tại mỗi tâm', () => {
    const g = roundColumnGroups([circle('a', 0, 0, 200), circle('b', 5, 5, 500)], MM);
    expect(g.count).toBe(1);
    expect(g.totalArea).toBeCloseTo(Math.PI * 0.25 * 0.25, 3); // r=0.25 (d=500)
  });
});

describe('roundColumnRows', () => {
  it('sinh BT + ván khuôn cột, note ghi "QS xác nhận"', () => {
    const objs = [circle('c', 0, 0, 400)];
    const { rows, count } = roundColumnRows(objs, MM, A);
    expect(count).toBe(1);
    const bt = rows.find((r) => r.key === 'column_concrete')!;
    expect(bt.quantity).toBeCloseTo(Math.PI * 0.2 * 0.2 * 3.3, 2);
    expect(bt.note).toContain('QS xác nhận');
    expect(rows.some((r) => r.key === 'column_formwork')).toBe(true);
  });

  it('lọc bộ môn: allowedKeys không có column_* → không sinh', () => {
    const { rows } = roundColumnRows([circle('c', 0, 0, 400)], MM, A, new Set(['slab'] as any));
    expect(rows).toHaveLength(0);
  });

  it('không có cột tròn → rỗng', () => {
    expect(roundColumnRows([], MM, A).count).toBe(0);
  });
});
