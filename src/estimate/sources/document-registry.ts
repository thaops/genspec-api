export interface OfficialDocument {
  id: string;
  sourceId: string;
  documentType: 'circular' | 'decision' | 'price_announcement' | 'norm' | 'investment_rate';
  number: string;
  title: string;
  issuedDate: string;
  effectiveDate?: string;
  isActive: boolean;
  supersedes?: string[];
  applicableRegions?: string[];
  summary: string;
  tags: string[];
}

export const DOCUMENT_REGISTRY: OfficialDocument[] = [
  {
    id: 'tt_11_2021',
    sourceId: 'bxd_viet',
    documentType: 'circular',
    number: '11/2021/TT-BXD',
    title: 'Thông tư hướng dẫn một số nội dung xác định và quản lý chi phí đầu tư xây dựng',
    issuedDate: '2021-08-22',
    effectiveDate: '2021-10-09',
    isActive: true,
    summary: 'Hướng dẫn xác định tổng mức đầu tư, dự toán xây dựng, thanh quyết toán',
    tags: ['tổng mức đầu tư', 'dự toán', 'chi phí xây dựng', 'thanh quyết toán'],
  },
  {
    id: 'tt_12_2021',
    sourceId: 'bxd_viet',
    documentType: 'circular',
    number: '12/2021/TT-BXD',
    title: 'Thông tư ban hành định mức xây dựng',
    issuedDate: '2021-08-31',
    effectiveDate: '2021-10-17',
    isActive: true,
    summary: 'Định mức dự toán xây dựng công trình (thay thế QĐ 1091/QĐ-BXD)',
    tags: ['định mức', 'hao phí', 'vật liệu', 'nhân công', 'máy thi công'],
  },
  {
    id: 'tt_13_2021',
    sourceId: 'bxd_viet',
    documentType: 'circular',
    number: '13/2021/TT-BXD',
    title: 'Thông tư hướng dẫn phương pháp xác định các chỉ tiêu kinh tế kỹ thuật và đo bóc khối lượng công trình',
    issuedDate: '2021-08-31',
    effectiveDate: '2021-10-17',
    isActive: true,
    summary: 'Hướng dẫn đo bóc khối lượng, quy tắc tính toán',
    tags: ['bóc tách khối lượng', 'đo bóc', 'BOQ', 'quy tắc tính'],
  },
  {
    id: 'tt_14_2021',
    sourceId: 'bxd_viet',
    documentType: 'circular',
    number: '14/2021/TT-BXD',
    title: 'Thông tư hướng dẫn xác định và quản lý chỉ số giá xây dựng',
    issuedDate: '2021-08-31',
    effectiveDate: '2021-10-17',
    isActive: true,
    summary: 'Phương pháp xác định chỉ số giá xây dựng, điều chỉnh giá hợp đồng',
    tags: ['chỉ số giá', 'điều chỉnh giá', 'hợp đồng xây dựng'],
  },
  {
    id: 'qd_1776_bxd',
    sourceId: 'bxd_viet',
    documentType: 'norm',
    number: '1776/QĐ-BXD',
    title: 'Định mức dự toán xây dựng công trình (phần xây dựng)',
    issuedDate: '2007-08-16',
    effectiveDate: '2007-08-16',
    isActive: false,
    supersedes: [],
    summary: 'Định mức hao phí vật liệu, nhân công, máy thi công phần xây dựng (đã thay thế bởi TT12/2021)',
    tags: ['định mức cũ', 'hao phí', 'xây dựng'],
  },
  {
    id: 'qd_1777_bxd',
    sourceId: 'bxd_viet',
    documentType: 'norm',
    number: '1777/QĐ-BXD',
    title: 'Định mức dự toán xây dựng công trình (phần lắp đặt)',
    issuedDate: '2007-08-16',
    effectiveDate: '2007-08-16',
    isActive: false,
    summary: 'Định mức hao phí phần lắp đặt điện, nước, cơ điện',
    tags: ['định mức cũ', 'lắp đặt', 'MEP'],
  },
  {
    id: 'qd_610_bxd_2024',
    sourceId: 'bxd_viet',
    documentType: 'investment_rate',
    number: '610/QĐ-BXD',
    title: 'Suất vốn đầu tư xây dựng công trình và giá xây dựng tổng hợp bộ phận kết cấu công trình năm 2024',
    issuedDate: '2024-06-28',
    effectiveDate: '2024-06-28',
    isActive: true,
    summary: 'Suất vốn đầu tư tham khảo năm 2024 phân loại theo loại công trình và khu vực',
    tags: ['suất vốn đầu tư', 'benchmark', 'nhà ở', 'dân dụng', 'công nghiệp'],
  },
];

export function getActiveDocuments(): OfficialDocument[] {
  return DOCUMENT_REGISTRY.filter((d) => d.isActive);
}

export function getDocumentsByTag(tag: string): OfficialDocument[] {
  return DOCUMENT_REGISTRY.filter((d) => d.tags.some((t) => t.includes(tag.toLowerCase())));
}

export function getRelevantDocuments(tags: string[]): OfficialDocument[] {
  const lTags = tags.map((t) => t.toLowerCase());
  return DOCUMENT_REGISTRY.filter(
    (d) => d.isActive && d.tags.some((t) => lTags.some((lt) => t.includes(lt) || lt.includes(t))),
  );
}
