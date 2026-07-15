import {
  computeTakeoffRows,
  summarizeDetectedObjects,
  isRealSection,
  EngineDrawingObject,
  TakeoffAssumptions,
} from './takeoff-engine.service';

const ASSUMPTIONS: TakeoffAssumptions = { floorHeight: 3.3, wallThickness: 0.2, beamDepth: 0.4 };

function column(w: number, h: number): EngineDrawingObject {
  return { type: 'column', geometry: [], boundingBox: { x: 0, y: 0, w, h } };
}

const colQty = (rows: ReturnType<typeof computeTakeoffRows>) =>
  rows.filter((r) => r.group === 'column').reduce((s, r) => s + r.quantity, 0);

describe('KC section guard — cấu kiện tiết diện quá nhỏ = ký hiệu, không đo', () => {
  it('isRealSection loại tiết diện < 8cm (factor mm→m)', () => {
    expect(isRealSection(column(4, 4), 0.001)).toBe(false); // 4mm → ký hiệu
    expect(isRealSection(column(300, 300), 0.001)).toBe(true); // 300mm cột thật
  });

  it('cột "4mm" (ký hiệu) KHÔNG sinh ván khuôn/bê tông khống', () => {
    const rows = computeTakeoffRows([column(4, 4), column(4, 4)], 0.001, ASSUMPTIONS, {});
    expect(colQty(rows)).toBe(0);
  });

  it('cột 300mm thật vẫn bóc bình thường', () => {
    const rows = computeTakeoffRows([column(300, 300)], 0.001, ASSUMPTIONS, {});
    expect(colQty(rows)).toBeGreaterThan(0);
  });

  it('summary báo cấu kiện nghi ký hiệu khi có factor', () => {
    const txt = summarizeDetectedObjects([column(4, 4), column(4, 4)], 0.001);
    expect(txt).toMatch(/nghi KÝ HIỆU/);
    expect(txt).toMatch(/2\/2 cột/);
  });
});
