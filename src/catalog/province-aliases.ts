/**
 * Bảng 63 tỉnh/thành VN + alias phổ biến, dùng để extract tên tỉnh từ câu chat.
 * Match theo dạng normalize (bỏ dấu, lowercase, đ→d) với word-boundary.
 */

export function normalizeVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

/** canonical → aliases (chưa normalize; sẽ normalize khi build matcher) */
export const PROVINCE_ALIASES: Record<string, string[]> = {
  'An Giang': ['An Giang'],
  'Bà Rịa - Vũng Tàu': ['Bà Rịa - Vũng Tàu', 'Bà Rịa Vũng Tàu', 'Vũng Tàu', 'Bà Rịa', 'BRVT'],
  'Bắc Giang': ['Bắc Giang'],
  'Bắc Kạn': ['Bắc Kạn', 'Bắc Cạn'],
  'Bạc Liêu': ['Bạc Liêu'],
  'Bắc Ninh': ['Bắc Ninh'],
  'Bến Tre': ['Bến Tre'],
  'Bình Định': ['Bình Định', 'Quy Nhơn'],
  'Bình Dương': ['Bình Dương', 'Thủ Dầu Một'],
  'Bình Phước': ['Bình Phước', 'Đồng Xoài'],
  'Bình Thuận': ['Bình Thuận', 'Phan Thiết'],
  'Cà Mau': ['Cà Mau'],
  'Cần Thơ': ['Cần Thơ'],
  'Cao Bằng': ['Cao Bằng'],
  'Đà Nẵng': ['Đà Nẵng', 'Da Nang', 'Danang'],
  'Đắk Lắk': ['Đắk Lắk', 'Đắc Lắc', 'Dak Lak', 'Daklak', 'Buôn Ma Thuột'],
  'Đắk Nông': ['Đắk Nông', 'Đắc Nông', 'Dak Nong'],
  'Điện Biên': ['Điện Biên'],
  'Đồng Nai': ['Đồng Nai', 'Biên Hòa'],
  'Đồng Tháp': ['Đồng Tháp', 'Cao Lãnh'],
  'Gia Lai': ['Gia Lai', 'Pleiku'],
  'Hà Giang': ['Hà Giang'],
  'Hà Nam': ['Hà Nam', 'Phủ Lý'],
  'Hà Nội': ['Hà Nội', 'Hanoi', 'HN', 'Thủ Đô'],
  'Hà Tĩnh': ['Hà Tĩnh'],
  'Hải Dương': ['Hải Dương'],
  'Hải Phòng': ['Hải Phòng', 'Haiphong'],
  'Hậu Giang': ['Hậu Giang', 'Vị Thanh'],
  'Hòa Bình': ['Hòa Bình'],
  'Hưng Yên': ['Hưng Yên'],
  'Khánh Hòa': ['Khánh Hòa', 'Nha Trang'],
  'Kiên Giang': ['Kiên Giang', 'Rạch Giá', 'Phú Quốc'],
  'Kon Tum': ['Kon Tum'],
  'Lai Châu': ['Lai Châu'],
  'Lâm Đồng': ['Lâm Đồng', 'Đà Lạt', 'Da Lat', 'Dalat'],
  'Lạng Sơn': ['Lạng Sơn'],
  'Lào Cai': ['Lào Cai', 'Sa Pa', 'Sapa'],
  'Long An': ['Long An', 'Tân An'],
  'Nam Định': ['Nam Định'],
  'Nghệ An': ['Nghệ An', 'Vinh'],
  'Ninh Bình': ['Ninh Bình'],
  'Ninh Thuận': ['Ninh Thuận', 'Phan Rang'],
  'Phú Thọ': ['Phú Thọ', 'Việt Trì'],
  'Phú Yên': ['Phú Yên', 'Tuy Hòa'],
  'Quảng Bình': ['Quảng Bình', 'Đồng Hới'],
  'Quảng Nam': ['Quảng Nam', 'Tam Kỳ', 'Hội An'],
  'Quảng Ngãi': ['Quảng Ngãi'],
  'Quảng Ninh': ['Quảng Ninh', 'Hạ Long', 'Móng Cái'],
  'Quảng Trị': ['Quảng Trị', 'Đông Hà'],
  'Sóc Trăng': ['Sóc Trăng'],
  'Sơn La': ['Sơn La', 'Mộc Châu'],
  'Tây Ninh': ['Tây Ninh'],
  'Thái Bình': ['Thái Bình'],
  'Thái Nguyên': ['Thái Nguyên'],
  'Thanh Hóa': ['Thanh Hóa', 'Sầm Sơn'],
  'Thừa Thiên Huế': ['Thừa Thiên Huế', 'Thừa Thiên - Huế', 'Huế', 'Hue'],
  'Tiền Giang': ['Tiền Giang', 'Mỹ Tho'],
  'TP.HCM': ['TP.HCM', 'TPHCM', 'TP HCM', 'HCM', 'Hồ Chí Minh', 'Ho Chi Minh', 'Sài Gòn', 'Saigon', 'SG', 'Thành phố Hồ Chí Minh'],
  'Trà Vinh': ['Trà Vinh'],
  'Tuyên Quang': ['Tuyên Quang'],
  'Vĩnh Long': ['Vĩnh Long'],
  'Vĩnh Phúc': ['Vĩnh Phúc'],
  'Yên Bái': ['Yên Bái'],
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
