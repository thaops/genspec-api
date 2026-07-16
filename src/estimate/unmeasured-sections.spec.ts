import { unmeasuredSections } from './takeoff-engine.service';

const F = 0.001;
/** cấu kiện có mặt cắt thật (bbox kín, đủ lớn), không ambiguous. */
const solid = (type: string, side = 300) =>
  ({ type, boundingBox: { x: 0, y: 0, w: side, h: side }, ambiguous: false }) as any;
/** cấu kiện vẽ bằng LINE: một cạnh = 0 (không có tiết diện). */
const line = (type: string) => ({ type, boundingBox: { x: 0, y: 0, w: 5000, h: 0 }, ambiguous: false }) as any;
/** cấu kiện ambiguous (vòng tròn radial: cột? cọc? ký hiệu?). */
const amb = (type: string) => ({ type, boundingBox: { x: 0, y: 0, w: 400, h: 400 }, ambiguous: true }) as any;

/**
 * CA THẬT ("KC BENH XA", 8663 objects): detector ra 76 cột, 38 dầm, 12 móng, 1116 thép
 * nhưng engine chỉ bóc 1 dòng sàn. Cột toàn CIRCLE/ARC conf 0.35 (ambiguous), dầm/móng
 * toàn LINE (cạnh = 0). Nếu chỉ báo "chưa nhận diện được" là SAI — đã nhận diện, chỉ
 * không đủ hình học để đo. Helper này để BÁO RÕ, không lặng lẽ bỏ.
 */
describe('unmeasuredSections — cấu kiện KC đã nhận nhưng chưa đo được', () => {
  it('cột ambiguous (vòng tròn radial) → tính vào chưa-đo-được', () => {
    const r = unmeasuredSections([amb('column'), amb('column')], F);
    expect(r.byType.column).toBe(2);
    expect(r.total).toBe(2);
  });

  it('dầm/móng vẽ LINE (một cạnh = 0) → tính vào chưa-đo-được', () => {
    const r = unmeasuredSections([line('beam'), line('footing'), line('footing')], F);
    expect(r.byType.beam).toBe(1);
    expect(r.byType.footing).toBe(2);
    expect(r.total).toBe(3);
  });

  it('cột có mặt cắt THẬT (đo được) → KHÔNG tính là bỏ sót', () => {
    expect(unmeasuredSections([solid('column')], F).total).toBe(0);
  });

  it('trộn: 1 cột đo được + 2 cột ambiguous + 1 dầm LINE → chỉ 3 chưa đo', () => {
    const r = unmeasuredSections([solid('column'), amb('column'), amb('column'), line('beam')], F);
    expect(r.total).toBe(3);
    expect(r.byType.column).toBe(2);
    expect(r.byType.beam).toBe(1);
  });

  it('type KHÔNG phải cấu kiện KC (tường/cửa/hatch) → bỏ qua, không tính', () => {
    const r = unmeasuredSections([amb('wall'), line('door'), solid('hatch')], F);
    expect(r.total).toBe(0);
  });

  it('rỗng / không có cấu kiện KC → total 0 (không báo khống)', () => {
    expect(unmeasuredSections([], F).total).toBe(0);
    expect(unmeasuredSections([solid('wall')], F).total).toBe(0);
  });

  it('cọc (pile) cũng nằm trong SECTION_TYPES', () => {
    expect(unmeasuredSections([amb('pile')], F).byType.pile).toBe(1);
  });
});
