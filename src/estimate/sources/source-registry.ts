export type SourcePriority = 1 | 2 | 3;

export interface OfficialSource {
  id: string;
  name: string;
  shortName: string;
  priority: SourcePriority;
  type: 'government' | 'supplier' | 'reference';
  regions?: string[];
  domain?: string;
  description: string;
}

export const SOURCE_REGISTRY: OfficialSource[] = [
  {
    id: 'bxd_viet',
    name: 'Bộ Xây dựng Việt Nam',
    shortName: 'BXD',
    priority: 1,
    type: 'government',
    domain: 'moc.gov.vn',
    description: 'Cơ quan ban hành định mức, suất vốn đầu tư, thông tư xây dựng',
  },
  {
    id: 'vien_ktxd',
    name: 'Viện Kinh tế Xây dựng',
    shortName: 'VKTXD',
    priority: 1,
    type: 'government',
    domain: 'cev.org.vn',
    description: 'Nghiên cứu và công bố suất vốn đầu tư, chỉ số giá xây dựng',
  },
  {
    id: 'so_xd_hn',
    name: 'Sở Xây dựng Hà Nội',
    shortName: 'SXD HN',
    priority: 1,
    type: 'government',
    regions: ['Hà Nội'],
    description: 'Thông báo giá vật liệu xây dựng hàng quý tại Hà Nội',
  },
  {
    id: 'so_xd_hcm',
    name: 'Sở Xây dựng TP. Hồ Chí Minh',
    shortName: 'SXD HCM',
    priority: 1,
    type: 'government',
    regions: ['TP. Hồ Chí Minh', 'Hồ Chí Minh', 'TPHCM'],
    description: 'Thông báo giá vật liệu xây dựng hàng quý tại TP.HCM',
  },
  {
    id: 'so_xd_bd',
    name: 'Sở Xây dựng Bình Dương',
    shortName: 'SXD BD',
    priority: 1,
    type: 'government',
    regions: ['Bình Dương'],
    description: 'Thông báo giá vật liệu xây dựng hàng quý tại Bình Dương',
  },
  {
    id: 'so_xd_da_nang',
    name: 'Sở Xây dựng Đà Nẵng',
    shortName: 'SXD ĐN',
    priority: 1,
    type: 'government',
    regions: ['Đà Nẵng'],
    description: 'Thông báo giá vật liệu xây dựng hàng quý tại Đà Nẵng',
  },
  {
    id: 'so_xd_dong_nai',
    name: 'Sở Xây dựng Đồng Nai',
    shortName: 'SXD ĐNai',
    priority: 1,
    type: 'government',
    regions: ['Đồng Nai'],
    description: 'Thông báo giá vật liệu xây dựng hàng quý tại Đồng Nai',
  },
  {
    id: 'hoa_phat_steel',
    name: 'Tập đoàn Hòa Phát',
    shortName: 'Hòa Phát',
    priority: 2,
    type: 'supplier',
    domain: 'hoaphat.com.vn',
    description: 'Bảng giá thép xây dựng Hòa Phát',
  },
  {
    id: 'viet_y_cement',
    name: 'Xi măng Việt Ý',
    shortName: 'Việt Ý',
    priority: 2,
    type: 'supplier',
    domain: 'vietycement.com.vn',
    description: 'Báo giá xi măng Việt Ý',
  },
  {
    id: 'vissai_cement',
    name: 'Xi măng Vissai',
    shortName: 'Vissai',
    priority: 2,
    type: 'supplier',
    domain: 'vissai.com.vn',
    description: 'Báo giá xi măng Vissai',
  },
  {
    id: 'thu_vien_phap_luat',
    name: 'Thư viện Pháp luật',
    shortName: 'TVPL',
    priority: 3,
    type: 'reference',
    domain: 'thuvienphapluat.vn',
    description: 'Cơ sở tra cứu văn bản pháp luật xây dựng',
  },
  {
    id: 'bao_xay_dung',
    name: 'Báo Xây dựng',
    shortName: 'Báo XD',
    priority: 3,
    type: 'reference',
    domain: 'baoxaydung.com.vn',
    description: 'Tin tức và giá vật liệu xây dựng',
  },
];

export function getSourcesForRegion(region?: string): OfficialSource[] {
  if (!region) return SOURCE_REGISTRY.filter((s) => !s.regions);
  const regionLower = region.toLowerCase();
  return SOURCE_REGISTRY.filter(
    (s) => !s.regions || s.regions.some((r) => regionLower.includes(r.toLowerCase()) || r.toLowerCase().includes(regionLower)),
  );
}

export function getSourceById(id: string): OfficialSource | undefined {
  return SOURCE_REGISTRY.find((s) => s.id === id);
}
