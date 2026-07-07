import { domainTier, provinceRule, QS_CURRENT_DOCS } from './qs-knowledge';

describe('provinceRule', () => {
  it('ghim tỉnh vào tra cứu giá khi có location', () => {
    const r = provinceRule('Bình Dương');
    expect(r).toContain('Bình Dương');
    expect(r).toMatch(/ĐƠN GIÁ|công bố giá/i);
  });
  it('nhắc chọn tỉnh khi chưa có', () => {
    expect(provinceRule('')).toMatch(/CHƯA XÁC ĐỊNH/i);
    expect(provinceRule(undefined)).toMatch(/CHƯA XÁC ĐỊNH/i);
  });
});

describe('domainTier', () => {
  it('phân hạng nguồn đúng', () => {
    expect(domainTier('https://moc.gov.vn/x')).toBe('official');
    expect(domainTier('https://soxaydung.binhduong.gov.vn/gia')).toBe('official');
    expect(domainTier('https://thuvienphapluat.vn/x')).toBe('semi');
    expect(domainTier('https://gxd.vn/x')).toBe('community');
    expect(domainTier('https://example.com')).toBeUndefined();
  });
});

describe('QS_CURRENT_DOCS', () => {
  it('nêu văn bản sửa đổi 2025 (chống trả lời theo bản cũ)', () => {
    expect(QS_CURRENT_DOCS).toContain('08/2025');
    expect(QS_CURRENT_DOCS).toContain('60/2025');
    expect(QS_CURRENT_DOCS).toContain('10/2021');
  });
});
