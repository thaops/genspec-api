import { buildResourcePriceRows, RESOURCE_PRICE_HEADERS, ResourcePriceRow } from './takeoff-engine.service';

/**
 * Sheet 04 — Giá vật liệu. Dữ liệu THẬT từ công bố Sở XD Hà Nội (01.02/2026/CBGVL-SXD,
 * giá VLXD T4/2026): cùng "Cát vàng" có 600.000↔800.000đ/m³ tuỳ bãi (chênh 33%).
 *
 * Hai bất biến của sheet này:
 *  1. Mỗi giá PHẢI kèm MỎ — thiếu mỏ thì giá không tái sử dụng được (không ai biết bao
 *     nhiêu km, xe mấy tấn). Chính công bố yêu cầu "căn cứ… cự ly vận chuyển… để lựa chọn".
 *  2. Phải ghi rõ CHƯA gồm vận chuyển + chưa VAT — dùng thẳng giá mỏ = Cost Summary hụt
 *     cước mà không lộ ra. VAT/vận chuyển là TẦNG TÍNH, không nằm trong giá gốc.
 */
const CAT_750: ResourcePriceRow = {
  name: 'Cát vàng', unit: 'm3', price: 750000, kind: 'material',
  sourcePoint: 'Bãi tại thôn Đồng Xung - Xã ứng Hòa', includesTransport: false, sourceConfidence: 'high',
};
const CAT_600: ResourcePriceRow = {
  name: 'Cát vàng', unit: 'm3', price: 600000, kind: 'material',
  sourcePoint: 'Bãi Cầu Trung Hà, xã Vật Lại', includesTransport: false, sourceConfidence: 'high',
};

describe('buildResourcePriceRows — sheet 04 Giá vật liệu', () => {
  it('có cột Nguồn (mỏ/NCC) — thiếu nó thì giá vô dụng', () => {
    expect(RESOURCE_PRICE_HEADERS).toContain('Nguồn (mỏ/NCC)');
  });

  it('CA THẬT: cùng "Cát vàng", 2 mỏ → 2 DÒNG riêng, giữ nguyên 2 giá', () => {
    const rows = buildResourcePriceRows([CAT_750, CAT_600]);
    expect(rows).toHaveLength(2);
    expect(rows[0][4]).toBe('750000'); // giá thô → Excel cộng/sort được
    expect(rows[1][4]).toBe('600000');
    expect(rows[0][5]).toBe('Bãi tại thôn Đồng Xung - Xã ứng Hòa');
    expect(rows[1][5]).toBe('Bãi Cầu Trung Hà, xã Vật Lại');
  });

  it('KHÔNG trung bình 2 mỏ thành 675.000 (không ai bán giá đó)', () => {
    const prices = buildResourcePriceRows([CAT_750, CAT_600]).map((r) => r[4]);
    expect(prices).not.toContain('675000');
  });

  it('giá mỏ → ghi chú CẢNH BÁO chưa gồm vận chuyển + chưa VAT', () => {
    const note = buildResourcePriceRows([CAT_600])[0][6];
    expect(note).toMatch(/CHƯA gồm vận chuyển/);
    expect(note).toMatch(/chưa VAT/);
  });

  it('giá đã gồm vận chuyển → ghi đúng, không cảnh báo sai', () => {
    const note = buildResourcePriceRows([{ ...CAT_600, includesTransport: true }])[0][6];
    expect(note).toMatch(/đã gồm vận chuyển/);
    expect(note).not.toMatch(/CHƯA gồm/);
  });

  it('nguồn báo giá đại lý (medium) → đánh dấu cần kiểm chứng; công bố Sở XD (high) thì không', () => {
    expect(buildResourcePriceRows([{ ...CAT_600, sourceConfidence: 'medium' }])[0][6]).toMatch(/cần kiểm chứng/);
    expect(buildResourcePriceRows([CAT_600])[0][6]).not.toMatch(/cần kiểm chứng/);
  });

  it('STT chạy đúng, giá là SỐ THÔ (không format sẵn → Excel cộng được)', () => {
    const rows = buildResourcePriceRows([CAT_750, CAT_600]);
    expect(rows.map((r) => r[0])).toEqual(['1', '2']);
    expect(rows[0][4]).not.toMatch(/[.,]/); // "750000", KHÔNG "750.000"
  });
});
