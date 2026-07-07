// LỚP KIẾN THỨC QS — nạp thẳng vào system prompt để agent tự xử lý ĐỘNG các tác
// vụ lặp đi lặp lại của QS (tra định mức, tra giá, tra tiêu chuẩn, tổng hợp) mà
// KHÔNG cần thêm button. Triết lý: cung cấp kiến thức > tạo UI. Agent biết:
//   (1) văn bản nào đang HIỆN HÀNH (chống trả lời theo bản cũ),
//   (2) tra loại dữ liệu nào thì TIN nguồn nào trước (source routing),
//   (3) mình LÀM ĐƯỢC những tác vụ lặp nào và cách lấy data.
// Nguồn: đã verify qua web (moc.gov.vn, vbpl.vn, vsqi.gov.vn…) 07/2026.
// LƯU Ý BẢO TRÌ: các mốc văn bản dưới đây có thời hạn — rà lại mỗi khi có TT/NĐ mới.

/**
 * Văn bản HIỆN HÀNH (2026) — kiến thức "chốt" để agent không trả lời theo bản cũ.
 * Đây là phần giá trị nhất: model mặc định tưởng TT12/2021 là bản duy nhất.
 */
export const QS_CURRENT_DOCS = [
  'VĂN BẢN HIỆN HÀNH (cập nhật 2026 — nếu nguồn web nói khác, ưu tiên bản MỚI hơn và nêu rõ ngày):',
  '- Định mức xây dựng: Thông tư 12/2021/TT-BXD (gốc) ĐÃ ĐƯỢC SỬA ĐỔI bởi TT 08/2025/TT-BXD (hiệu lực 15/07/2025, thêm ~58 định mức) và TT 60/2025/TT-BXD (hiệu lực 15/02/2026). Khi trích định mức phải soát cả 3 văn bản — KHÔNG nói "TT12/2021" như thể là bản duy nhất.',
  '  → CÔNG TÁC bị sửa/bổ sung 2025 (nếu dùng, PHẢI nhắc user kiểm bản mới): đào/đắp đất-đá-cát, đóng/ép cọc, đường ray, bê tông (TT08/2025); nghiền đá công suất lớn (mã AD.28000, TT60/2025). Gặp các nhóm này thì cảnh báo "định mức nhóm này vừa sửa 2025 — đối chiếu TT08/2025 & TT60/2025".',
  '- Quản lý chi phí đầu tư XD: Nghị định 10/2021/NĐ-CP, sửa bởi Nghị định 35/2023/NĐ-CP (vẫn hiệu lực — KHÔNG có nghị định mới thay thế).',
  '- Thông tư liên quan: TT 11/2021 (xác định & quản lý chi phí), TT 13/2021 (giá ca máy + đơn giá nhân công), TT 14/2021 (bảo trì) — đều sửa bởi TT 60/2025 (15/02/2026).',
  '- Mã 1776/BXD-VP, QĐ 588, QĐ 957 là bản CŨ/lịch sử — chỉ tham chiếu, không coi là hiện hành.',
].join('\n');

/**
 * Định tuyến nguồn: tra loại dữ liệu nào thì TIN nguồn nào TRƯỚC. Dạy agent chọn
 * đúng "web nào" thay vì tra bừa. T1 = chính thống nhà nước (nguồn sự thật),
 * T2 = tổng hợp lại data chính thống, T3 = cộng đồng/thương mại (chỉ tham khảo).
 */
export const QS_SOURCE_ROUTING = [
  'NGUỒN TIN CẬY THEO LOẠI DỮ LIỆU (tra đúng nguồn, đừng tin nguồn thương mại làm sự thật):',
  '- Định mức & văn bản pháp lý XD → T1: moc.gov.vn (Bộ Xây dựng, có PDF gốc), vbpl.vn (CSDL quốc gia), vanban.chinhphu.vn (công báo). Tra nhanh có thể dùng thuvienphapluat.vn/luatvietnam.vn (T3, nhanh & có tag hiệu lực) NHƯNG phải đối chiếu hiệu lực với T1.',
  '- Đơn giá / công bố giá VLXD, nhân công, ca máy → T1: cổng Sở Xây dựng tỉnh sở tại "soxaydung.<tỉnh>.gov.vn" mục "Công bố giá" (theo QUÝ, HN theo tháng). Aggregator dutoan.com.vn/dutoanf1 (T2) chỉ để tra nhanh — nguồn sự thật là PDF công bố giá của Sở đúng tỉnh + đúng quý.',
  '- Tiêu chuẩn TCVN → T1: tieuchuan.vsqi.gov.vn (tra số hiệu/tình trạng), tcvn.gov.vn. Bản full thường phải mua — trích số hiệu + tình trạng là đủ, đừng bịa nội dung điều khoản.',
  '- Cộng đồng/phần mềm (gxd.vn, giaxaydung.vn, dutoanxaydung.vn, hosoxaydung.com) → T3: chỉ tham khảo/đối chiếu, TUYỆT ĐỐI không dẫn làm căn cứ chính thống.',
  'QUY TẮC: luôn truy nguồn về T1; nếu chỉ có T3 thì nói rõ "tham khảo, cần đối chiếu công bố chính thống".',
].join('\n');

/**
 * Playbook tác vụ LẶP LẠI của QS mà agent xử lý động qua prompt (user chỉ cần
 * gõ yêu cầu — không cần button riêng). Liệt kê để agent biết mình làm được +
 * cách lấy data đúng cho từng loại.
 */
export const QS_TASK_PLAYBOOKS = [
  'BẠN CHỦ ĐỘNG LÀM ĐƯỢC các việc lặp lại sau khi user chỉ gõ yêu cầu (không cần thao tác thêm):',
  '1. Tra mã hiệu định mức cho 1 công tác + hao phí VL/NC/Máy — dùng định mức hiện hành (mục VĂN BẢN HIỆN HÀNH), dẫn mã dạng XX.NNNNN.',
  '2. Tra đơn giá VLXD/nhân công/ca máy theo tỉnh + quý — ưu tiên công bố giá Sở XD tỉnh; nêu tỉnh + quý + ngày công bố.',
  '3. Tra tiêu chuẩn TCVN áp dụng (thiết kế/thi công/nghiệm thu) cho công tác — trả số hiệu + tên + tình trạng còn hiệu lực.',
  '4. Đối chiếu văn bản pháp lý còn hiệu lực (TT/NĐ nào đang áp dụng) — nêu số hiệu, ngày, văn bản sửa đổi.',
  '5. Tổng hợp giá 1 nhóm vật tư từ nhiều nguồn → CHỌN số MỚI NHẤT + nguồn tin cậy nhất, ghi rõ ngày & nguồn từng số.',
  '6. Kiểm tra định mức đã áp đúng chưa (mã có khớp công tác không, hao phí có bất thường không).',
  '7. So sánh chênh lệch giá giữa 2 quý / 2 tỉnh, giải thích nguyên nhân.',
  '8. Sanity-check tổng mức bằng suất đầu tư/benchmark theo loại công trình.',
  'Với mọi việc trên: gắn NGUỒN + NGÀY + độ tin cậy; thiếu dữ liệu thật thì nói "chưa đủ căn cứ" thay vì bịa.',
].join('\n');

/**
 * Ghim TỈNH DỰ ÁN vào prompt — mọi tra cứu GIÁ phải kèm tỉnh này để ra đúng số
 * của tỉnh (đơn giá VLXD/nhân công/ca máy khác nhau theo tỉnh). Định mức toàn quốc.
 */
export function provinceRule(location?: string): string {
  const loc = (location ?? '').trim();
  if (!loc) {
    return 'TỈNH DỰ ÁN: CHƯA XÁC ĐỊNH — trước khi tra đơn giá phải hỏi/nhắc user chọn tỉnh (giá VLXD/nhân công/ca máy khác nhau từng tỉnh). Định mức là toàn quốc, không cần tỉnh.';
  }
  return `TỈNH DỰ ÁN: ${loc}. Mọi tra cứu ĐƠN GIÁ/công bố giá/vật liệu/nhân công/ca máy PHẢI kèm tên tỉnh "${loc}" trong truy vấn và ưu tiên công bố giá của Sở Xây dựng ${loc} (soxaydung.<${loc}>.gov.vn) — trừ khi user chỉ định tỉnh khác. Định mức là toàn quốc (không theo tỉnh).`;
}

/**
 * Tra tiêu chuẩn TCVN — danh mục ĐÃ VERIFY (vsqi.gov.vn) để agent trả nhanh + đúng
 * số hiệu. Ngoài danh sách này TUYỆT ĐỐI không bịa số hiệu/nội dung điều khoản —
 * phải tra vsqi.gov.vn (bản full thường phải mua, chỉ trích số hiệu + tình trạng).
 */
export const QS_STANDARDS = [
  'TIÊU CHUẨN TCVN THƯỜNG DÙNG (đã kiểm chứng — số hiệu chuẩn, nêu kèm khi tư vấn nghiệm thu/thiết kế):',
  '- TCVN 5574:2018 — Thiết kế kết cấu bê tông & bê tông cốt thép.',
  '- TCVN 4453:1995 — Kết cấu BT & BTCT toàn khối: thi công & nghiệm thu.',
  '- TCVN 7570:2006 — Cốt liệu cho bê tông & vữa (yêu cầu kỹ thuật).',
  '- TCVN 9346:2012 — Chống ăn mòn BTCT môi trường biển.',
  '- TCVN 9343:2012 — Bảo trì kết cấu BTCT.',
  '- TCVN 13718:2023 — Kết cấu bê tông thủy công: thi công & nghiệm thu.',
  'QUY TẮC: tiêu chuẩn NGOÀI danh sách trên → tra tieuchuan.vsqi.gov.vn / tcvn.gov.vn, trả SỐ HIỆU + tên + TÌNH TRẠNG hiệu lực; KHÔNG tự bịa số hiệu hay trích nội dung điều khoản khi chưa tra được.',
].join('\n');

/** Gói kiến thức đầy đủ (chèn vào prompt read/edit/review). */
export const QS_KNOWLEDGE = [QS_CURRENT_DOCS, QS_SOURCE_ROUTING, QS_STANDARDS, QS_TASK_PLAYBOOKS].join('\n\n');

// ===== Domain trust — dùng để (a) bias query web về T1, (b) chấm nguồn ở source.ts =====

export type DomainTier = 'official' | 'semi' | 'community';

/** Domain (substring) → hạng tin cậy. Khớp theo `includes` trên host. */
export const DOMAIN_TRUST: { match: string; tier: DomainTier }[] = [
  { match: 'moc.gov.vn', tier: 'official' },
  { match: 'vbpl.vn', tier: 'official' },
  { match: 'chinhphu.vn', tier: 'official' },
  { match: 'vsqi.gov.vn', tier: 'official' },
  { match: 'tcvn.gov.vn', tier: 'official' },
  { match: 'soxaydung', tier: 'official' }, // cổng Sở XD tỉnh (soxaydung.<tỉnh>.gov.vn)
  { match: '.gov.vn', tier: 'official' }, // fallback cơ quan nhà nước
  { match: 'thuvienphapluat.vn', tier: 'semi' },
  { match: 'luatvietnam.vn', tier: 'semi' },
  { match: 'dutoan.com.vn', tier: 'semi' },
  { match: 'dutoanf1', tier: 'community' },
  { match: 'gxd.vn', tier: 'community' },
  { match: 'giaxaydung', tier: 'community' },
  { match: 'dutoanxaydung', tier: 'community' },
  { match: 'hosoxaydung', tier: 'community' },
];

/** Hạng tin cậy của 1 URL/host (undefined nếu không nhận diện được). PURE. */
export function domainTier(url?: string): DomainTier | undefined {
  if (!url) return undefined;
  const u = url.toLowerCase();
  return DOMAIN_TRUST.find((d) => u.includes(d.match))?.tier;
}

// ===== Cảnh báo định mức đã sửa 2025 (theo mã) =====
// THẬN TRỌNG chống báo nhầm: chỉ bắt các nhóm ÍT PHỔ BIẾN (đào đất AB, cọc AC,
// nghiền đá AD.28000) — nơi một cảnh báo là TÍN HIỆU. Bê tông (AF) tuy cũng được
// bổ sung 2025 nhưng có mặt ở gần như mọi dự toán → bắt theo mã sẽ thành NHIỄU
// (bài học "đừng cry-wolf"); AF chỉ nhắc trong text finding, không tự gắn cờ từng dòng.
export const AMENDED_2025: { re: RegExp; group: string; doc: string }[] = [
  { re: /^AB\./i, group: 'đào/đắp đất-đá-cát', doc: 'TT 08/2025' },
  { re: /^AC\./i, group: 'đóng/ép cọc', doc: 'TT 08/2025' },
  { re: /^AD\.?28000/i, group: 'nghiền đá (AD.28000)', doc: 'TT 60/2025' },
];

/** Các mã đang dùng thuộc nhóm định mức đã sửa 2025 (dedupe theo mã). PURE. */
export function amendedNorms2025(codes: string[]): { code: string; group: string; doc: string }[] {
  const seen = new Set<string>();
  const out: { code: string; group: string; doc: string }[] = [];
  for (const raw of codes) {
    const c = (raw ?? '').trim();
    if (!c) continue;
    const hit = AMENDED_2025.find((a) => a.re.test(c));
    if (hit && !seen.has(c.toUpperCase())) {
      seen.add(c.toUpperCase());
      out.push({ code: c, group: hit.group, doc: hit.doc });
    }
  }
  return out;
}

/** Gợi ý domain ưu tiên để nhồi vào query web theo loại dữ liệu. */
export const PREFERRED_DOMAINS: Record<'norm' | 'price' | 'standard' | 'legal', string> = {
  norm: 'ưu tiên nguồn chính thống moc.gov.vn, vbpl.vn, vanban.chinhphu.vn',
  price: 'ưu tiên công bố giá Sở Xây dựng tỉnh (soxaydung.<tỉnh>.gov.vn)',
  standard: 'ưu tiên tieuchuan.vsqi.gov.vn, tcvn.gov.vn',
  legal: 'ưu tiên vbpl.vn, vanban.chinhphu.vn, moc.gov.vn',
};
