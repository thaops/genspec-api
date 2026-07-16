import { computeMepRows, rowKeysForDiscipline, MEP_ROW_KEYS, BOQ_GROUP_MEP } from './takeoff-engine.service';

const light = (n: number) => Array.from({ length: n }, () => ({ type: 'light' }));
const pipe = (pts: number[][]) => ({ type: 'pipe', geometry: pts });

/**
 * CA THẬT (đo trên production): bản DIEN detect **136 `light`** (layer_map, conf 0.95,
 * không ambiguous) nhưng BOQ = **0 dòng** vì `DISCIPLINE_ROWKEYS.DIEN = []` và engine
 * không hề gọi `mep-takeoff.ts` (module vốn đã hoàn chỉnh — y hệt ca `rebar-takeoff`).
 */
describe('computeMepRows — MEP vào BOQ (module đã có, nay được nối)', () => {
  it('CA THẬT: 136 đèn → 1 dòng "Đèn 136 bộ"', () => {
    const rows = computeMepRows(light(136), 0.001, rowKeysForDiscipline('DIEN'));
    const den = rows.find((r) => r.key === 'mep_light')!;
    expect(den).toBeDefined();
    expect(den.quantity).toBe(136);
    expect(den.unit).toBe('bộ');   // dùng MEP_UNIT sẵn có, không tự đặt
    expect(den.name).toBe('Đèn');  // dùng MEP_LABEL sẵn có
    expect(den.boqGroup).toBe(BOQ_GROUP_MEP);
  });

  it('KHÔNG bịa mã/giá cho MEP (chưa có định mức MEP trong DB)', () => {
    const den = computeMepRows(light(5), 0.001)[0];
    expect(den.code).toBe('');
    expect(den.unitPrice).toBeUndefined();
    expect(den.source).toBe('—');
    // Mã trống + Nguồn "—" đã nói "chưa có mã"; KHÔNG lặp cảnh báo vào Diễn giải mọi
    // dòng (làm bảng không đọc nổi) — cảnh báo gộp nằm ở finding.
    expect(den.note).not.toMatch(/cần chọn mã/);
    expect(den.note).not.toMatch(/\[nhóm:/); // không rò token máy
  });

  it('tuyến ống đo theo MÉT (polyline × tỉ lệ), không phải đếm', () => {
    // 2 đoạn: 3000mm + 4000mm = 7m ở tỉ lệ 0.001
    const rows = computeMepRows([pipe([[0, 0], [3000, 0], [3000, 4000]])], 0.001, rowKeysForDiscipline('NUOC'));
    const ong = rows.find((r) => r.key === 'mep_pipe')!;
    expect(ong.unit).toBe('m');
    expect(ong.quantity).toBeCloseTo(7, 3);
    expect(ong.note).toMatch(/chiều dài tuyến/);
  });

  it('LỌC BỘ MÔN: bản ĐIỆN không đẻ ra công tác cấp thoát nước', () => {
    const mixed = [...light(3), { type: 'sanitary' }, { type: 'floor_drain' }];
    const keys = computeMepRows(mixed, 0.001, rowKeysForDiscipline('DIEN')).map((r) => r.key);
    expect(keys).toContain('mep_light');
    expect(keys).not.toContain('mep_sanitary');   // TBVS là của bộ môn NƯỚC
    expect(keys).not.toContain('mep_floor_drain');
  });

  it('LỌC BỘ MÔN: bản NƯỚC không đẻ ra công tác điện', () => {
    const mixed = [...light(3), { type: 'sanitary' }];
    const keys = computeMepRows(mixed, 0.001, rowKeysForDiscipline('NUOC')).map((r) => r.key);
    expect(keys).toContain('mep_sanitary');
    expect(keys).not.toContain('mep_light');
  });

  it('object ambiguous → KHÔNG đếm (mep-takeoff đã chặn)', () => {
    const rows = computeMepRows([{ type: 'light', ambiguous: true }], 0.001);
    expect(rows).toHaveLength(0);
  });

  it('bản kiến trúc (KT) → không có dòng MEP nào', () => {
    expect(computeMepRows(light(10), 0.001, rowKeysForDiscipline('KT'))).toHaveLength(0);
  });

  it('MEP_ROW_KEYS sinh từ 2 Set detector — đủ 15, không lệch', () => {
    expect(MEP_ROW_KEYS).toHaveLength(15);
    expect(MEP_ROW_KEYS).toContain('mep_light');
    expect(MEP_ROW_KEYS).toContain('mep_pipe');
  });
});
