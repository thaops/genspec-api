import { DrawingDetectorService, DISCIPLINE_ALLOWED_TYPES, DISCIPLINE_GATED_TYPES } from './drawing-detector.service';

const det = new DrawingDetectorService();

/** Vòng tròn lớn (geometry → column argmax). */
function bigCircle(layer = '0') {
  return { stableId: 'c', layer, rawType: 'CIRCLE', boundingBox: { x: 0, y: 0, w: 400, h: 400 }, geometry: [] } as any;
}
/** Layer khẳng định cột. */
function colLayer() {
  return { stableId: 'k', layer: 'KC-COT', rawType: 'CIRCLE', boundingBox: { x: 0, y: 0, w: 400, h: 400 }, geometry: [] } as any;
}

describe('discipline gate (V1)', () => {
  it('bản NƯỚC: vòng tròn KHÔNG được thành column (ngoài bộ môn) → symbol', () => {
    const [o] = det.detect([bigCircle()], [], undefined, 'NUOC');
    expect(o.objectType).not.toBe('column');
    expect(o.objectType).toBe('symbol');
    expect(o.detection.matchedRule).toBe('discipline_gate');
  });

  it('bản NƯỚC: layer "KC-COT" cũng bị gate (layer trùng token vẫn là nhiễu MEP)', () => {
    const [o] = det.detect([colLayer()], [], undefined, 'NUOC');
    expect(o.objectType).toBe('symbol');
  });

  it('bản KC: vòng tròn vẫn được là column (đúng bộ môn) — KHÔNG giảm chất lượng', () => {
    const [o] = det.detect([bigCircle()], [], undefined, 'KC');
    expect(o.objectType).toBe('column');
  });

  it('KHAC / undefined: không gate (bản chưa gắn bộ môn giữ nguyên hành vi cũ)', () => {
    const [a] = det.detect([bigCircle()], [], undefined, undefined);
    const [b] = det.detect([bigCircle()], [], undefined, 'KHAC');
    expect(a.objectType).toBe('column');
    expect(b.objectType).toBe('column');
  });

  it('type trung tính (axis/dimension/text) không bị gate', () => {
    const dim = { stableId: 'd', layer: 'DIM', rawType: 'DIMENSION', boundingBox: { w: 100, h: 10 }, geometry: [] } as any;
    const [o] = det.detect([dim], [], undefined, 'NUOC');
    expect(DISCIPLINE_GATED_TYPES.has(o.objectType)).toBe(false); // không nằm trong tập bị gate
  });

  // V2 — loại hình chiếu mặt đứng/mặt cắt khỏi đo.
  const wallOn = (layer: string) =>
    ({ stableId: 'w', layer, rawType: 'LWPOLYLINE', boundingBox: { x: 0, y: 0, w: 5000, h: 220 }, geometry: [[0, 0], [5000, 0], [5000, 220], [0, 220], [0, 0]] }) as any;

  it('KT: tường mặt đứng / mặt cắt → symbol (không đếm khối lượng)', () => {
    expect(det.detect([wallOn('Tường bao mặt đứng')], [], undefined, 'KT')[0].objectType).toBe('symbol');
    expect(det.detect([wallOn('5- Cắt tường')], [], undefined, 'KT')[0].objectType).toBe('symbol');
  });

  it('KT: tường mặt bằng (layer "Tuong") vẫn là wall', () => {
    expect(det.detect([wallOn('Tuong')], [], undefined, 'KT')[0].objectType).toBe('wall');
  });

  it('KC: mặt cắt KHÔNG bị loại (là cơ sở đo tiết diện) — cột mặt cắt giữ nguyên', () => {
    // "Cắt cột" trên bản KC phải giữ (không thành symbol vì section rule chỉ áp cho KT).
    const colSection = { stableId: 'c', layer: 'Cắt cột', rawType: 'LWPOLYLINE', boundingBox: { x: 0, y: 0, w: 300, h: 300 }, geometry: [[0, 0], [300, 0], [300, 300], [0, 300], [0, 0]] } as any;
    const o = det.detect([colSection], [], undefined, 'KC')[0];
    expect(o.objectType).not.toBe('symbol');
  });

  it('mặt đứng bị loại cho MỌI bộ môn (kể cả KC)', () => {
    expect(det.detect([wallOn('Mặt đứng nhà')], [], undefined, 'KC')[0].objectType).toBe('symbol');
  });

  it('"cát" (sand) KHÔNG bị nhầm là mặt cắt', () => {
    // Layer chỉ chứa "CAT" đơn (cát) — không phải "cắt <cấu kiện>".
    const o = det.detect([wallOn('Hatch cát nền')], [], undefined, 'KT')[0];
    expect(o.detection.reason).not.toContain('mặt cắt');
  });

  it('consistency: mọi type allowed đều nằm trong tập gated (không có type "allowed" mà quên gate)', () => {
    for (const set of Object.values(DISCIPLINE_ALLOWED_TYPES)) {
      for (const t of set) {
        if (t === 'opening' || t === 'room') continue; // opening/room trung tính, cố ý không gate
        expect(DISCIPLINE_GATED_TYPES.has(t)).toBe(true);
      }
    }
  });
});
