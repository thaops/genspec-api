import { computeTakeoffRows, EngineDrawingObject, TakeoffAssumptions, DEFAULT_PILE_LENGTH } from './takeoff-engine.service';

const ASSUMPTIONS: TakeoffAssumptions = { floorHeight: 3.3, wallThickness: 0.2, beamDepth: 0.4 };

// geometry rỗng → measure() dùng w*h (bbox) làm diện tích — nhất quán cách cột/móng đang đo.
function pileSection(w: number, h: number): EngineDrawingObject {
  return { type: 'pile', geometry: [], boundingBox: { x: 0, y: 0, w, h } };
}

const pileRow = (rows: ReturnType<typeof computeTakeoffRows>) =>
  rows.find((r) => r.group === 'pile');

describe('Pile (cọc) — detector đã nhận diện, nay engine đo được', () => {
  it('cọc mặt cắt kín (≥8cm, guard tiết diện qua) → sinh dòng bê tông cọc', () => {
    const rows = computeTakeoffRows([pileSection(400, 400)], 0.001, ASSUMPTIONS, {});
    const row = pileRow(rows);
    expect(row).toBeDefined();
    expect(row!.key).toBe('pile_concrete');
    expect(row!.unit).toBe('m3');
    // 0.4m × 0.4m tiết diện × 20m (mặc định) = 3.2 m³
    expect(row!.quantity).toBeCloseTo(0.4 * 0.4 * DEFAULT_PILE_LENGTH, 2);
    expect(row!.note).toMatch(/dài \(giả định\)/);
  });

  it('cọc ký hiệu (tiết diện < 8cm) → KHÔNG đếm, giống guard cột/dầm/móng', () => {
    const rows = computeTakeoffRows([pileSection(4, 4)], 0.001, ASSUMPTIONS, {});
    expect(pileRow(rows)).toBeUndefined();
  });

  it('chiều dài cọc tuỳ chỉnh qua assumptions.pileLength — không hardcode 20m', () => {
    const rows = computeTakeoffRows(
      [pileSection(400, 400)], 0.001,
      { ...ASSUMPTIONS, pileLength: 25 }, {},
    );
    expect(pileRow(rows)!.quantity).toBeCloseTo(0.4 * 0.4 * 25, 2);
  });

  it('0 cọc → không có dòng pile nào (không bịa dòng rỗng)', () => {
    const rows = computeTakeoffRows([], 0.001, ASSUMPTIONS, {});
    expect(pileRow(rows)).toBeUndefined();
  });
});
