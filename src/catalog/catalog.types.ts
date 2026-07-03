export interface CatalogItem {
  code: string; // mã hiệu công tác, e.g. "AF.11111"
  name: string; // tên công tác
  unit: string; // đơn vị, e.g. "m3"
  group: string; // nhóm: Móng | Thân | Mái | Hoàn thiện | MEP ...
  material: number; // đơn giá vật liệu / đơn vị (VND)
  labor: number; // đơn giá nhân công / đơn vị (VND)
  machine: number; // đơn giá máy / đơn vị (VND)
}

import type { NormComponent } from './catalog-db.schemas';

/** Shape trả về của GET /catalog — giữ nguyên CatalogItem + optional fields để FE cũ không vỡ. */
export interface CatalogSearchResult extends CatalogItem {
  source?: string; // 'seed' | sourceDoc đã import (vd "TT12/2021")
  province?: string; // tỉnh của bộ giá dùng để tính VL/NC/M
  components?: NormComponent[]; // hao phí định mức (nếu từ norm_items)
}
