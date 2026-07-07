import { currentYear, freshnessScore, latestQuarterLabel, monthsSince, parseSourceDate, recencyDelta } from './recency';
import { pickBetterSource, rankSource } from './source';

const NOW = new Date(2026, 6, 7); // 07/2026

describe('parseSourceDate', () => {
  it('parses quarter forms', () => {
    expect(parseSourceDate('Q2/2026')).toEqual(new Date(2026, 3, 1));
    expect(parseSourceDate('quý 3 2026')).toEqual(new Date(2026, 6, 1));
  });
  it('parses ISO and DMY and year-only', () => {
    expect(parseSourceDate('2026-06-22')).toEqual(new Date(2026, 5, 22));
    expect(parseSourceDate('22/06/2026')).toEqual(new Date(2026, 5, 22));
    expect(parseSourceDate('08/2026')).toEqual(new Date(2026, 7, 1));
    expect(parseSourceDate('2024')).toEqual(new Date(2024, 0, 1));
  });
  it('returns undefined for junk', () => {
    expect(parseSourceDate('không rõ')).toBeUndefined();
    expect(parseSourceDate(undefined)).toBeUndefined();
  });
});

describe('recencyDelta', () => {
  it('boosts fresh, penalises stale, neutral on unknown', () => {
    expect(recencyDelta('Q2/2026', NOW)).toBe(4); // 3 tháng
    expect(recencyDelta('2025-07', NOW)).toBe(1); // 12 tháng
    expect(recencyDelta('2024', NOW)).toBeLessThan(0);
    expect(recencyDelta('2018', NOW)).toBe(-18);
    expect(recencyDelta(undefined, NOW)).toBe(0);
  });
});

describe('rankSource with recency', () => {
  it('newer supplier can beat a stale government source', () => {
    const staleGov = rankSource({ type: 'government', date: '2018' })!;
    const freshSupplier = rankSource({ type: 'supplier', date: 'Q2/2026' })!;
    // gov 95-18=77 vs supplier 85+4=89
    expect(freshSupplier.confidence!).toBeGreaterThan(staleGov.confidence!);
  });
  it('keeps confidence untyped-safe', () => {
    expect(rankSource(undefined)).toBeUndefined();
  });
});

describe('domain trust guard (spoof nguồn chính thống)', () => {
  it('government claim from a community domain is downgraded', () => {
    const real = rankSource({ type: 'government', date: latestQuarterLabel(), url: 'https://vbpl.vn/x' })!;
    const spoof = rankSource({ type: 'government', date: latestQuarterLabel(), url: 'https://gxd.vn/x' })!;
    expect(spoof.confidence!).toBeLessThan(real.confidence! - 20);
  });
  it('official gov domain keeps high confidence', () => {
    const gov = rankSource({ type: 'government', date: latestQuarterLabel(), url: 'https://moc.gov.vn/x' })!;
    expect(gov.confidence!).toBeGreaterThanOrEqual(90);
  });
});

describe('pickBetterSource', () => {
  it('prefers the fresher/more reliable adjusted source', () => {
    const a = { type: 'government' as const, date: '2018' };
    const b = { type: 'supplier' as const, date: 'Q2/2026' };
    expect(pickBetterSource(a, b)).toBe(b);
  });
});

describe('helpers', () => {
  it('monthsSince / currentYear / latestQuarterLabel', () => {
    expect(monthsSince(new Date(2026, 0, 1), NOW)).toBe(6);
    expect(currentYear(NOW)).toBe(2026);
    expect(latestQuarterLabel(NOW)).toBe('Quý 3/2026');
    expect(freshnessScore('Q3/2026', NOW)).toBe(100);
  });
});
