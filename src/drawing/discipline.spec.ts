import { detectDiscipline, detectDisciplineFromLayers, disciplineUpgradeFromLayers } from './discipline';

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

/**
 * CHẶN HỒI QUY "2 LUỒNG SONG SONG" — đã dính 2 lần:
 *  1. `expandInsertEntities` (nhớ wire cả 2)
 *  2. layer-fallback: chỉ cài ở `drawing-parser.service.ts` (in-process) mà QUÊN
 *     `queue/drawing.processor.ts` (worker) → PRODUCTION chạy worker nên bản kiến
 *     trúc "F550" mãi discipline=KHAC → engine đẻ ra công tác kết cấu.
 * Logic giờ nằm 1 chỗ: `disciplineUpgradeFromLayers`, cả 2 luồng cùng gọi.
 */
describe('disciplineUpgradeFromLayers — dùng chung cho in-process lẫn worker', () => {
  const F550_LAYERS = ['0', 'Text', '2- Nét thấy', '5- Cắt tường', '3- Tường bao mặt đứng', 'CUA', 'Lưới trục'];

  it('CA THẬT (F550): filename ra KHAC → layer nâng lên KT', () => {
    expect(disciplineUpgradeFromLayers('KHAC', F550_LAYERS)).toBe('KT');
  });

  it('KHÔNG đè bộ môn đã rõ từ filename', () => {
    expect(disciplineUpgradeFromLayers('KC', F550_LAYERS)).toBeNull();
    expect(disciplineUpgradeFromLayers('KT', F550_LAYERS)).toBeNull();
  });

  it('KHÔNG đè lựa chọn tay của user (setDiscipline) — chỉ nâng từ KHAC', () => {
    expect(disciplineUpgradeFromLayers('DIEN', F550_LAYERS)).toBeNull();
    expect(disciplineUpgradeFromLayers('NUOC', F550_LAYERS)).toBeNull();
  });

  it('layer không kết luận được → null (giữ KHAC, không đoán bừa)', () => {
    expect(disciplineUpgradeFromLayers('KHAC', ['0', 'Defpoints', 'K.THUOC'])).toBeNull();
  });

  it('discipline undefined (bản ghi cũ) → không crash, không nâng', () => {
    expect(disciplineUpgradeFromLayers(undefined, F550_LAYERS)).toBeNull();
  });
});
