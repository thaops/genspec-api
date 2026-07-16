/**
 * MEP takeoff — bóc khối lượng Điện/Nước/HVAC.
 *
 * PURE. Khác KT/KC (đo m²/m³): MEP bóc theo 2 kiểu deterministic, KHÔNG bịa:
 *   - COUNT : đếm số lượng thiết bị (đèn, ổ cắm, công tắc, tủ điện, TBVS, van…)
 *   - LENGTH: đo chiều dài tuyến (dây, ống, máng cáp, ống gió) = polyline length × factor (→ m)
 *
 * Nguồn loại: MEP_COUNT_TYPES / MEP_LENGTH_TYPES trong drawing-detector.
 * Đơn giá MEP (thiết bị → mã định mức) là bước riêng cần dữ liệu norm MEP — ở đây
 * chỉ trả KHỐI LƯỢNG có truy vết, không gắn giá bịa.
 */
import { MEP_COUNT_TYPES, MEP_LENGTH_TYPES } from './mep-types';

export interface MepObject {
  type: string;
  floor?: string;
  geometry?: number[][];
  ambiguous?: boolean;
}

export interface MepRow {
  type: string;
  label: string; // tên tiếng Việt (dùng để khớp giá theo tên)
  kind: 'count' | 'length';
  unit: string; // bộ | cái | m …
  quantity: number;
  floor?: string;
  /** Đơn giá khớp từ price DB theo tên (undefined = chưa có giá, KHÔNG bịa). */
  unitPrice?: number;
  totalPrice?: number;
  priceSource?: string;
}

/** Đơn vị chuẩn theo loại MEP (VN). */
export const MEP_UNIT: Record<string, string> = {
  light: 'bộ', socket: 'cái', switch: 'cái', electric_panel: 'cái',
  sanitary: 'bộ', valve: 'cái', floor_drain: 'cái', diffuser: 'cái',
  hvac_unit: 'bộ', smoke_detector: 'cái',
  wire: 'm', conduit: 'm', cable_tray: 'm', pipe: 'm', duct: 'm',
};

/** Nhãn tiếng Việt cho từng loại MEP (hiển thị BOQ). */
export const MEP_LABEL: Record<string, string> = {
  light: 'Đèn', socket: 'Ổ cắm', switch: 'Công tắc', electric_panel: 'Tủ điện',
  sanitary: 'Thiết bị vệ sinh', valve: 'Van', floor_drain: 'Hố ga/thoát sàn',
  diffuser: 'Miệng gió', hvac_unit: 'Máy điều hòa/AHU/FCU', smoke_detector: 'Đầu báo cháy',
  wire: 'Dây điện', conduit: 'Ống luồn dây', cable_tray: 'Máng cáp', pipe: 'Ống nước', duct: 'Ống gió',
};

/** Chiều dài polyline (tổng đoạn) × factor → m. */
function polylineLength(geom: number[][] | undefined, factor: number): number {
  if (!geom || geom.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < geom.length; i++) {
    const dx = (geom[i][0] ?? 0) - (geom[i - 1][0] ?? 0);
    const dy = (geom[i][1] ?? 0) - (geom[i - 1][1] ?? 0);
    len += Math.hypot(dx, dy);
  }
  return len * factor;
}

/**
 * Bóc MEP: gom theo (type) — COUNT cho thiết bị, LENGTH cho tuyến. `byFloor=true`
 * tách theo tầng. Bỏ object ambiguous (chưa settle class). PURE.
 */
export function mepTakeoff(objects: MepObject[], factor: number, byFloor = false): MepRow[] {
  const counts = new Map<string, number>();
  const lengths = new Map<string, number>();
  const keyOf = (type: string, floor?: string) => (byFloor ? `${type}@@${floor?.trim() || '?'}` : type);

  for (const o of objects) {
    if (o.ambiguous) continue;
    if (MEP_COUNT_TYPES.has(o.type)) {
      counts.set(keyOf(o.type, o.floor), (counts.get(keyOf(o.type, o.floor)) ?? 0) + 1);
    } else if (MEP_LENGTH_TYPES.has(o.type)) {
      const L = polylineLength(o.geometry, factor);
      if (L > 0) lengths.set(keyOf(o.type, o.floor), (lengths.get(keyOf(o.type, o.floor)) ?? 0) + L);
    }
  }

  const rows: MepRow[] = [];
  const split = (k: string) => { const [type, floor] = k.split('@@'); return { type, floor: byFloor ? floor : undefined }; };
  const label = (type: string) => MEP_LABEL[type] ?? type;
  const unit = (type: string, fallback: string) => MEP_UNIT[type] ?? fallback;
  for (const [k, q] of counts) { const { type, floor } = split(k); rows.push({ type, label: label(type), kind: 'count', unit: unit(type, 'cái'), quantity: q, floor }); }
  for (const [k, q] of lengths) { const { type, floor } = split(k); rows.push({ type, label: label(type), kind: 'length', unit: unit(type, 'm'), quantity: Math.round(q * 1000) / 1000, floor }); }
  // Ổn định: count trước, rồi length; trong nhóm theo tên
  return rows.sort((a, b) => (a.kind === b.kind ? a.type.localeCompare(b.type) : a.kind === 'count' ? -1 : 1));
}

function normalizeName(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}

/**
 * Định giá MEP theo TÊN fixture khớp price DB (fuzzy 2 chiều) — giống pricing vật
 * tư, KHÔNG bịa mã/giá. Không khớp → để trống (đúng nguyên tắc). PURE.
 * `prices`: từ price_items/material_prices (đã có nguồn).
 */
export function priceMepRows(
  rows: MepRow[],
  prices: { name: string; price: number; source?: string }[],
): MepRow[] {
  return rows.map((r) => {
    const q = normalizeName(r.label);
    const hit = prices.find((p) => { const pn = normalizeName(p.name); return pn === q || pn.includes(q) || q.includes(pn); });
    if (!hit) return r;
    return { ...r, unitPrice: hit.price, totalPrice: Math.round(hit.price * r.quantity), priceSource: hit.source ?? 'price DB' };
  });
}
