import { parseRebarCallouts, aggregateRebar, unitWeightOf, computeRebarWeight } from './rebar-takeoff';

describe('parseRebarCallouts — khớp cả %%C (AutoCAD literal) và Ø thật (đã decode)', () => {
  it('BUG THẬT đã sửa: text file KC decode thành ký tự Ø, không phải %%C — trước đây 0 match', () => {
    // Sample thật trích từ "KC BENH XA LU550-V3-Thdinh.dwg" (properties.text).
    expect(parseRebarCallouts('2Ø6a500')).toEqual([
      { raw: '2Ø6a500', count: 2, diameter: 6, spacing: 500, kind: 'stirrup' },
    ]);
    expect(parseRebarCallouts('4Ø10')).toEqual([
      { raw: '4Ø10', count: 4, diameter: 10, spacing: undefined, kind: 'main' },
    ]);
    expect(parseRebarCallouts('Ø6a150')).toEqual([
      { raw: 'Ø6a150', count: undefined, diameter: 6, spacing: 150, kind: 'stirrup' },
    ]);
    expect(parseRebarCallouts('2Ø16')[0]).toMatchObject({ count: 2, diameter: 16, kind: 'main' });
    expect(parseRebarCallouts('2Ø8')[0]).toMatchObject({ count: 2, diameter: 8, kind: 'main' });
    expect(parseRebarCallouts('dïng Ø6a500 chi tiÕt xem h×nh d­íi')[0]).toMatchObject({ diameter: 6, spacing: 500 });
  });

  it('vẫn khớp %%C literal cũ (AutoCAD chưa decode) — không hồi quy', () => {
    expect(parseRebarCallouts('2%%C16')[0]).toMatchObject({ count: 2, diameter: 16, kind: 'main' });
    expect(parseRebarCallouts('%%C6a150')[0]).toMatchObject({ diameter: 6, spacing: 150, kind: 'stirrup' });
  });

  it('KHÔNG khớp nhiễu: "Ø>10mm"/"Ø<=10mm" (không có số ngay sau Ø) → bỏ, không bịa', () => {
    expect(parseRebarCallouts('Ø>10mm')).toEqual([]);
    expect(parseRebarCallouts('Ø<=10mm')).toEqual([]);
    expect(parseRebarCallouts('Ø')).toEqual([]); // Ø đứng một mình, không có số
  });

  it('bu lông Ø12 vẫn bị loại (BOLT_RE) — không lẫn với cốt thép', () => {
    expect(parseRebarCallouts('bu lOng Ø12')).toEqual([]);
  });

  it('d=100 (khoảng cách/đường kính ống, không phải cốt thép) không match', () => {
    expect(parseRebarCallouts('d=100')).toEqual([]);
  });
});

describe('aggregateRebar — tổng hợp callout thật theo Ø, KHÔNG tự suy ra kg', () => {
  it('gom đúng theo Ø từ nhiều dòng text thật, note luôn nhắc thiếu chiều dài', () => {
    const texts = ['4Ø10', '2Ø10', 'Ø6a150', 'Ø6a200', 'bu lOng Ø12', 'Ø>10mm'];
    const r = aggregateRebar(texts);
    const d10 = r.diameters.find((d) => d.diameter === 10)!;
    expect(d10.mainBarCount).toBe(6); // 4 + 2
    expect(d10.unitWeightKgM).toBeCloseTo(unitWeightOf(10), 3);
    const d6 = r.diameters.find((d) => d.diameter === 6)!;
    expect(d6.stirrupCalloutCount).toBe(2);
    expect(d6.spacings).toEqual([150, 200]);
    expect(r.diameters.find((d) => d.diameter === 12)).toBeUndefined(); // bu lông bị loại
    expect(r.note).toMatch(/CHIỀU DÀI/);
  });
});

describe('computeRebarWeight — kg chỉ khi ĐÃ có chiều dài, không bịa', () => {
  it('kg = Σ(chiều dài × đơn trọng), wasteFactor mặc định 1.0', () => {
    const r = computeRebarWeight([{ diameter: 10, totalLengthM: 100 }]);
    expect(r.totalKg).toBeCloseTo(100 * unitWeightOf(10), 2);
  });

  it('không có chiều dài (0 hoặc âm) → hàng bị loại, không suy đoán', () => {
    const r = computeRebarWeight([{ diameter: 10, totalLengthM: 0 }]);
    expect(r.rows).toHaveLength(0);
    expect(r.totalKg).toBe(0);
  });
});
