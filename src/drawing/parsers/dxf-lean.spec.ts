import { DROP_TYPES, MAX_TOTAL, shouldKeepExtra } from './dxf-parser.service';

describe('shouldKeepExtra (lean parse — chống extras phình OOM, giữ đủ cho QS nhìn)', () => {
  it('BỎ type rác không hiển thị/không phục vụ bóc tách (VIEWPORT/WIPEOUT/IMAGE/3DSOLID…)', () => {
    for (const t of ['VIEWPORT', 'WIPEOUT', 'IMAGE', '3DSOLID', 'OLE2FRAME', 'REGION']) {
      expect(DROP_TYPES.has(t)).toBe(true);
      expect(shouldKeepExtra(t, 0, 0)).toBe(false);
    }
  });

  it('GIỮ HATCH/DIMENSION (QS cần thấy: sàn từ hatch, số đo từ dim) khi còn budget', () => {
    expect(shouldKeepExtra('DIMENSION', 1000, 500)).toBe(true);
    expect(shouldKeepExtra('HATCH', 100_000, 40_000)).toBe(true); // 140k < 150k
  });

  it('budget CHUNG: extras KHÔNG cộng dồn thành 180k — cắt khi entities+extras đạt MAX_TOTAL', () => {
    expect(shouldKeepExtra('HATCH', MAX_TOTAL - 1, 0)).toBe(true);
    expect(shouldKeepExtra('HATCH', MAX_TOTAL, 0)).toBe(false);       // entities đã đầy → không nhồi extras
    expect(shouldKeepExtra('DIMENSION', 120_000, 30_000)).toBe(false); // tổng 150k
  });
});
