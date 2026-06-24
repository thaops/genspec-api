export interface NormCategory {
  code: string;
  name: string;
  description: string;
  examples: string[];
}

export interface ConcreteNorm {
  grade: string;
  cement: number;    // kg xi măng / m³
  sand: number;      // m³ cát / m³
  stone: number;     // m³ đá / m³
  water: number;     // lít nước / m³
  laborNorm: number; // công / m³
  notes: string;
}

export interface SteelNorm {
  application: string;
  steelNorm: number;  // kg thép / T
  wireNorm: number;   // kg dây buộc / T thép
  laborNorm: number;  // công / T
  notes: string;
}

export interface InvestmentRate {
  buildingType: string;
  low: number;
  high: number;
  unit: string;
  notes: string;
}

// Nhóm mã hiệu công tác theo Thông tư 12/2021/TT-BXD
export const NORM_CATEGORIES: NormCategory[] = [
  {
    code: 'AF',
    name: 'Công tác đất',
    description: 'Đào, đắp, vận chuyển đất',
    examples: ['AF.11110 — Đào đất móng băng', 'AF.11120 — Đào đất móng cột', 'AF.21310 — Đắp đất nền'],
  },
  {
    code: 'BA',
    name: 'Công tác bê tông',
    description: 'Bê tông đổ tại chỗ (lót, móng, cột, dầm, sàn, mái)',
    examples: ['BA.11111 — Bê tông lót móng', 'BA.22211 — Bê tông cột', 'BA.23211 — Bê tông dầm', 'BA.24211 — Bê tông sàn'],
  },
  {
    code: 'BD',
    name: 'Công tác cốt thép',
    description: 'Gia công lắp dựng cốt thép',
    examples: ['BD.11212 — Thép móng đơn', 'BD.11312 — Thép móng băng', 'BD.12113 — Thép cột'],
  },
  {
    code: 'BE',
    name: 'Công tác ván khuôn',
    description: 'Gia công lắp dựng ván khuôn',
    examples: ['BE.11110 — VK móng đơn', 'BE.13110 — VK cột vuông', 'BE.15110 — VK dầm'],
  },
  {
    code: 'BF',
    name: 'Xây gạch',
    description: 'Xây tường gạch, trụ, cột',
    examples: ['BF.11112 — Xây tường gạch thẻ dày 100', 'BF.11122 — Xây tường gạch thẻ dày 200'],
  },
  {
    code: 'BG',
    name: 'Trát',
    description: 'Trát tường trong, ngoài, trần',
    examples: ['BG.21122 — Trát tường trong', 'BG.21222 — Trát tường ngoài', 'BG.22122 — Trát trần'],
  },
  {
    code: 'BH',
    name: 'Lát, ốp',
    description: 'Lát nền, ốp tường',
    examples: ['BH.11212 — Lát gạch ceramic', 'BH.21210 — Ốp tường ceramic'],
  },
  {
    code: 'BL',
    name: 'Sơn',
    description: 'Sơn tường, trần, cửa',
    examples: ['BL.11120 — Sơn tường trong nhà', 'BL.11220 — Sơn tường ngoài nhà'],
  },
  {
    code: 'BM',
    name: 'Mái',
    description: 'Lợp mái tôn, ngói, bê tông chống thấm',
    examples: ['BM.10110 — Lợp tôn mạ kẽm', 'BM.40120 — Chống thấm bê tông mái'],
  },
  {
    code: 'SK',
    name: 'Lắp đặt cửa',
    description: 'Cửa gỗ, nhôm, kính, thép',
    examples: ['SK.11110 — Cửa gỗ pano', 'SK.21110 — Cửa nhôm kính'],
  },
];

// Định mức hao phí bê tông đổ tại chỗ (TT12/2021)
export const CONCRETE_NORMS: ConcreteNorm[] = [
  { grade: 'M150', cement: 250, sand: 0.54, stone: 0.90, water: 175, laborNorm: 0.85, notes: 'Bê tông lót móng, nền' },
  { grade: 'M200', cement: 300, sand: 0.50, stone: 0.88, water: 180, laborNorm: 0.90, notes: 'Móng, sàn tầng' },
  { grade: 'M250', cement: 350, sand: 0.46, stone: 0.86, water: 185, laborNorm: 0.95, notes: 'Cột, dầm, sàn' },
  { grade: 'M300', cement: 400, sand: 0.42, stone: 0.84, water: 190, laborNorm: 1.00, notes: 'Cột, dầm chịu lực cao' },
];

// Định mức hao phí cốt thép (TT12/2021)
export const STEEL_NORMS: SteelNorm[] = [
  { application: 'Cốt thép móng', steelNorm: 1000, wireNorm: 10, laborNorm: 12.5, notes: 'Thép ≤ Φ18' },
  { application: 'Cốt thép cột', steelNorm: 1000, wireNorm: 10, laborNorm: 16.0, notes: 'Thép ≤ Φ22' },
  { application: 'Cốt thép dầm', steelNorm: 1000, wireNorm: 10, laborNorm: 14.0, notes: 'Thép ≤ Φ22' },
  { application: 'Cốt thép sàn', steelNorm: 1000, wireNorm: 8, laborNorm: 11.0, notes: 'Thép ≤ Φ12' },
];

// Markup chuẩn theo TT11/2021/TT-BXD
export const STANDARD_MARKUPS = {
  residential: { overheadPct: 6.5, profitPct: 5.5, vatPct: 8, contingencyPct: 5 },
  industrial: { overheadPct: 5.5, profitPct: 5.5, vatPct: 8, contingencyPct: 5 },
  infrastructure: { overheadPct: 5.5, profitPct: 5.5, vatPct: 8, contingencyPct: 5 },
} as const;

// Suất đầu tư tham khảo — nguồn 610/QĐ-BXD năm 2024
export const INVESTMENT_RATES: InvestmentRate[] = [
  { buildingType: 'Nhà ở dân dụng 1-3 tầng', low: 4.5, high: 7.0, unit: 'triệu/m² sàn', notes: 'Nhà phố thông thường' },
  { buildingType: 'Nhà ở dân dụng 4-7 tầng', low: 6.0, high: 9.0, unit: 'triệu/m² sàn', notes: 'Nhà phố kiên cố' },
  { buildingType: 'Chung cư cao tầng', low: 8.0, high: 14.0, unit: 'triệu/m² sàn', notes: 'Tùy vị trí, thiết bị' },
  { buildingType: 'Nhà xưởng công nghiệp', low: 2.5, high: 5.0, unit: 'triệu/m² sàn', notes: 'Kết cấu thép hoặc BTCT' },
  { buildingType: 'Văn phòng', low: 7.0, high: 12.0, unit: 'triệu/m² sàn', notes: 'Tùy cấp độ hoàn thiện' },
];

export function getInvestmentRate(buildingType: string): InvestmentRate | undefined {
  const lower = buildingType.toLowerCase();
  return INVESTMENT_RATES.find(
    (r) =>
      r.buildingType.toLowerCase().includes(lower) ||
      lower.includes(r.buildingType.toLowerCase().split(' ')[0]),
  );
}
