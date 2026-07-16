import { applyPricingToRows, NormCandidateMap, TakeoffEngineRow, PriceContextLite } from './takeoff-engine.service';

function row(key: string, quantity: number, code = 'AF.81132'): TakeoffEngineRow {
  return { key, group: key, boqGroup: '', code, name: key, unit: 'm2', quantity, note: '', source: '—' } as TakeoffEngineRow;
}

/**
 * CA THẬT (đo trên production): 4305 đơn giá Hà Nội nằm trong `unit_prices` nhưng
 * 13/13 dòng BOQ không có giá, `sources: 0`. Gốc: `applyPricingToRows` CHỈ biết đường
 * `components` × `price_items` (cần `norm_items` — đang RỖNG), không có đường dùng
 * đơn giá tỉnh TRỌN GÓI.
 */
describe('applyPricingToRows — đơn giá tỉnh trọn gói (unit_prices)', () => {
  it('directPrice → ra giá + nguồn THẬT, KHÔNG cần components/priceCtx', () => {
    const cands: NormCandidateMap = {
      ván_khuôn: { code: 'AF.81132', name: 'Ván khuôn cột', unit: '100m2',
        directPrice: { unitPrice: 11023967, sourceDoc: 'TT 13/2021/TT-BXD' } },
    } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('ván_khuôn', 2)], cands, null); // ctx=null: KHÔNG có price_set
    expect(out[0].unitPrice).toBe(11023967);
    expect(out[0].totalPrice).toBe(22047934);
    expect(out[0].source).toMatch(/TT 13\/2021/); // nguồn thật, hết rỗng
  });

  it('KHÔNG có directPrice và KHÔNG có ctx → giá TRỐNG (không bịa)', () => {
    const cands = { a: { code: 'X', name: 'x', unit: '' } } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('a', 5)], cands, null);
    expect(out[0].unitPrice).toBeUndefined();
    expect(out[0].totalPrice).toBeUndefined();
  });

  it('dòng CHƯA CÓ MÃ → không bao giờ gán giá', () => {
    const cands = { a: { code: 'X', name: 'x', unit: '', directPrice: { unitPrice: 999, sourceDoc: 'D' } } } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('a', 5, '')], cands, null); // code rỗng
    expect(out[0].unitPrice).toBeUndefined();
  });

  it('directPrice ƯU TIÊN hơn đường components (đơn giá tỉnh sát thực tế hơn)', () => {
    const ctx: PriceContextLite = {
      province: 'Hà Nội', sourceDoc: 'CB giá', effectiveDate: '2025-07-01',
      prices: [{ refCode: 'XM', name: 'Xi măng', price: 100 }],
    };
    const cands = {
      a: { code: 'X', name: 'x', unit: '',
        components: [{ refCode: 'XM', name: 'Xi măng', norm: 1 }],
        directPrice: { unitPrice: 55555, sourceDoc: 'TT 13/2021' } },
    } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('a', 1)], cands, ctx);
    expect(out[0].unitPrice).toBe(55555); // không phải 100 từ components
    expect(out[0].source).toMatch(/TT 13\/2021/);
  });

  it('nguồn mã và nguồn giá cùng 1 văn bản → KHÔNG lặp "TT 13/2021 · TT 13/2021"', () => {
    const cands = {
      a: { code: 'AF.81132', name: 'x', unit: '', sourceDoc: 'TT 13/2021/TT-BXD',
        directPrice: { unitPrice: 1000, sourceDoc: 'TT 13/2021/TT-BXD' } },
    } as unknown as NormCandidateMap;
    const r = { ...row('a', 1), source: 'TT 13/2021/TT-BXD' } as TakeoffEngineRow; // push() đã set
    const out = applyPricingToRows([r], cands, null);
    expect(out[0].source).toBe('TT 13/2021/TT-BXD');
    expect(out[0].source!.match(/TT 13\/2021/g)).toHaveLength(1); // đúng 1 lần
  });

  it('nguồn mã KHÁC nguồn giá → vẫn nối cả hai (không nuốt mất nguồn)', () => {
    const cands = {
      a: { code: 'X', name: 'x', unit: '', directPrice: { unitPrice: 1000, sourceDoc: 'Đơn giá HCM 2188' } },
    } as unknown as NormCandidateMap;
    const r = { ...row('a', 1), source: 'định mức import' } as TakeoffEngineRow;
    const out = applyPricingToRows([r], cands, null);
    expect(out[0].source).toBe('định mức import · Đơn giá HCM 2188');
  });

  it('đường CŨ (components × price_items) vẫn chạy khi không có directPrice — không hồi quy', () => {
    const ctx: PriceContextLite = {
      province: 'Hà Nội', sourceDoc: 'CB giá Q2', effectiveDate: '2025-07-01',
      prices: [{ refCode: 'XM', name: 'Xi măng', price: 1000 }],
    };
    const cands = {
      a: { code: 'X', name: 'x', unit: '', components: [{ refCode: 'XM', name: 'Xi măng', norm: 2 }] },
    } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('a', 3)], cands, ctx);
    expect(out[0].unitPrice).toBe(2000); // 2 × 1000
    expect(out[0].totalPrice).toBe(6000);
    expect(out[0].source).toMatch(/CB giá Hà Nội 07\/2025/);
  });
});
