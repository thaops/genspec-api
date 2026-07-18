import {
  kcLinearRows,
  mergeRowsByKey,
  computeTakeoffRows,
  TakeoffAssumptions,
  EngineDrawingObject,
  TakeoffEngineRow,
} from './takeoff-engine.service';

const A: TakeoffAssumptions = { floorHeight: 3.3, wallThickness: 0.22, beamDepth: 0.4 };
const MM = 0.001;

/** Dầm vẽ nét đơn (LINE) dọc, dài `lenMm`, trên layer khẳng định (ambiguous vì LINE). */
function beamLine(id: string, y: number, lenMm: number): EngineDrawingObject {
  return {
    type: 'beam',
    rawType: 'LINE',
    ambiguous: true,
    boundingBox: { x: 0, y, w: 1, h: lenMm },
    geometry: [[0, y], [0, y + lenMm]],
  } as any;
}

/** Móng vẽ nét đơn (LINE) ngang. */
function footingLine(id: string, x: number, lenMm: number): EngineDrawingObject {
  return {
    type: 'footing',
    rawType: 'LINE',
    ambiguous: true,
    boundingBox: { x, y: 0, w: lenMm, h: 1 },
    geometry: [[x, 0], [x + lenMm, 0]],
  } as any;
}

/** Dầm mặt cắt kín (LWPOLYLINE, tiết diện thật) — computeTakeoffRows đo được. */
function beamSection(id: string, x: number, lenMm: number): EngineDrawingObject {
  return {
    type: 'beam',
    rawType: 'LWPOLYLINE',
    ambiguous: false,
    boundingBox: { x, y: 0, w: lenMm, h: 300 },
    geometry: [[x, 0], [x + lenMm, 0], [x + lenMm, 300], [x, 300], [x, 0]],
  } as any;
}

describe('kcLinearRows', () => {
  it('đo dầm nét đơn ambiguous = tổng dài × tiết diện giả định', () => {
    const objs = [beamLine('b1', 0, 3000), beamLine('b2', 5000, 2000)]; // tổng 5m
    const { rows, measured } = kcLinearRows(objs, MM, A);

    const bt = rows.find((r) => r.key === 'beam_concrete')!;
    const vk = rows.find((r) => r.key === 'beam_formwork')!;
    expect(bt.quantity).toBeCloseTo(5 * 0.4 * 0.2, 3); // 0.4 m³
    expect(vk.quantity).toBeCloseTo(5 * (0.4 * 2 + 0.2), 3); // 5.0 m²
    expect(measured.size).toBe(2);
    expect(bt.note).toContain('mỗi nét = 1 tim dầm'); // giả định công khai
  });

  it('KHÔNG lấy dầm non-ambiguous (computeTakeoffRows đã đo) → chống đếm trùng', () => {
    const section = beamSection('s1', 0, 4000);
    const objs = [section, beamLine('b1', 0, 3000)];

    const kc = kcLinearRows(objs, MM, A);
    // Chỉ dầm nét đơn ambiguous vào kcLinear.
    expect(kc.measured.has(section)).toBe(false);
    expect(kc.rows.find((r) => r.key === 'beam_concrete')!.note).toContain('1 nét dầm');

    // Và computeTakeoffRows đúng là đã đo dầm mặt cắt đó (bằng chứng nó KHÔNG được để cho kcLinear).
    const base = computeTakeoffRows(objs, MM, A, {});
    expect(base.some((r) => r.key === 'beam_concrete')).toBe(true);
  });

  it('bỏ qua dầm LINE non-ambiguous (đã đo bởi computeTakeoffRows) — khoá lọc ambiguous', () => {
    // "Thay Dam" thật: type beam, rawType LINE, nhưng KHÔNG ambiguous → computeTakeoffRows đo.
    const okBeam: EngineDrawingObject = {
      type: 'beam', rawType: 'LINE', ambiguous: false,
      boundingBox: { x: 0, y: 0, w: 853, h: 629 },
      geometry: [[0, 0], [853, 629]],
    } as any;
    const ambigBeam = beamLine('b1', 0, 3000);

    const kc = kcLinearRows([okBeam, ambigBeam], MM, A);
    expect(kc.measured.has(okBeam)).toBe(false); // chỉ dầm ambiguous
    expect(kc.measured.has(ambigBeam)).toBe(true);
    expect(kc.rows.find((r) => r.key === 'beam_concrete')!.note).toContain('1 nét dầm');
  });

  it('móng nét đơn: đếm để liệt kê, KHÔNG đo (thiếu diện tích đáy)', () => {
    const objs = [footingLine('f1', 0, 1500), footingLine('f2', 3000, 1500)];
    const { rows, unmeasuredLinear } = kcLinearRows(objs, MM, A);

    expect(rows.some((r) => r.group === 'footing')).toBe(false);
    expect(unmeasuredLinear).toEqual({ footing: 2 });
  });

  it('lọc bộ môn: không cho beam khi allowedKeys loại beam_*', () => {
    const objs = [beamLine('b1', 0, 3000)];
    const { rows } = kcLinearRows(objs, MM, A, new Set(['slab'] as any));
    expect(rows).toHaveLength(0);
  });
});

describe('mergeRowsByKey', () => {
  const row = (key: string, quantity: number, note: string): TakeoffEngineRow =>
    ({ key, group: 'beam', boqGroup: 'x', code: '', name: 'Bê tông dầm', unit: 'm3', quantity, note, source: '—' } as any);

  it('cộng khối lượng 2 dòng cùng key (mặt cắt + nét đơn) → 1 dòng', () => {
    const merged = mergeRowsByKey([
      row('beam_concrete', 0.203, 'mặt cắt'),
      row('beam_concrete', 1.308, 'nét đơn'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBeCloseTo(1.511, 3);
    expect(merged[0].note).toContain('mặt cắt');
    expect(merged[0].note).toContain('nét đơn');
  });

  it('giữ nguyên các dòng khác key', () => {
    const merged = mergeRowsByKey([
      row('beam_concrete', 1, 'a'),
      row('beam_formwork', 2, 'b'),
    ]);
    expect(merged).toHaveLength(2);
  });
});
