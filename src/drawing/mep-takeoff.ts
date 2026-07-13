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
import { MEP_COUNT_TYPES, MEP_LENGTH_TYPES } from './services/drawing-detector.service';

export interface MepObject {
  type: string;
  floor?: string;
  geometry?: number[][];
  ambiguous?: boolean;
}

export interface MepRow {
  type: string;
  kind: 'count' | 'length';
  unit: string; // 'cái' | 'm'
  quantity: number;
  floor?: string;
}

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
  for (const [k, q] of counts) { const { type, floor } = split(k); rows.push({ type, kind: 'count', unit: 'cái', quantity: q, floor }); }
  for (const [k, q] of lengths) { const { type, floor } = split(k); rows.push({ type, kind: 'length', unit: 'm', quantity: Math.round(q * 1000) / 1000, floor }); }
  // Ổn định: count trước, rồi length; trong nhóm theo tên
  return rows.sort((a, b) => (a.kind === b.kind ? a.type.localeCompare(b.type) : a.kind === 'count' ? -1 : 1));
}
