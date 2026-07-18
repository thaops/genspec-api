import {
  applyEstimatedFallback,
  EstimatedPrice,
  ESTIMATED_PRICE_SOURCE,
  TakeoffEngineRow,
  TakeoffRowKey,
} from './takeoff-engine.service';

const row = (key: string, unitPrice?: number): TakeoffEngineRow =>
  ({
    key: key as TakeoffRowKey, group: 'x', boqGroup: 'x', code: '', name: key,
    unit: 'm3', quantity: 10, note: 'ct', source: '—',
    ...(unitPrice != null ? { unitPrice } : {}),
  } as TakeoffEngineRow);

const est = (key: string, unitPrice: number, basis = 'thị trường 2026'): [TakeoffRowKey, EstimatedPrice] =>
  [key as TakeoffRowKey, { key: key as TakeoffRowKey, unitPrice, basis }];

describe('applyEstimatedFallback', () => {
  it('điền giá ước lượng cho dòng null + dán nhãn + cờ estimated', () => {
    const rows = [row('a')]; // chưa có giá
    const { rows: out, estimatedCount } = applyEstimatedFallback(rows, new Map([est('a', 1_500_000)]));

    expect(estimatedCount).toBe(1);
    expect(out[0].unitPrice).toBe(1_500_000);
    expect(out[0].totalPrice).toBe(15_000_000); // × qty 10
    expect(out[0].source).toBe(ESTIMATED_PRICE_SOURCE);
    expect(out[0].estimated).toBe(true);
    expect(out[0].note).toContain('ƯỚC LƯỢNG');
  });

  it('KHÔNG đụng dòng đã có giá thật (Tier 1-4)', () => {
    const rows = [row('a', 999)];
    const { rows: out, estimatedCount } = applyEstimatedFallback(rows, new Map([est('a', 1_500_000)]));

    expect(estimatedCount).toBe(0);
    expect(out[0].unitPrice).toBe(999); // giữ giá thật
    expect(out[0].estimated).toBeUndefined();
    expect(out[0].source).toBe('—');
  });

  it('KHÔNG bịa 0/âm — số ước lượng không hợp lệ thì để trống', () => {
    const rows = [row('a'), row('b')];
    const { rows: out, estimatedCount } = applyEstimatedFallback(
      rows,
      new Map([est('a', 0), est('b', -5)]),
    );
    expect(estimatedCount).toBe(0);
    expect(out.every((r) => r.unitPrice == null)).toBe(true);
  });

  it('dòng không có ước lượng vẫn để trống (không phải mọi dòng đều có phao)', () => {
    const rows = [row('a'), row('b')];
    const { rows: out, estimatedCount } = applyEstimatedFallback(rows, new Map([est('a', 100_000)]));
    expect(estimatedCount).toBe(1);
    expect(out[0].unitPrice).toBe(100_000);
    expect(out[1].unitPrice).toBeUndefined();
  });
});
