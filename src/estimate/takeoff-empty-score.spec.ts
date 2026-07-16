import { emptyResultVerdict } from './takeoff-engine.service';

describe('emptyResultVerdict — bóc 0 dòng KHÔNG BAO GIỜ là "đáng tin"', () => {
  it('CA THẬT (DIEN): 0 dòng, 2346 đối tượng, bộ môn chưa hỗ trợ → điểm THẤP, không phải 90', () => {
    // Trước fix: DIEN bóc 0 dòng → rơi nhánh cuối thang điểm → 90đ "reasonable".
    const v = emptyResultVerdict(0, { objectCount: 2346, discipline: 'DIEN', disciplineSupported: false });
    expect(v).not.toBeNull();
    expect(v!.score).toBe(30);
    expect(v!.score).toBeLessThan(70); // phải THẤP HƠN bản KT bóc được 13 dòng (70đ)
    expect(v!.finding.severity).toBe('warn');
    expect(v!.finding.title).toMatch(/KHÔNG dùng được/);
    // Phải nói rõ: tính năng chưa có, KHÔNG phải bản vẽ sạch lỗi
    expect(v!.finding.detail).toMatch(/KHÔNG phải bản vẽ.*sạch lỗi/);
    expect(v!.finding.detail).toMatch(/2346 đối tượng/);
  });

  it('phân biệt ca KHÁC: bộ môn CÓ hỗ trợ nhưng không nhận ra cấu kiện → chỉ đúng layer rule', () => {
    const v = emptyResultVerdict(0, { objectCount: 5000, discipline: 'KT', disciplineSupported: true });
    expect(v!.finding.detail).toMatch(/layer đặt tên không chuẩn/);
    expect(v!.finding.detail).not.toMatch(/tính năng chưa có/); // không đổ lỗi nhầm chỗ
  });

  it('có dòng → null (dùng thang điểm thường, không can thiệp)', () => {
    expect(emptyResultVerdict(13, { objectCount: 5901, discipline: 'KT', disciplineSupported: true })).toBeNull();
    expect(emptyResultVerdict(1, { objectCount: 10, disciplineSupported: true })).toBeNull();
  });

  it('bản vẽ chưa gắn bộ môn → vẫn báo được, không crash', () => {
    const v = emptyResultVerdict(0, { objectCount: 100, disciplineSupported: true });
    expect(v!.finding.title).toMatch(/chưa gắn/);
  });
});
