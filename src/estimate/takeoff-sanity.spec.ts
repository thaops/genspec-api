import { openingVsFloorFinding, wallVsFloorFinding, TakeoffEngineRow } from './takeoff-engine.service';

function row(key: string, quantity: number): TakeoffEngineRow {
  return { key, group: key, boqGroup: '', code: '', name: key, unit: 'm2', quantity, note: '' } as TakeoffEngineRow;
}

describe('openingVsFloorFinding — engine tự soi số vô lý của chính mình', () => {
  it('CA THẬT (F550) — ĐÚNG shape row của bản KT: KHÔNG có "slab", sàn nằm ở floor_screed', () => {
    // Đây là bộ row thật engine sinh cho F550 (DISCIPLINE_ROWKEYS.KT lọc mất
    // 'slab'). Bản đầu của hàm chỉ tra 'slab' → im lặng trên chính ca cần bắt.
    const f = openingVsFloorFinding([
      row('wall_volume', 26.436), row('wall_area', 132.182), row('skirting', 40.055),
      row('door', 405.191), row('window', 3.24),
      row('floor_screed', 314.701), row('floor_finish', 314.701), row('ceiling', 314.701),
    ], 8);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('warn');
    expect(f!.area).toBe('quantity');
    expect(f!.title).toMatch(/VƯỢT diện tích sàn/);
    expect(f!.detail).toMatch(/Bóc trong vùng/); // phải chỉ cách khắc phục
    expect(f!.detail).toMatch(/~8 cụm bản vẽ/); // dùng clusterInfo có sẵn
  });

  it('bản KC (có "slab") cũng bắt được — hàm chạy cho cả 2 bộ môn', () => {
    const f = openingVsFloorFinding([row('door', 405.191), row('window', 3.24), row('slab', 314.701)], 4);
    expect(f).not.toBeNull();
    expect(f!.title).toMatch(/VƯỢT diện tích sàn/);
  });

  it('số hợp lý (cửa 40 m² < sàn 314 m²) → KHÔNG cảnh báo (không báo động giả)', () => {
    expect(openingVsFloorFinding([row('door', 40), row('window', 3), row('slab', 314.701)])).toBeNull();
  });

  it('cửa + cửa sổ CỘNG LẠI mới vượt → vẫn bắt (không chỉ xét riêng cửa)', () => {
    const f = openingVsFloorFinding([row('door', 60), row('window', 50), row('slab', 100)]);
    expect(f).not.toBeNull();
  });

  it('không có sàn (bản KC/MEP) → KHÔNG cảnh báo, không chia cho 0', () => {
    expect(openingVsFloorFinding([row('door', 405)])).toBeNull();
    expect(openingVsFloorFinding([row('door', 405), row('slab', 0)])).toBeNull();
  });

  it('bằng nhau (biên) → không cảnh báo — chỉ VƯỢT mới bất thường', () => {
    expect(openingVsFloorFinding([row('door', 100), row('slab', 100)])).toBeNull();
  });

  it('1 cụm bản vẽ → không nhắc cụm (chỉ nhắc khi thật sự có nhiều cụm)', () => {
    const f = openingVsFloorFinding([row('door', 400), row('slab', 300)], 1);
    expect(f!.detail).not.toMatch(/cụm bản vẽ/);
  });
});

describe('wallVsFloorFinding — tường thiếu tới mức bất khả thi', () => {
  it('CA THẬT (F550): tường 40.055m không thể bao sàn 314.701 m² (min tròn 62.9m)', () => {
    const f = wallVsFloorFinding([
      row('wall_area', 132.182), row('skirting', 40.055),
      row('floor_screed', 314.701), row('ceiling', 314.701),
    ]);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe('warn');
    expect(f!.area).toBe('quantity');
    expect(f!.title).toMatch(/KHÔNG ĐỦ bao sàn/);
    expect(f!.title).toMatch(/62\.886/); // 2√(π×314.701) = 62.886m — chặn dưới tuyệt đối
    expect(f!.detail).toMatch(/layer tường đặt tên không chuẩn/); // chỉ đúng gốc
    expect(f!.detail).toMatch(/KHÔNG suy thêm tường/); // không bịa
  });

  it('tường ĐỦ dài (200m cho sàn 314 m²) → im lặng, không báo động giả', () => {
    expect(wallVsFloorFinding([row('skirting', 200), row('floor_screed', 314.701)])).toBeNull();
  });

  it('đúng biên: tường = chu vi hình tròn tối thiểu → KHÔNG cảnh báo', () => {
    const floor = 100;
    const minP = 2 * Math.sqrt(Math.PI * floor); // ≈ 35.45m
    expect(wallVsFloorFinding([row('skirting', minP + 0.01), row('floor_screed', floor)])).toBeNull();
    expect(wallVsFloorFinding([row('skirting', minP - 1), row('floor_screed', floor)])).not.toBeNull();
  });

  it('không đo được tường (0m) → im lặng — checklist QS lo, không đoán', () => {
    expect(wallVsFloorFinding([row('floor_screed', 314.701)])).toBeNull();
  });

  it('bản KC/MEP không có sàn → im lặng, không chia cho 0', () => {
    expect(wallVsFloorFinding([row('skirting', 10)])).toBeNull();
  });
});
