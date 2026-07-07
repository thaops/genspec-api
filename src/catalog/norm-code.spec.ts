import { extractNormCodes, isNormCode, literalCodeInText, normalizeNormCode, NORM_CODE_RE } from './norm-code';

describe('norm-code canonical matcher', () => {
  it('accepts 2-3 letters, 4-6 digits, optional suffix', () => {
    ['AF.61120', 'AK.2111', 'SAA.1234', 'AB.11411a', 'AF.123456'].forEach((c) =>
      expect(isNormCode(c)).toBe(true),
    );
  });
  it('rejects malformed', () => {
    ['A.1234', 'ABCD.1234', 'AF.123', 'AF61120', '12.3456'].forEach((c) =>
      expect(isNormCode(c)).toBe(false),
    );
  });
  it('normalizes case, spaces and dash', () => {
    expect(normalizeNormCode('af - 61120')).toBe('AF.61120');
    expect(normalizeNormCode('AE. 62210')).toBe('AE.62210');
  });
  it('extracts unique normalized codes from free text (web ↔ message parity)', () => {
    const text = 'Trát tường AK.21214 và xây tường ae-11411 (cùng af.61120).';
    expect(extractNormCodes(text)).toEqual(['AK.21214', 'AE.11411', 'AF.61120']);
  });
  it('a 3-letter web code now matches (previously rejected by ^[A-Z]{2})', () => {
    expect(NORM_CODE_RE.test('SAA.1234')).toBe(true);
  });
  it('literalCodeInText tolerates spacing around dot', () => {
    expect(literalCodeInText('AE.62210', 'bảng ghi AE. 62210 đây')).toBe(true);
    expect(literalCodeInText('AE.62210', 'không có mã')).toBe(false);
  });
});
