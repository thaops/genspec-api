export interface CatalogItem {
  code: string; // mã hiệu công tác, e.g. "AF.11111"
  name: string; // tên công tác
  unit: string; // đơn vị, e.g. "m3"
  group: string; // nhóm: Móng | Thân | Mái | Hoàn thiện | MEP ...
  // ⚠️ Đơn giá seed KHÔNG phải công bố giá chính thống — optional, KHÔNG surface ra người dùng.
  // Giá thật chỉ đến từ price_sets/price_items (import) hoặc data-hub material_prices (có nguồn).
  material?: number; // đơn giá vật liệu / đơn vị (VND) — chỉ dùng nội bộ, không authoritative
  labor?: number;
  machine?: number;
}

import type { NormComponent } from './catalog-db.schemas';

/** Shape trả về của GET /catalog — giữ nguyên CatalogItem + optional fields để FE cũ không vỡ. */
export interface CatalogSearchResult extends CatalogItem {
  source?: string; // 'seed' | sourceDoc đã import (vd "TT12/2021")
  province?: string; // tỉnh của bộ giá dùng để tính VL/NC/M
  components?: NormComponent[]; // hao phí định mức (nếu từ norm_items)
}
