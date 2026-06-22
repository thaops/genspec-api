export interface CatalogItem {
  code: string; // mã hiệu công tác, e.g. "AF.11111"
  name: string; // tên công tác
  unit: string; // đơn vị, e.g. "m3"
  group: string; // nhóm: Móng | Thân | Mái | Hoàn thiện | MEP ...
  material: number; // đơn giá vật liệu / đơn vị (VND)
  labor: number; // đơn giá nhân công / đơn vị (VND)
  machine: number; // đơn giá máy / đơn vị (VND)
}
