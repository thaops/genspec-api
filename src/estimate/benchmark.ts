import { Benchmark, ProjectInfo } from './estimate.types';

/**
 * Suất đầu tư xây dựng tham khảo (VND/m² sàn) theo loại công trình.
 * Dùng làm benchmark FALLBACK khi AI không tra được khoảng giá từ web.
 * Số liệu mang tính định hướng (mặt bằng 2024–2025), low–high.
 */
const SUAT_DAU_TU: { match: RegExp; low: number; high: number; label: string }[] = [
  { match: /biệt thự|villa/i, low: 7_000_000, high: 12_000_000, label: 'Biệt thự' },
  { match: /nhà phố|nhà ở|liền kề|townhouse|dân dụng/i, low: 5_500_000, high: 8_500_000, label: 'Nhà phố/nhà ở' },
  { match: /chung cư|căn hộ|apartment/i, low: 9_000_000, high: 15_000_000, label: 'Chung cư' },
  { match: /văn phòng|office|thương mại/i, low: 9_000_000, high: 16_000_000, label: 'Văn phòng/thương mại' },
  { match: /khách sạn|hotel|resort/i, low: 12_000_000, high: 22_000_000, label: 'Khách sạn' },
  { match: /nhà xưởng|nhà kho|công nghiệp|factory|warehouse/i, low: 3_000_000, high: 6_500_000, label: 'Nhà xưởng/kho' },
  { match: /trường|bệnh viện|công cộng/i, low: 8_000_000, high: 14_000_000, label: 'Công trình công cộng' },
];

/** Parse a free-text area string ("200", "200 m2", "1.200m²") to m². */
export function parseArea(area?: string): number {
  if (!area) return 0;
  const cleaned = String(area).replace(/[^0-9.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Total floor area = area × floors (floors defaults to 1). */
export function grossFloorArea(info: ProjectInfo): number {
  const area = parseArea(info.area);
  const floors = Number(info.floors) > 0 ? Number(info.floors) : 1;
  return area * floors;
}

/**
 * Static benchmark for the project total, derived from suất đầu tư × tổng diện tích sàn.
 * Returns undefined when we lack the inputs (no building type match or no area).
 */
export function staticBenchmark(info: ProjectInfo): Benchmark | undefined {
  const gfa = grossFloorArea(info);
  if (gfa <= 0) return undefined;
  const row =
    SUAT_DAU_TU.find((r) => r.match.test(info.buildingType ?? '')) ??
    SUAT_DAU_TU.find((r) => r.match.test(info.name ?? ''));
  if (!row) return undefined;
  return {
    metric: 'total',
    low: Math.round(row.low * gfa),
    high: Math.round(row.high * gfa),
    mid: Math.round(((row.low + row.high) / 2) * gfa),
    basis: `Suất đầu tư ${row.label} ${(row.low / 1e6).toFixed(1)}–${(row.high / 1e6).toFixed(1)} tr/m² × ${gfa.toLocaleString('vi-VN')} m² sàn`,
    source: { name: 'Suất đầu tư tham khảo (bảng tĩnh GenSpec)' },
  };
}

/**
 * Best-effort: extract a "X–Y triệu/m²" suất đầu tư range from grounded research text
 * and scale it by gross floor area. Falls back to the static table when nothing parses.
 */
export function parseBenchmarkFromText(text: string, info: ProjectInfo): Benchmark | undefined {
  const gfa = grossFloorArea(info);
  if (gfa <= 0 || !text) return staticBenchmark(info);
  // e.g. "6 - 8 triệu/m²", "6–8 tr/m2", "khoảng 7 triệu đồng/m2"
  const range = text.match(/(\d+(?:[.,]\d+)?)\s*(?:-|–|đến|tới|~)\s*(\d+(?:[.,]\d+)?)\s*(?:triệu|tr)\b[^\n]{0,12}?\/?\s*m\s*(?:2|²)/i);
  const single = range ? null : text.match(/(?:khoảng|tầm|~)?\s*(\d+(?:[.,]\d+)?)\s*(?:triệu|tr)\b[^\n]{0,12}?\/?\s*m\s*(?:2|²)/i);
  const toNum = (s: string) => Number(s.replace(',', '.')) * 1e6;
  let lowPerM2: number, highPerM2: number;
  if (range) {
    lowPerM2 = toNum(range[1]);
    highPerM2 = toNum(range[2]);
  } else if (single) {
    const mid = toNum(single[1]);
    lowPerM2 = mid * 0.85;
    highPerM2 = mid * 1.15;
  } else {
    return staticBenchmark(info);
  }
  if (!(lowPerM2 > 0) || highPerM2 < lowPerM2) return staticBenchmark(info);
  return {
    metric: 'total',
    low: Math.round(lowPerM2 * gfa),
    high: Math.round(highPerM2 * gfa),
    mid: Math.round(((lowPerM2 + highPerM2) / 2) * gfa),
    basis: `Suất đầu tư ${(lowPerM2 / 1e6).toFixed(1)}–${(highPerM2 / 1e6).toFixed(1)} tr/m² (tra web) × ${gfa.toLocaleString('vi-VN')} m² sàn`,
    source: { name: 'Suất đầu tư thị trường (tra web)' },
  };
}
