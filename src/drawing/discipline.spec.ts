import { detectDiscipline, detectDisciplineFromLayers } from './discipline';

describe('detectDiscipline — filename (không đổi hành vi cũ)', () => {
  it('vẫn nhận đúng theo quy ước cũ', () => {
    expect(detectDiscipline('KC BENH XA LU550-V3-Thdinh.dwg')).toBe('KC');
    expect(detectDiscipline('KT mat bang tang 1.dwg')).toBe('KT');
    expect(detectDiscipline('random-file-name.dwg')).toBe('KHAC');
  });
});

describe('detectDisciplineFromLayers — fallback khi filename mơ hồ', () => {
  it('layer KC thật (file "KC BENH XA LU550...") → KC', () => {
    // Layer thật đã xác nhận trong file KC dùng suốt phiên trước.
    const layers = ['netMONG', 'netDAM', 'THEP DAI', 'THEP CHIU LUC', 'K.THUOC', 'CHU-250'];
    expect(detectDisciplineFromLayers(layers)).toBe('KC');
  });

  it('layer kiến trúc rõ ràng → KT', () => {
    const layers = ['TUONG-GACH', 'CUA-SO', 'NEN-GACH', 'HOANTHIEN'];
    expect(detectDisciplineFromLayers(layers)).toBe('KT');
  });

  it('không có token nào khớp → KHAC (không đoán bừa)', () => {
    expect(detectDisciplineFromLayers(['0', 'Defpoints', 'K.THUOC'])).toBe('KHAC');
  });

  it('hoà điểm (KC=KT) → KHAC, không đoán bừa', () => {
    expect(detectDisciplineFromLayers(['COT', 'TUONG'])).toBe('KHAC');
  });

  it('không dính nhầm layer cao độ/kích thước (COTCAO, COTATION)', () => {
    expect(detectDisciplineFromLayers(['COTCAO', 'COTATION', 'K.THUOC'])).toBe('KHAC');
  });
});
