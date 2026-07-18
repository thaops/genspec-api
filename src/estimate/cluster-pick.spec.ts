import {
  clusterPreviews,
  clusterRegion,
  objectsInRegion,
  objectClusters,
  TakeoffAssumptions,
} from './takeoff-engine.service';

const A: TakeoffAssumptions = { floorHeight: 3.3, wallThickness: 0.22, beamDepth: 0.4 };
const MM = 0.001;

/** Tường ngang dài `lenMm` tại (x, y) — LWPOLYLINE 2 điểm, đủ để engine đo. */
function wall(id: string, x: number, y: number, lenMm: number) {
  return {
    _id: id,
    stableId: id,
    type: 'wall',
    rawType: 'LWPOLYLINE',
    boundingBox: { x, y, w: lenMm, h: 220 },
    geometry: [[x, y], [x + lenMm, y]],
  } as any;
}

function door(id: string, x: number, y: number) {
  return {
    _id: id,
    stableId: id,
    type: 'door',
    rawType: 'INSERT',
    boundingBox: { x, y, w: 900, h: 200 },
    geometry: [[x, y], [x + 900, y]],
  } as any;
}

/** 2 mặt bằng giống hệt nhau, đặt cách nhau 200m — đúng hình dạng file DWG dân dụng. */
function twoPlans() {
  const plan = (tag: string, ox: number) => [
    wall(`${tag}w1`, ox + 0, 0, 10000),
    wall(`${tag}w2`, ox + 0, 5000, 10000),
    wall(`${tag}w3`, ox + 0, 10000, 10000),
    wall(`${tag}w4`, ox + 0, 15000, 10000),
    wall(`${tag}w5`, ox + 0, 20000, 10000),
    door(`${tag}d1`, ox + 2000, 2000),
    door(`${tag}d2`, ox + 4000, 7000),
    door(`${tag}d3`, ox + 6000, 12000),
  ];
  return [...plan('a', 0), ...plan('b', 200_000)];
}

describe('clusterRegion', () => {
  it('nới biên để không rụng đối tượng nằm sát mép cụm', () => {
    const c = { x: 1000, y: 2000, w: 5000, h: 4000, count: 9, byType: { wall: 9 } };
    const r = clusterRegion(c, MM); // pad 1m = 1000 đơn vị vẽ

    expect(r).toEqual({ x: 0, y: 1000, w: 7000, h: 6000 });
  });

  it('nới theo MÉT thật, không theo đơn vị vẽ — bản vẽ mét nới 1000× ít hơn bản mm', () => {
    const c = { x: 0, y: 0, w: 10, h: 10, count: 9, byType: {} };
    const r = clusterRegion(c, 1); // bản vẽ đơn vị mét

    expect(r).toEqual({ x: -1, y: -1, w: 12, h: 12 });
  });
});

describe('objectsInRegion', () => {
  it('giữ đối tượng có TÂM trong vùng, loại đối tượng ngoài', () => {
    const objs = [wall('in', 0, 0, 1000), wall('out', 500_000, 0, 1000)];
    const kept = objectsInRegion(objs, { x: -100, y: -100, w: 2000, h: 2000 });

    expect(kept.map((o: any) => o._id)).toEqual(['in']);
  });
});

describe('clusterPreviews', () => {
  it('bóc RIÊNG từng cụm — mỗi cụm ra khối lượng của riêng nó, không phải tổng', () => {
    const objs = twoPlans();
    const { clusters } = objectClusters(objs, MM);
    expect(clusters).toHaveLength(2);

    const previews = clusterPreviews(objs, clusters, MM, A);
    expect(previews).toHaveLength(2);

    const wallLine = (p: (typeof previews)[number]) =>
      p.lines.find((l) => l.name.includes('Xây/trát tường'))!;

    // 2 mặt bằng giống hệt nhau ⇒ 2 preview phải bằng nhau…
    expect(wallLine(previews[0]).quantity).toBe(wallLine(previews[1]).quantity);
    // …và mỗi cụm chỉ được là MỘT NỬA của tổng gộp, không phải cả hai.
    const gộp = clusterPreviews(objs, [{ x: -1e6, y: -1e6, w: 4e6, h: 4e6, count: 0, byType: {} }], MM, A);
    expect(wallLine(gộp[0]).quantity).toBeCloseTo(wallLine(previews[0]).quantity * 2, 3);
  });

  it('region trả về dùng lại được: lọc đúng object của cụm đó', () => {
    const objs = twoPlans();
    const { clusters } = objectClusters(objs, MM);
    const previews = clusterPreviews(objs, clusters, MM, A);

    for (const p of previews) {
      const inside = objectsInRegion(objs, p.region);
      expect(inside).toHaveLength(8); // 5 tường + 3 cửa của đúng 1 mặt bằng
    }
  });

  it('hint mô tả thành phần đo được, không kết luận "mặt bằng tầng mấy"', () => {
    const objs = twoPlans();
    const { clusters } = objectClusters(objs, MM);
    const [p] = clusterPreviews(objs, clusters, MM, A);

    expect(p.hint).toContain('tường');
    expect(p.hint).toContain('cửa');
    expect(p.hint).not.toMatch(/tầng \d/i);
    expect(p.byType).toEqual({ wall: 5, door: 3 });
  });

  it('kích thước cụm quy ra mét thật', () => {
    const objs = twoPlans();
    const { clusters } = objectClusters(objs, MM);
    const [p] = clusterPreviews(objs, clusters, MM, A);

    expect(p.widthM).toBe(10); // 10000mm
    expect(p.heightM).toBeCloseTo(20.2, 1); // 20000mm + bề dày tường
  });

  it('cụm BAO dầm nét đơn ambiguous → region phủ + preview hiện dầm (bug prod đã sửa)', () => {
    // Dầm netDAM: type beam, rawType LINE, AMBIGUOUS → trượt isCountableObject. Trước đây bị
    // loại khỏi clustering → region không phủ → bóc theo cụm mất sạch dầm.
    const netDam = (id: string, y: number, lenMm: number) =>
      ({ _id: id, stableId: id, type: 'beam', rawType: 'LINE', ambiguous: true,
         boundingBox: { x: 0, y, w: 1, h: lenMm }, geometry: [[0, y], [0, y + lenMm]] }) as any;
    const objs = [
      ...Array.from({ length: 10 }, (_, i) => netDam(`b${i}`, i * 1000, 2000)),
    ];

    const { clusters } = objectClusters(objs, MM);
    expect(clusters.length).toBe(1);
    expect(clusters[0].byType.beam).toBe(10); // dầm nét đơn ĐÃ vào cụm

    const [p] = clusterPreviews(objs, clusters, MM, A);
    // region bao trọn → đưa lại objectsInRegion đủ 10 dầm
    expect(objectsInRegion(objs, p.region)).toHaveLength(10);
    // preview lines PHẢI có dầm (trước đây trống → hint "10 dầm" mà lines rỗng)
    expect(p.lines.some((l) => l.name.includes('Bê tông dầm'))).toBe(true);
  });

  it('cụm BAO cột tròn ambiguous → region phủ để confirmRoundColumns bóc được', () => {
    const roundCol = (id: string, x: number, y: number) =>
      ({ _id: id, stableId: id, type: 'column', rawType: 'CIRCLE', ambiguous: true,
         boundingBox: { x, y, w: 300, h: 300 } }) as any;
    const objs = Array.from({ length: 10 }, (_, i) => roundCol(`c${i}`, i * 1000, 0));

    const { clusters } = objectClusters(objs, MM);
    expect(clusters.length).toBe(1);
    expect(clusters[0].byType.column).toBe(10); // cột tròn ĐÃ vào cụm
    const [p] = clusterPreviews(objs, clusters, MM, A);
    expect(objectsInRegion(objs, p.region)).toHaveLength(10); // region phủ hết
  });

  it('object MEP (pipe) vào clustering → bản nước tách được cụm (sơ đồ trục đứng vs mặt bằng)', () => {
    const pipe = (id: string, x: number, y: number) =>
      ({ _id: id, stableId: id, type: 'pipe', rawType: 'LWPOLYLINE', ambiguous: false,
         boundingBox: { x, y, w: 5000, h: 100 }, geometry: [[x, y], [x + 5000, y]] }) as any;
    // 2 nhóm ống cách nhau 300m (mặt bằng vs sơ đồ) — mỗi nhóm ≥8 để không gộp thành 1.
    const objs = [
      ...Array.from({ length: 8 }, (_, i) => pipe(`p${i}`, 0, i * 2000)),
      ...Array.from({ length: 8 }, (_, i) => pipe(`q${i}`, 300_000, i * 2000)),
    ];
    const { clusters } = objectClusters(objs, MM);
    expect(clusters.length).toBe(2); // trước đây pipe không vào cluster → 0/1 cụm → không tách
    expect(clusters[0].byType.pipe).toBe(8);
  });

  it('cắt ở `max` cụm — không trả về hàng trăm cụm rác', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      x: i * 1e6, y: 0, w: 1000, h: 1000, count: 20 - i, byType: { wall: 1 },
    }));
    expect(clusterPreviews([], many, MM, A, null, 8)).toHaveLength(8);
  });

  it('lọc theo bộ môn: bản KC không sinh dòng hoàn thiện của KT', () => {
    const objs = twoPlans();
    const { clusters } = objectClusters(objs, MM);
    const kcOnly = clusterPreviews(objs, clusters, MM, A, new Set(['beam_concrete'] as any));

    for (const p of kcOnly) {
      expect(p.lines.some((l) => l.name.includes('Xây/trát tường'))).toBe(false);
    }
  });
});
