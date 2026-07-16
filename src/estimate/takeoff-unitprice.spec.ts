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
  /**
   * ⚠ CHÍNH TEST NÀY TỪNG KHOÁ BUG 100×: nó kỳ vọng `unitPrice = 11.023.967` và
   * `totalPrice = 22.047.934` cho **2 m²** ván khuôn cột — tức 2m² ván khuôn giá 22 TRIỆU.
   * Đơn giá đó là **11.023.967đ/100m²**, nên giá đúng của 2m² là ~220.479đ.
   * Test xanh suốt vì nó khẳng định đúng cái sai (đo thật: 94/287 mã đơn giá Hà Nội
   * tính theo 100m²/100m ⇒ bug dính ~1/3 số mã).
   */
  it('directPrice đơn vị 100m2 → QUY ĐỔI về m2, không nhân thẳng (chống sai 100 lần)', () => {
    const cands: NormCandidateMap = {
      ván_khuôn: { code: 'AF.81132', name: 'Ván khuôn cột', unit: '100m2',
        directPrice: { unitPrice: 11023967, sourceDoc: 'TT 13/2021/TT-BXD' } },
    } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('ván_khuôn', 2)], cands, null); // ctx=null: KHÔNG có price_set
    expect(out[0].unitPrice).toBe(110240); // 11.023.967 ÷ 100
    expect(out[0].totalPrice).toBe(220480); // 2 m² — KHÔNG phải 22.047.934
    expect(out[0].source).toMatch(/TT 13\/2021/); // nguồn thật, hết rỗng
    expect(out[0].source).toMatch(/quy đổi/); // nói rõ đã quy đổi, không lặng lẽ
  });

  it('directPrice cùng đơn vị (m2) → dùng thẳng, không quy đổi', () => {
    const cands = {
      a: { code: 'AK.51210', name: 'Lát nền', unit: 'm2',
        directPrice: { unitPrice: 171557, sourceDoc: 'TT 13/2021' } },
    } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('a', 10)], cands, null);
    expect(out[0].unitPrice).toBe(171557);
    expect(out[0].totalPrice).toBe(1715570);
    expect(out[0].source).not.toMatch(/quy đổi/);
  });

  /** "cái" vs "m2" không có hệ số nào đúng → thà để trống còn hơn nhân bừa. */
  it('đơn vị KHÁC LOẠI (dòng "cái" vs mã "m2") → KHÔNG áp giá, nêu lý do', () => {
    const cands = {
      a: { code: 'AH.32111', name: 'Lắp dựng cửa', unit: 'm2',
        directPrice: { unitPrice: 60830, sourceDoc: 'TT 13/2021' } },
    } as unknown as NormCandidateMap;
    const r = { ...row('a', 131), unit: 'cái' } as TakeoffEngineRow;
    const out = applyPricingToRows([r], cands, null);
    expect(out[0].unitPrice).toBeUndefined();
    expect(out[0].totalPrice).toBeUndefined();
    expect(out[0].note).toMatch(/không quy đổi được/);
  });

  /** Đơn giá tỉnh có đơn vị lạ "100m cọc" — không chắc thì KHÔNG áp giá. */
  it('đơn vị lạ ("100m cọc" vs "m") → KHÔNG áp giá', () => {
    const cands = {
      a: { code: 'AC.25111', name: 'Ép cọc', unit: '100m cọc',
        directPrice: { unitPrice: 15280110, sourceDoc: 'TT 13/2021' } },
    } as unknown as NormCandidateMap;
    const r = { ...row('a', 50), unit: 'm' } as TakeoffEngineRow;
    expect(applyPricingToRows([r], cands, null)[0].unitPrice).toBeUndefined();
  });

  it('mã thiếu đơn vị → KHÔNG áp giá (đo thật: 0/287 đơn giá HN thiếu đơn vị, nên chặt là an toàn)', () => {
    const cands = {
      a: { code: 'X', name: 'x', unit: '', directPrice: { unitPrice: 1000, sourceDoc: 'D' } },
    } as unknown as NormCandidateMap;
    expect(applyPricingToRows([row('a', 5)], cands, null)[0].unitPrice).toBeUndefined();
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
      a: { code: 'X', name: 'x', unit: 'm2',
        components: [{ refCode: 'XM', name: 'Xi măng', norm: 1 }],
        directPrice: { unitPrice: 55555, sourceDoc: 'TT 13/2021' } },
    } as unknown as NormCandidateMap;
    const out = applyPricingToRows([row('a', 1)], cands, ctx);
    expect(out[0].unitPrice).toBe(55555); // không phải 100 từ components
    expect(out[0].source).toMatch(/TT 13\/2021/);
  });

  it('nguồn mã và nguồn giá cùng 1 văn bản → KHÔNG lặp "TT 13/2021 · TT 13/2021"', () => {
    const cands = {
      a: { code: 'AF.81132', name: 'x', unit: 'm2', sourceDoc: 'TT 13/2021/TT-BXD',
        directPrice: { unitPrice: 1000, sourceDoc: 'TT 13/2021/TT-BXD' } },
    } as unknown as NormCandidateMap;
    const r = { ...row('a', 1), source: 'TT 13/2021/TT-BXD' } as TakeoffEngineRow; // push() đã set
    const out = applyPricingToRows([r], cands, null);
    expect(out[0].source).toBe('TT 13/2021/TT-BXD');
    expect(out[0].source!.match(/TT 13\/2021/g)).toHaveLength(1); // đúng 1 lần
  });

  it('nguồn mã KHÁC nguồn giá → vẫn nối cả hai (không nuốt mất nguồn)', () => {
    const cands = {
      a: { code: 'X', name: 'x', unit: 'm2', directPrice: { unitPrice: 1000, sourceDoc: 'Đơn giá HCM 2188' } },
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
