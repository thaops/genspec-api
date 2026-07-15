import { inferUnitFactor, unitsFromInsunits, unitsFromMetadata } from './drawing-unit';

// Bản vẽ mm 30m × 20m — kích thước tổng thể hợp lý.
const ext = { extMin: { x: 0, y: 0 }, extMax: { x: 30_000, y: 20_000 } };

describe('drawing-unit — suy tỉ lệ từ header lúc parse', () => {
  it('map mã $INSUNITS → đơn vị (0 = unitless → unknown)', () => {
    expect(unitsFromInsunits(4)).toBe('mm');
    expect(unitsFromInsunits(6)).toBe('m');
    expect(unitsFromInsunits(1)).toBe('inch');
    expect(unitsFromInsunits(0)).toBe('unknown');
    expect(unitsFromInsunits(undefined)).toBe('unknown');
  });

  it('đọc được cả 2 shape metadata: DWG (insunits số) và DXF (units chuỗi)', () => {
    expect(unitsFromMetadata({ insunits: 4 })).toBe('mm');
    expect(unitsFromMetadata({ units: 'm' })).toBe('m');
    expect(unitsFromMetadata({ units: 'unknown' })).toBe('unknown');
    expect(unitsFromMetadata(undefined)).toBe('unknown');
  });

  it('header khai mm + kích thước hợp lý → 0.001 m/đơn vị', () => {
    expect(inferUnitFactor({ metadata: { insunits: 4 }, ...ext })).toBe(0.001);
  });

  it('DXF khai units=m + kích thước hợp lý → 1', () => {
    expect(
      inferUnitFactor({ metadata: { units: 'm' }, extMin: { x: 0, y: 0 }, extMax: { x: 30, y: 20 } }),
    ).toBe(1);
  });

  // Chính là file KC thật (KC BENH XA LU550): $INSUNITS = 0.
  it('THIẾU $INSUNITS → undefined, KHÔNG đoán mò theo kích thước tổng thể', () => {
    expect(inferUnitFactor({ metadata: { insunits: 0 }, ...ext })).toBeUndefined();
    expect(inferUnitFactor({ metadata: {}, ...ext })).toBeUndefined();
    expect(inferUnitFactor({ ...ext })).toBeUndefined();
  });

  it('header khai láo (đơn vị cho ra kích thước vô lý) → undefined, không tin', () => {
    // Khai mét cho bản vẽ vẽ bằng mm → công trình "30km" → loại.
    expect(inferUnitFactor({ metadata: { insunits: 6 }, ...ext })).toBeUndefined();
    // Khai mm cho bản vẽ vẽ bằng mét → công trình "0.03m" → loại.
    expect(
      inferUnitFactor({ metadata: { insunits: 4 }, extMin: { x: 0, y: 0 }, extMax: { x: 30, y: 20 } }),
    ).toBeUndefined();
  });

  it('thiếu extents → vẫn tin đơn vị khai báo (bỏ qua kiểm tra hợp lý)', () => {
    expect(inferUnitFactor({ metadata: { insunits: 4 } })).toBe(0.001);
    expect(
      inferUnitFactor({ metadata: { insunits: 4 }, extMin: { x: 0, y: 0 }, extMax: { x: 0, y: 0 } }),
    ).toBe(0.001);
  });
});
