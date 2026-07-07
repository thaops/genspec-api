import { amendedNorms2025, domainTier, provinceRule, QS_CURRENT_DOCS, QS_STANDARDS } from './qs-knowledge';

describe('QS_STANDARDS', () => {
  it('có TCVN đã kiểm chứng + quy tắc chống bịa', () => {
    expect(QS_STANDARDS).toContain('TCVN 5574:2018');
    expect(QS_STANDARDS).toContain('TCVN 4453:1995');
    expect(QS_STANDARDS).toMatch(/vsqi\.gov\.vn/);
    expect(QS_STANDARDS).toMatch(/KHÔNG tự bịa|không bịa/i);
  });
});

describe('amendedNorms2025 (thận trọng, không cry-wolf)', () => {
  it('bắt đào đất AB, cọc AC, nghiền đá AD.28000; KHÔNG bắt bê tông AF/khác', () => {
    const hits = amendedNorms2025(['AB.11411', 'AC.12100', 'AD.28000', 'AF.61120', 'AK.21110', 'AB.11411']);
    expect(hits.map((h) => h.code)).toEqual(['AB.11411', 'AC.12100', 'AD.28000']); // dedupe + loại AF/AK
    expect(hits.find((h) => h.code === 'AD.28000')?.doc).toBe('TT 60/2025');
  });
  it('rỗng khi không có mã thuộc nhóm sửa', () => {
    expect(amendedNorms2025(['AE.62210', 'AK.51110'])).toEqual([]);
  });
});

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
