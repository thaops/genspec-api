/**
 * Expand INSERT (block reference) entities thành GEOMETRY THẬT cho luồng
 * detect/takeoff — DWG parser (WASM) trước đây KHÔNG làm việc này.
 *
 * BUG ĐÃ XÁC NHẬN (file thật "KT.dwg"): 221 cửa vẽ bằng block INSERT trên layer
 * "cua" → dwg-parser.service.ts chỉ map insertion point (x,y), không có
 * width/height thật → boundingBox() fallback về 1×1 (đơn vị vẽ) cho MỌI cửa →
 * diện tích tính sai. Đa số cửa dùng block ẨN DANH (*U<n>, AutoCAD tự sinh tên)
 * — extractBlocks() cũng đã sửa để KHÔNG lọc bỏ các block này nữa.
 *
 * BUG THỨ 2 phát hiện khi verify (round 1 của fix này): expand "phẳng" — đẩy
 * MỌI sub-entity của 1 block (khung + cánh + vòng cung mở cửa…) thành các
 * RawEntity ĐỘC LẬP — mỗi mảnh bị detector đếm là 1 "cửa" riêng → 221 cửa vật
 * lý thành 1467 "cửa" phát hiện, diện tích phồng ~34 lần. TỆ HƠN bug gốc (số
 * khống thay vì số thiếu). Fix: mọi sub-entity thuộc CÙNG 1 INSERT (kể cả
 * INSERT lồng bên trong) được GỘP thành đúng 1 bbox hợp nhất — giữ bất biến
 * "1 block instance = 1 cấu kiện" mà detector/takeoff engine giả định.
 *
 * ATTRIB (nhãn text gắn trên insert, vd tên phòng) là ngoại lệ: giữ ĐỘC LẬP,
 * không gộp vào bbox cửa/cấu kiện — chúng là text, không phải hình học cấu kiện.
 *
 * DXF parser đã tự expandInsert lúc parse (dxf-parser.service.ts) nên không
 * dính bug này — nếu DXF cũng có multi-part block thì đó là vấn đề riêng, NGOÀI
 * phạm vi fix này (chỉ nhắm đúng đường DWG/WASM).
 */
import type { RawEntity } from '../parsers/drawing-parser.interface';
import type { DwgBlockDef } from '../parsers/dwg-parser.service';

const MAX_BLOCK_DEPTH = 4;

type Affine = (x: number, y: number) => [number, number];

function num(v: unknown, d = 0): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && isFinite(n) ? n : d;
}

/** Thay mọi INSERT trong danh sách entity bằng ĐÚNG 1 entity hình học đã hợp nhất; giữ nguyên các entity khác. */
export function expandInsertEntities(
  entities: RawEntity[],
  blocks: Record<string, DwgBlockDef>,
): RawEntity[] {
  const out: RawEntity[] = [];
  for (const e of entities) {
    if (e.type !== 'INSERT') { out.push(e); continue; }
    const geomParts: RawEntity[] = [];
    const attribParts: RawEntity[] = [];
    const resolved = collectOne(e, (x, y) => [x, y], 1, 0, geomParts, attribParts, blocks, 0, new Set());

    // stableId (DrawingNormalizerService) = hash(layer, type, bbox, `handle|text`).
    // ATTRIB của INSERT LỒNG lấy thẳng từ ĐỊNH NGHĨA block — dùng chung cho MỌI lần
    // chèn → cùng handle + cùng text + cùng bbox → TRÙNG stableId → `insertMany` ném
    // E11000 và parse CHẾT TOÀN BỘ bản vẽ. Đã xảy ra thật trên production
    // ("dup key: stableId 29b508bfe966cc56", 551 nhóm trùng trên F550).
    // Gắn handle dẫn xuất từ handle của chính INSERT (duy nhất trong file) + chỉ số:
    // vừa DUY NHẤT, vừa TẤT ĐỊNH (parse lại ra id y hệt — không phá stableId contract).
    const insHandle = String(e.properties?.handle ?? '');
    for (let i = 0; i < attribParts.length; i++) {
      const a = attribParts[i];
      out.push({ ...a, properties: { ...a.properties, handle: `${insHandle}/a${i}` } });
    }

    if (!resolved || geomParts.length === 0) {
      out.push(e); // không có block def → giữ nguyên (không bịa), guard downstream tự loại
      continue;
    }
    out.push(unionOf(e, geomParts));
  }
  return out;
}

/** Đệ quy thu thập geometry (geomParts) + attrib text (attribParts) của 1 INSERT. Trả false nếu không resolve được block. */
function collectOne(
  e: RawEntity,
  tf: Affine,
  scaleMag: number,
  rotDeg: number,
  geomParts: RawEntity[],
  attribParts: RawEntity[],
  blocks: Record<string, DwgBlockDef>,
  depth: number,
  visiting: Set<string>,
): boolean {
  // ATTRIB áp transform của CHA (`tf`), KHÔNG áp transform của chính insert này —
  // giống hệt `dwg-scene-adapter.ts` (bản render vốn đã đúng).
  //  · depth 0  : tf = identity → attrib giữ nguyên toạ độ WORLD (DWG trả sẵn world).
  //  · depth > 0: attrib nằm trong ĐỊNH NGHĨA block → toạ độ BLOCK-LOCAL → phải qua
  //    tf của cha mới thành world. Bỏ bước này (bản đầu) khiến MỌI lần chèn đặt attrib
  //    trùng một chỗ → sai vị trí VÀ sinh trùng stableId → parse chết.
  // KHÔNG gộp vào bbox cấu kiện (attrib là text nhãn, không phải hình học cửa).
  if (e.attribs) attribParts.push(...e.attribs.map((a) => transformEntity(a, tf, scaleMag, rotDeg)));

  const name = String(e.blockName ?? e.properties?.blockName ?? '');
  const def = blocks[name];
  if (!def || depth >= MAX_BLOCK_DEPTH || visiting.has(name)) return false;

  const sx = num(e.properties?.scaleX, 1) || 1;
  const sy = num(e.properties?.scaleY, 1) || 1;
  const rot = num(e.properties?.rotation); // radian
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const [ix, iy] = tf(e.x, e.y);
  const bx = def.basePoint.x, by = def.basePoint.y;
  // Toạ độ block-local → offset từ basePoint, xoay/scale theo insert, rồi cộng
  // vào điểm chèn đã transform qua cha (ix,iy) — KHÔNG gọi lại tf trên toạ độ
  // đã cộng (world gốc khác), nên viết trực tiếp bằng ix/iy.
  const childTf: Affine = (x, y) => {
    const lx = (x - bx) * sx;
    const ly = (y - by) * sy;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    return [ix + rx * scaleMag, iy + ry * scaleMag];
  };
  const avgScale = (Math.abs(sx) + Math.abs(sy)) / 2;
  const childRotDeg = rotDeg + (rot * 180) / Math.PI;
  const nextVisiting = new Set(visiting).add(name);

  for (const child of def.entities) {
    if (child.type === 'INSERT') {
      // INSERT lồng bên trong: vẫn gộp vào CÙNG geomParts/attribParts của insert
      // ngoài cùng — cả cụm (vd khung cửa + cánh cửa là 2 block lồng nhau) vẫn
      // ra đúng 1 cấu kiện ở tầng expandInsertEntities().
      collectOne(child, childTf, scaleMag * avgScale, childRotDeg, geomParts, attribParts, blocks, depth + 1, nextVisiting);
      continue;
    }
    geomParts.push(transformEntity(child, childTf, scaleMag * avgScale, childRotDeg));
  }
  return true;
}

/** Áp affine lên 1 entity KHÔNG phải INSERT — trả bản sao đã biến đổi toạ độ. */
function transformEntity(e: RawEntity, tf: Affine, scaleMag: number, rotDeg: number): RawEntity {
  const [x, y] = tf(e.x, e.y);
  const out: RawEntity = { ...e, x, y };
  if (e.x2 !== undefined && e.y2 !== undefined) {
    const [x2, y2] = tf(e.x2, e.y2);
    out.x2 = x2; out.y2 = y2;
  }
  if (e.vertices) out.vertices = e.vertices.map(([vx, vy]) => tf(vx, vy));
  if (e.radius !== undefined) out.radius = e.radius * scaleMag;
  return out;
}

/** Đường chéo bbox cục bộ của 1 mảnh (đơn vị vẽ) — dùng để lọc outlier. */
function partDiagonal(p: RawEntity): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  const r = p.radius ?? 0;
  if (p.vertices) for (const [vx, vy] of p.vertices) extend(vx, vy);
  else {
    extend(p.x - r, p.y - r);
    extend(p.x + r, p.y + r);
    if (p.x2 !== undefined && p.y2 !== undefined) extend(p.x2, p.y2);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * Hợp nhất mọi mảnh geometry của 1 INSERT thành ĐÚNG 1 entity (bbox bao trọn).
 * Lọc outlier trước hợp nhất: file DWG thường có 1 vertex/HATCH lạc trong định
 * nghĩa block (dữ liệu nguồn nhiễu, không phải lỗi expand) — đã xác nhận thật
 * trên "KT.dwg" (block "CKHO1" có 1 mảnh khiến bbox cửa phồng lên hàng km²).
 * Cùng pattern median-outlier-rejection đã dùng cho hatch/factor calibration
 * ở nơi khác trong engine — mảnh lệch median >20 lần bị loại trước khi union.
 */
function unionOf(original: RawEntity, parts: RawEntity[]): RawEntity {
  let survivors = parts;
  if (parts.length >= 3) {
    const diags = parts.map(partDiagonal).sort((a, b) => a - b);
    const median = diags[Math.floor(diags.length / 2)] || 1;
    survivors = parts.filter((p) => partDiagonal(p) <= median * 20);
    if (survivors.length === 0) survivors = parts; // mọi mảnh đều "outlier" so với nhau → giữ hết, không đoán bỏ hết
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of survivors) {
    const r = p.radius ?? 0;
    if (p.vertices) for (const [vx, vy] of p.vertices) extend(vx, vy);
    else {
      extend(p.x - r, p.y - r);
      extend(p.x + r, p.y + r);
      if (p.x2 !== undefined && p.y2 !== undefined) extend(p.x2, p.y2);
    }
  }
  return {
    type: original.type, // 'INSERT' — layer đã đủ để LAYER_TYPE_MAP phân loại (vd 'cua'→door)
    layer: original.layer,
    x: minX, y: minY, x2: maxX, y2: maxY,
    vertices: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
    blockName: original.blockName,
    properties: original.properties,
  };
}
