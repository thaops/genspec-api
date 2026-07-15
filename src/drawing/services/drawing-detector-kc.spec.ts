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
