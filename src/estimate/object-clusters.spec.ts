import { objectClusters, countObjectClusters, describeClusters } from './takeoff-engine.service';

/** factor 0.001 = 1 đơn vị vẽ (mm) → 1mm; eps mặc định 25m = 25000 đơn vị vẽ. */
const F = 0.001;
const obj = (type: string, x: number, y: number, w = 200, h = 200) =>
  ({ type, boundingBox: { x, y, w, h } }) as any;

/** 1 "mặt bằng" giả: n đối tượng rải trong ô 10m quanh (ox, oy). */
const plan = (type: string, n: number, ox: number, oy: number) =>
  Array.from({ length: n }, (_, i) => obj(type, ox + (i % 5) * 2000, oy + Math.floor(i / 5) * 2000));

describe('objectClusters — phơi bày cấu trúc cụm, KHÔNG đoán hộ', () => {
  it('2 cụm cách xa (~200m) → tách đúng 2, không gộp', () => {
    const r = objectClusters([...plan('wall', 10, 0, 0), ...plan('wall', 6, 200_000, 0)], F);
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters.map((c) => c.count)).toEqual([10, 6]); // sort giảm dần theo count
  });

  it('1 mặt bằng KHÔNG bị xé nhỏ (các object cách nhau < eps)', () => {
    expect(objectClusters(plan('wall', 20, 0, 0), F).clusters).toHaveLength(1);
  });

  it('cụm đông nhất lên đầu — nhưng chỉ để QS dễ nhìn, engine không tự chọn', () => {
    const r = objectClusters([...plan('wall', 4, 0, 0), ...plan('wall', 12, 300_000, 0)], F);
    expect(r.clusters[0].count).toBe(12);
  });

  it('byType đếm đúng thành phần → QS nhận ra cụm nào là mặt bằng', () => {
    const r = objectClusters([...plan('wall', 9, 0, 0), ...plan('door', 3, 1000, 1000)], F);
    expect(r.clusters[0].byType).toEqual({ wall: 9, door: 3 });
  });

  /**
   * Phải cộng CẢ w/h của object, không chỉ góc x/y: bbox thiếu bề rộng object cuối →
   * region hụt → bóc lại rơi mất chính cấu kiện ở rìa. Assert số CHÍNH XÁC (không phải
   * `w > 0` — ngưỡng lỏng đó không phân biệt nổi bug này).
   */
  it('bbox cụm bao TRỌN object kể cả bề rộng (dùng thẳng làm region để bóc lại)', () => {
    // plan(8) đặt object tại x=1000..9000, y=1000..3000, mỗi cái 200×200.
    const c = objectClusters([obj('wall', 0, 0, 100, 100), ...plan('wall', 8, 1000, 1000)], F).clusters[0];
    expect({ x: c.x, y: c.y, w: c.w, h: c.h }).toEqual({ x: 0, y: 0, w: 9200, h: 3200 });
  });

  it('rỗng → không có cụm nào (không tự chế cụm ma)', () => {
    expect(objectClusters([], F).clusters).toHaveLength(0);
  });

  /**
   * `countObjectClusters` là API cũ đang được `run()` dùng để quyết định cảnh báo
   * multiDrawing — refactor mà lệch số cụm là đổi hành vi engine trong im lặng.
   */
  it('countObjectClusters (wrapper cũ) khớp đúng objectClusters — refactor không đổi hành vi', () => {
    const objs = [...plan('wall', 10, 0, 0), ...plan('wall', 6, 200_000, 0), ...plan('door', 9, 0, 400_000)];
    expect(countObjectClusters(objs, F).clusters).toBe(objectClusters(objs, F).clusters.length);
    expect(countObjectClusters(objs, F).clusters).toBe(3);
  });

  it('<8 đối tượng → coi là 1 cụm, spanM=0 (giữ nguyên hành vi cũ)', () => {
    const r = countObjectClusters(plan('wall', 5, 0, 0), F);
    expect(r).toEqual({ clusters: 1, spanM: 0 });
  });
});

describe('describeClusters — QS đọc được, có toạ độ để bóc lại', () => {
  const cs = objectClusters([...plan('wall', 10, 0, 0), ...plan('door', 9, 500_000, 0)], F).clusters;

  it('nêu số đối tượng + thành phần tiếng Việt + kích thước mét', () => {
    const t = describeClusters(cs, F);
    expect(t).toContain('Cụm 1');
    expect(t).toContain('tường'); // TYPE_LABELS_VI, không phải "wall"
    expect(t).toContain('Cụm 2');
    expect(t).toContain('cửa');
  });

  it('in TOẠ ĐỘ vùng — agent cần nó để bóc lại đúng cụm', () => {
    expect(describeClusters(cs, F)).toMatch(/vùng x=-?\d+ y=-?\d+ w=\d+ h=\d+/);
  });

  it('cắt bớt khi quá nhiều cụm, nhưng NÓI RÕ đã cắt (không im lặng)', () => {
    const many = Array.from({ length: 12 }, (_, i) => plan('wall', 8, i * 300_000, 0)).flat();
    const t = describeClusters(objectClusters(many, F).clusters, F, 3);
    expect(t).toContain('Cụm 3');
    expect(t).not.toContain('Cụm 4');
    expect(t).toContain('9 cụm nhỏ hơn');
  });
});
