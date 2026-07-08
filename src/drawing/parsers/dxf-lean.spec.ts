import { MAX_EXTRAS, shouldKeepExtra } from './dxf-parser.service';

describe('shouldKeepExtra (lean parse — chống extras phình OOM)', () => {
  it('luôn BỎ VIEWPORT (paper-space, vô dụng cho takeoff)', () => {
    expect(shouldKeepExtra('VIEWPORT', 0)).toBe(false);
    expect(shouldKeepExtra('VIEWPORT', MAX_EXTRAS - 1)).toBe(false);
  });

  it('giữ DIMENSION/HATCH khi dưới cap', () => {
    expect(shouldKeepExtra('DIMENSION', 0)).toBe(true);
    expect(shouldKeepExtra('HATCH', MAX_EXTRAS - 1)).toBe(true);
  });

  it('BỎ khi đã đạt cap (chống phình vô hạn trên bản KC nặng)', () => {
    expect(shouldKeepExtra('DIMENSION', MAX_EXTRAS)).toBe(false);
    expect(shouldKeepExtra('HATCH', MAX_EXTRAS + 5000)).toBe(false);
  });
});
