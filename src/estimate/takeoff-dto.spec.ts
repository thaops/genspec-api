import 'reflect-metadata'; // decorator metadata — thiếu thì suite không chạy nổi (Reflect.getMetadata undefined)
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TakeoffEngineDto } from './dto';

const validate = (payload: Record<string, unknown>) =>
  validateSync(plainToInstance(TakeoffEngineDto, payload), { whitelist: true });

const base = { drawingId: 'd1', unitsPerDrawingUnit: 0.001 };
const ok = { ...base, assumptions: { floorHeight: 3.3, wallThickness: 0.22, beamDepth: 0.4 } };

/**
 * CA THẬT (dựng lại trên production): POST /estimates/:id/takeoff-engine thiếu
 * `assumptions` → **500 Internal server error**, không phải 400. Vì `@ValidateNested()`
 * bỏ qua `undefined` ⇒ DTO lọt ⇒ engine destructure `assumptions` → TypeError.
 */
describe('TakeoffEngineDto — thiếu assumptions phải 400, KHÔNG được 500', () => {
  it('payload đủ → hợp lệ', () => {
    expect(validate(ok)).toHaveLength(0);
  });

  it('THIẾU assumptions → validation phải BÁO LỖI (nếu không sẽ crash engine → 500)', () => {
    const errs = validate(base);
    expect(errs.map((e) => e.property)).toContain('assumptions');
  });

  it('assumptions = null → cũng phải báo lỗi', () => {
    expect(validate({ ...base, assumptions: null }).map((e) => e.property)).toContain('assumptions');
  });

  it('assumptions thiếu field con (beamDepth) → vẫn báo lỗi', () => {
    const errs = validate({ ...base, assumptions: { floorHeight: 3.3, wallThickness: 0.22 } });
    expect(errs.map((e) => e.property)).toContain('assumptions');
  });

  it('assumptions sai kiểu (số âm) → báo lỗi', () => {
    const errs = validate({ ...base, assumptions: { floorHeight: -1, wallThickness: 0.22, beamDepth: 0.4 } });
    expect(errs.map((e) => e.property)).toContain('assumptions');
  });

  it('editPermission là optional — vắng vẫn hợp lệ', () => {
    expect(validate(ok)).toHaveLength(0);
  });
});
