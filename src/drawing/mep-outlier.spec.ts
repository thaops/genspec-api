import { mepTakeoff, MAX_MEP_SEGMENT_M } from './mep-takeoff';

const MM = 0.001;
/** Ống thẳng ngang dài lenMm. */
function pipe(id: string, lenMm: number) {
  return { type: 'pipe', ambiguous: false, geometry: [[0, 0], [lenMm, 0]] } as any;
}

describe('MEP outlier guard (V5)', () => {
  it('bỏ đoạn tuyến dài phi lý (nét khung/leader nhận nhầm)', () => {
    const objs = [
      pipe('a', 10_000),   // 10m — thật
      pipe('b', 15_000),   // 15m — thật
      pipe('c', 839_000),  // 839m — nét khung giả (đo thật NUOC)
      pipe('d', 1_652_000), // 1652m — spline giả
    ];
    const rows = mepTakeoff(objs, MM);
    const pipeRow = rows.find((r) => r.type === 'pipe')!;
    expect(pipeRow.quantity).toBe(25); // chỉ 10+15, KHÔNG cộng 839+1652
  });

  it('giữ đoạn dài SÁT ngưỡng (tuyến trục thật)', () => {
    const rows = mepTakeoff([pipe('x', MAX_MEP_SEGMENT_M * 1000 - 1000)], MM); // ~199m
    expect(rows.find((r) => r.type === 'pipe')!.quantity).toBeCloseTo(MAX_MEP_SEGMENT_M - 1, 0);
  });

  it('ngưỡng đủ rộng cho tuyến thật (200m)', () => {
    expect(MAX_MEP_SEGMENT_M).toBeGreaterThanOrEqual(150);
  });
});
