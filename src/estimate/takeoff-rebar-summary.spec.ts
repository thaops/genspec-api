import { renderRebarSummary } from './takeoff-engine.service';
import { aggregateRebar } from '../drawing/rebar-takeoff';

describe('renderRebarSummary — phụ lục thép, KHÔNG kg (chưa có chiều dài)', () => {
  it('0 callout → chuỗi rỗng (không in phụ lục thừa)', () => {
    expect(renderRebarSummary(aggregateRebar([]))).toBe('');
  });

  it('có callout thật (mẫu file KC) → liệt kê theo Ø, không có số kg nào', () => {
    const texts = ['4Ø10', '2Ø10', 'Ø6a150', 'Ø6a200', '2Ø16'];
    const out = renderRebarSummary(aggregateRebar(texts));
    expect(out).toContain('PHỤ LỤC CỐT THÉP');
    expect(out).toContain('Ø10');
    expect(out).toContain('Ø6');
    expect(out).toContain('Ø16');
    expect(out).toMatch(/CHIỀU DÀI/);
    // Không có TỔNG KG nào bị tính ra (số + "kg" đứng riêng, không phải "kg/m" đơn trọng
    // hay chữ "KG" trong câu giải thích công thức) — vì chưa có chiều dài thanh.
    expect(out).not.toMatch(/\d+([.,]\d+)?\s*kg\b(?!\/m)/);
  });
});
