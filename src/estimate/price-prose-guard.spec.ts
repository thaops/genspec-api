import {
  guardUnsourcedPriceInProse,
  proseHasMoney,
  UNSOURCED_PRICE_WARNING,
  AI_PROSE_SCORE_CAP,
} from './price-prose-guard';

describe('proseHasMoney', () => {
  it('bắt số tiền có phân tách nghìn', () => {
    expect(proseHasMoney('đơn giá 2.155.750 VNĐ/m³')).toBe(true);
    expect(proseHasMoney('1,840,250 đồng')).toBe(true);
  });

  it('KHÔNG báo động giả với năm / mã hiệu / số nhỏ', () => {
    expect(proseHasMoney('Thông tư 12/2021, mã AF.22221, dày 220mm, năm 2025')).toBe(false);
    expect(proseHasMoney('cao 3.3m, hệ số 1.05')).toBe(false);
  });
});

describe('guardUnsourcedPriceInProse', () => {
  const MSG = 'Đơn giá xây tường M75 khoảng 2.155.750 VNĐ/m³ (giả định).';

  it('có giá + KHÔNG nguồn → chèn cảnh báo + hạ điểm', () => {
    const r = guardUnsourcedPriceInProse(MSG, 0);
    expect(r.flagged).toBe(true);
    expect(r.message.startsWith(UNSOURCED_PRICE_WARNING)).toBe(true);
    expect(r.scoreCap).toBe(AI_PROSE_SCORE_CAP);
  });

  it('có giá + CÓ nguồn grounded → không đụng vào', () => {
    const r = guardUnsourcedPriceInProse(MSG, 3);
    expect(r.flagged).toBe(false);
    expect(r.message).toBe(MSG);
    expect(r.scoreCap).toBeUndefined();
  });

  it('không có số tiền → không cảnh báo dù thiếu nguồn', () => {
    const r = guardUnsourcedPriceInProse('Mã định mức là AF.22221, đơn vị 1 m³.', 0);
    expect(r.flagged).toBe(false);
  });

  it('idempotent — gọi 2 lần không nhân đôi cảnh báo', () => {
    const once = guardUnsourcedPriceInProse(MSG, 0);
    const twice = guardUnsourcedPriceInProse(once.message, 0);
    const count = twice.message.split(UNSOURCED_PRICE_WARNING).length - 1;
    expect(count).toBe(1);
  });
});
