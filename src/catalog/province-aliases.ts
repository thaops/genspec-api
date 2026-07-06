/**
 * Bảng 34 đơn vị hành chính cấp tỉnh SAU SÁP NHẬP 2025 (6 TP TW + 28 tỉnh) + alias.
 * Mỗi tỉnh mới gồm alias của CÁC TỈNH CŨ đã gộp vào nó → text cũ/chat vẫn map đúng
 * về tỉnh mới (giá vẫn khớp nếu price_set key theo tỉnh mới). Canonical trùng đúng
 * chuỗi ở FE genspec-web/lib/provinces.ts để round-trip nhất quán.
 * Match theo dạng normalize (bỏ dấu, lowercase, đ→d) với word-boundary.
 */

export function normalizeVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

/** canonical (tỉnh mới) → aliases (gồm tên tỉnh CŨ đã gộp). Chưa normalize. */
export const PROVINCE_ALIASES: Record<string, string[]> = {
  // 6 thành phố trực thuộc Trung ương
  'Hà Nội': ['Hà Nội', 'Hanoi', 'HN', 'Thủ Đô'],
  'TP. Hồ Chí Minh': [
    'TP. Hồ Chí Minh', 'TP.HCM', 'TPHCM', 'TP HCM', 'HCM', 'Hồ Chí Minh', 'Ho Chi Minh',
    'Sài Gòn', 'Saigon', 'SG', 'Thành phố Hồ Chí Minh',
    'Bình Dương', 'Thủ Dầu Một', 'Bà Rịa - Vũng Tàu', 'Bà Rịa Vũng Tàu', 'Vũng Tàu', 'Bà Rịa', 'BRVT',
  ],
  'Hải Phòng': ['Hải Phòng', 'Haiphong', 'Hải Dương'],
  'Đà Nẵng': ['Đà Nẵng', 'Da Nang', 'Danang', 'Quảng Nam', 'Tam Kỳ', 'Hội An'],
  'Cần Thơ': ['Cần Thơ', 'Sóc Trăng', 'Hậu Giang', 'Vị Thanh'],
  'Huế': ['Huế', 'Hue', 'Thừa Thiên Huế', 'Thừa Thiên - Huế'],
  // 28 tỉnh
  'An Giang': ['An Giang', 'Kiên Giang', 'Rạch Giá', 'Phú Quốc'],
  'Bắc Ninh': ['Bắc Ninh', 'Bắc Giang'],
  'Cà Mau': ['Cà Mau', 'Bạc Liêu'],
  'Cao Bằng': ['Cao Bằng'],
  'Đắk Lắk': ['Đắk Lắk', 'Đắc Lắc', 'Dak Lak', 'Daklak', 'Buôn Ma Thuột', 'Phú Yên', 'Tuy Hòa'],
  'Điện Biên': ['Điện Biên'],
  'Đồng Nai': ['Đồng Nai', 'Biên Hòa', 'Bình Phước', 'Đồng Xoài'],
  'Đồng Tháp': ['Đồng Tháp', 'Cao Lãnh', 'Tiền Giang', 'Mỹ Tho'],
  'Gia Lai': ['Gia Lai', 'Pleiku', 'Bình Định', 'Quy Nhơn'],
  'Hà Tĩnh': ['Hà Tĩnh'],
  'Hưng Yên': ['Hưng Yên', 'Thái Bình'],
  'Khánh Hòa': ['Khánh Hòa', 'Nha Trang', 'Ninh Thuận', 'Phan Rang'],
  'Lai Châu': ['Lai Châu'],
  'Lâm Đồng': ['Lâm Đồng', 'Đà Lạt', 'Da Lat', 'Dalat', 'Đắk Nông', 'Đắc Nông', 'Dak Nong', 'Bình Thuận', 'Phan Thiết'],
  'Lạng Sơn': ['Lạng Sơn'],
  'Lào Cai': ['Lào Cai', 'Sa Pa', 'Sapa', 'Yên Bái'],
  'Nghệ An': ['Nghệ An', 'Vinh'],
  'Ninh Bình': ['Ninh Bình', 'Hà Nam', 'Phủ Lý', 'Nam Định'],
  'Phú Thọ': ['Phú Thọ', 'Việt Trì', 'Vĩnh Phúc', 'Hòa Bình'],
  'Quảng Ngãi': ['Quảng Ngãi', 'Kon Tum'],
  'Quảng Ninh': ['Quảng Ninh', 'Hạ Long', 'Móng Cái'],
  'Quảng Trị': ['Quảng Trị', 'Đông Hà', 'Quảng Bình', 'Đồng Hới'],
  'Sơn La': ['Sơn La', 'Mộc Châu'],
  'Tây Ninh': ['Tây Ninh', 'Long An', 'Tân An'],
  'Thái Nguyên': ['Thái Nguyên', 'Bắc Kạn', 'Bắc Cạn'],
  'Thanh Hóa': ['Thanh Hóa', 'Sầm Sơn'],
  'Tuyên Quang': ['Tuyên Quang', 'Hà Giang'],
  'Vĩnh Long': ['Vĩnh Long', 'Bến Tre', 'Trà Vinh'],
};

interface AliasEntry {
  canonical: string;
  alias: string; // normalized
}

const MATCHERS: AliasEntry[] = Object.entries(PROVINCE_ALIASES)
  .flatMap(([canonical, aliases]) =>
    aliases.map((a) => ({ canonical, alias: normalizeVi(a).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() })),
  )
  // alias dài match trước để tránh nuốt nhầm ("thua thien hue" trước "hue")
  .sort((a, b) => b.alias.length - a.alias.length);

/**
 * Extract tên tỉnh (canonical) từ text tự do. Trả null nếu không thấy.
 * Word-boundary trên chuỗi đã normalize để tránh match giữa từ.
 */
export function extractProvinceFromText(text?: string | null): string | null {
  if (!text?.trim()) return null;
  const norm = ' ' + normalizeVi(text).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  for (const { canonical, alias } of MATCHERS) {
    if (norm.includes(' ' + alias + ' ')) return canonical;
  }
  return null;
}
