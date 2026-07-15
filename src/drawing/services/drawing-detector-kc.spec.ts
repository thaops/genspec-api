import { DrawingDetectorService, NormalizedObject } from './drawing-detector.service';

// Bản vẽ mm → 0.001 m/đơn vị.
const MM = 0.001;

function obj(layer: string, w = 300, h = 300): NormalizedObject {
  return {
    stableId: layer + w,
    rawType: 'LWPOLYLINE',
    layer,
    boundingBox: { x: 0, y: 0, w, h },
    geometry: [],
    properties: {},
  } as NormalizedObject;
}

describe('DrawingDetectorService — layer KẾT CẤU đặt tên tự do (Tier 1b)', () => {
  const svc = new DrawingDetectorService();
  const typeOf = (layer: string, w?: number, h?: number, factor?: number) =>
    svc.detect([obj(layer, w, h)], [], factor)[0].objectType;

  it('nhận cột/dầm/móng/cọc/thép từ token layer KC (tên tự do, có tiền tố nhiễu)', () => {
    expect(typeOf('netCOT')).toBe('column');
    expect(typeOf('COT_TANG1')).toBe('column');
    expect(typeOf('KC-COT-500')).toBe('column');
    expect(typeOf('BTCT-DAM')).toBe('beam');
    expect(typeOf('GIANG-MONG')).toBe('footing'); // MONG thắng (rule order)
    expect(typeOf('DAM2')).toBe('beam');
    expect(typeOf('MONG-BANG')).toBe('footing');
    expect(typeOf('DAIMONG')).toBe('footing');
    expect(typeOf('netCOC')).toBe('pile');
    expect(typeOf('THEP-D12')).toBe('rebar');
  });

  it('MÓNG sinh được type "footing" (khoảng trống cũ của detector)', () => {
    const d = svc.detect([obj('KETCAU_MONG_M1')], [], MM)[0];
    expect(d.objectType).toBe('footing');
    expect(d.detection.ambiguous).toBe(false);
    expect(d.detection.matchedRule).toBe('layer_map');
  });

  it('KHÔNG dính nhầm layer gần giống: cao độ / cotation / tim-trục / ghi chú', () => {
    expect(typeOf('COTCAO')).not.toBe('column');
    expect(typeOf('COTATION')).not.toBe('column');
    expect(typeOf('TIM-COT')).toBe('axis');
    expect(typeOf('GHICHU-COT')).toBe('symbol'); // ANNOTATION_LAYER_RE chạy trước
  });

  it('token "DAI" đứng một mình (thép đai vs đài móng) → KHÔNG gán bừa footing', () => {
    expect(typeOf('THEP-DAI')).toBe('rebar');
    expect(typeOf('DAI')).not.toBe('footing');
  });

  it('layer KC nhưng tiết diện 4mm = ký hiệu → symbol, không phải cột', () => {
    expect(typeOf('netCOT', 4, 4, MM)).toBe('symbol');
    expect(typeOf('netCOT', 300, 300, MM)).toBe('column'); // cột thật giữ nguyên
  });

  it('không biết tỉ lệ → vẫn gán type (guard tiết diện của engine chặn lúc đo)', () => {
    expect(typeOf('netCOT', 4, 4)).toBe('column');
  });

  it('layer khớp LAYER_TYPE_MAP exact vẫn ưu tiên như cũ', () => {
    expect(typeOf('S-FNDTN')).toBe('footing');
    expect(typeOf('TRUC')).toBe('axis');
  });
});

/**
 * Bản KC thật ("KC BENH XA LU550"): móng/dầm được dựng bằng NHIỀU NÉT RỜI (LINE) trên
 * layer netMONG/netDAM — 12 LINE từng bị đếm thành "12 móng". 1 nét KHÔNG phải 1 cấu
 * kiện: đếm nét = số khống. Chỉ mặt cắt KÍN (LWPOLYLINE/HATCH/SOLID/CIRCLE) mới chốt.
 */
describe('Tier 1b — nét đơn & chú thích trên layer KC không thành cấu kiện', () => {
  const svc = new DrawingDetectorService();
  const raw = (rawType: string, layer: string, w = 1500, h = 1): NormalizedObject =>
    ({ stableId: rawType + layer, rawType, layer, boundingBox: { x: 0, y: 0, w, h },
       geometry: [], properties: {} } as NormalizedObject);
  const det = (o: NormalizedObject) => svc.detect([o], [])[0];

  it('LINE trên layer móng → giữ gợi ý "footing" nhưng CHƯA CHỐT (không tính khối lượng)', () => {
    const d = det(raw('LINE', 'netMONG'));
    expect(d.objectType).toBe('footing');
    expect(d.detection.ambiguous).toBe(true); // ambiguous ⇒ engine không đếm
  });

  it('LINE chéo (bbox to) trên layer dầm vẫn CHƯA CHỐT — bbox không chứng minh mặt cắt', () => {
    const d = det(raw('LINE', 'netDAM', 2029, 812));
    expect(d.detection.ambiguous).toBe(true);
  });

  it('LWPOLYLINE (mặt cắt kín) trên layer móng → CHỐT footing', () => {
    const d = det(raw('LWPOLYLINE', 'netMONG', 1530, 1585));
    expect(d.objectType).toBe('footing');
    expect(d.detection.ambiguous).toBe(false);
  });

  it('DIMENSION trên layer dầm → dimension, KHÔNG phải beam', () => {
    expect(det(raw('DIMENSION', 'netDAM')).objectType).not.toBe('beam');
  });
});
