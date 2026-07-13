/**
 * Building Graph — tầng ngữ nghĩa Building → Floor → Room → Object.
 *
 * PURE (không Mongo/Nest) để verify trực tiếp. Biến list object phẳng thành cây
 * ngữ nghĩa mà QS suy nghĩ theo, và trả lời được các câu hỏi:
 *   "Tầng 3 có bao nhiêu đèn?"        → countType(objs, 'light', { floor: '3' })
 *   "Phòng nào chưa có ổ cắm?"        → roomsMissingType(objs, 'socket')
 *   "Mỗi tầng có gì?"                 → perFloorTypeCounts(objs)
 *
 * KHÔNG bịa: chỉ đếm/nhóm object đã nhận diện (bỏ ambiguous/unknown/ignored).
 * Room chỉ có khi detector sinh object type='room' (S3b) — hàm sẵn sàng, tự kích
 * hoạt khi room xuất hiện, không cần sửa lại.
 */

export interface GraphObject {
  stableId: string;
  type: string;
  floor?: string;
  layer?: string;
  boundingBox: { x: number; y: number; w: number; h: number; page?: number };
  ambiguous?: boolean;
}

export interface FloorNode {
  floor: string;
  objectCount: number;
  typeCounts: Record<string, number>;
  rooms: RoomNode[];
}

export interface RoomNode {
  stableId: string;
  name: string;
  floor?: string;
  objectCount: number;
  typeCounts: Record<string, number>;
  memberStableIds: string[];
}

export interface BuildingGraph {
  floors: FloorNode[];
  /** Object không nhận diện được tầng (floor rỗng) — gom riêng để không mất. */
  unassignedFloorCount: number;
  totalObjects: number;
}

const NON_SEMANTIC = new Set(['ambiguous', 'ignored', 'unknown', 'text', 'dimension', 'symbol', 'hatch', 'axis']);

/** Object được tính vào graph ngữ nghĩa (đã settle class, không phải chú thích/nét kỹ thuật). */
export function isSemanticObject(o: GraphObject): boolean {
  return !o.ambiguous && !NON_SEMANTIC.has(o.type);
}

const FLOOR_UNKNOWN = '(chưa xác định tầng)';

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

/** Tâm bbox. */
function center(b: GraphObject['boundingBox']): { cx: number; cy: number } {
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

/** Điểm (cx,cy) nằm trong bbox room (cùng page nếu có). */
function contains(room: GraphObject['boundingBox'], p: { cx: number; cy: number }): boolean {
  return p.cx >= room.x && p.cx <= room.x + room.w && p.cy >= room.y && p.cy <= room.y + room.h;
}

/**
 * Gán mỗi object (không phải room) vào room chứa tâm nó. Nếu nhiều room lồng
 * nhau cùng chứa → chọn room DIỆN TÍCH NHỎ NHẤT (phòng cụ thể nhất). PURE.
 * Trả về map roomStableId → memberStableIds và danh sách room chưa gán được.
 */
export function assignObjectsToRooms(objects: GraphObject[]): Map<string, string[]> {
  const rooms = objects.filter((o) => o.type === 'room');
  const members = new Map<string, string[]>();
  for (const r of rooms) members.set(r.stableId, []);
  if (rooms.length === 0) return members;

  for (const o of objects) {
    if (o.type === 'room' || !isSemanticObject(o)) continue;
    const p = center(o.boundingBox);
    let best: GraphObject | null = null;
    let bestArea = Infinity;
    for (const r of rooms) {
      if (o.boundingBox.page != null && r.boundingBox.page != null && o.boundingBox.page !== r.boundingBox.page) continue;
      // Cùng tầng mới gán (toạ độ 2 tầng có thể chồng nhau) — tránh đèn tầng 2 lọt vào phòng tầng 3.
      if (o.floor?.trim() && r.floor?.trim() && o.floor.trim() !== r.floor.trim()) continue;
      if (!contains(r.boundingBox, p)) continue;
      const area = r.boundingBox.w * r.boundingBox.h;
      if (area < bestArea) { bestArea = area; best = r; }
    }
    if (best) members.get(best.stableId)!.push(o.stableId);
  }
  return members;
}

/** Tên hiển thị room: properties.name/label nếu có, else layer, else stableId. */
function roomName(r: GraphObject & { properties?: Record<string, unknown> }): string {
  const props = (r as any).properties ?? {};
  return String(props.name ?? props.label ?? props.room ?? r.layer ?? r.stableId);
}

/** Dựng cây Building → Floor → Room → Object. PURE. */
export function assembleBuilding(objects: GraphObject[]): BuildingGraph {
  const semantic = objects.filter(isSemanticObject);
  const roomMembers = assignObjectsToRooms(objects);
  const roomById = new Map(objects.filter((o) => o.type === 'room').map((o) => [o.stableId, o]));

  // Room node theo stableId
  const roomNodes = new Map<string, RoomNode>();
  for (const [roomId, memberIds] of roomMembers) {
    const r = roomById.get(roomId)!;
    const typeCounts: Record<string, number> = {};
    const memberObjs = memberIds.map((id) => objects.find((o) => o.stableId === id)!).filter(Boolean);
    for (const m of memberObjs) bump(typeCounts, m.type);
    roomNodes.set(roomId, {
      stableId: roomId,
      name: roomName(r as any),
      floor: r.floor,
      objectCount: memberObjs.length,
      typeCounts,
      memberStableIds: memberIds,
    });
  }

  // Floor node
  const floors = new Map<string, FloorNode>();
  for (const o of semantic) {
    if (o.type === 'room') continue; // room không tự đếm là "object" trong floor typeCounts
    const key = o.floor?.trim() || FLOOR_UNKNOWN;
    let fn = floors.get(key);
    if (!fn) { fn = { floor: key, objectCount: 0, typeCounts: {}, rooms: [] }; floors.set(key, fn); }
    fn.objectCount += 1;
    bump(fn.typeCounts, o.type);
  }
  // Gắn room vào floor
  for (const rn of roomNodes.values()) {
    const key = rn.floor?.trim() || FLOOR_UNKNOWN;
    let fn = floors.get(key);
    if (!fn) { fn = { floor: key, objectCount: 0, typeCounts: {}, rooms: [] }; floors.set(key, fn); }
    fn.rooms.push(rn);
  }

  const unassignedFloorCount = semantic.filter((o) => o.type !== 'room' && !(o.floor?.trim())).length;
  return {
    floors: [...floors.values()].sort((a, b) => a.floor.localeCompare(b.floor, 'vi', { numeric: true })),
    unassignedFloorCount,
    totalObjects: semantic.length,
  };
}

/** Đếm số object 1 loại, lọc theo tầng nếu có. "Tầng 3 bao nhiêu đèn?" PURE. */
export function countType(objects: GraphObject[], type: string, opts?: { floor?: string }): number {
  return objects.filter(
    (o) => isSemanticObject(o) && o.type === type && (!opts?.floor || (o.floor?.trim() || '') === opts.floor.trim()),
  ).length;
}

/** typeCounts theo từng tầng. PURE. */
export function perFloorTypeCounts(objects: GraphObject[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const o of objects) {
    if (!isSemanticObject(o) || o.type === 'room') continue;
    const key = o.floor?.trim() || FLOOR_UNKNOWN;
    (out[key] ??= {});
    bump(out[key], o.type);
  }
  return out;
}

/**
 * Room chưa có object loại `requiredType` (vd 'socket', 'smoke_detector', 'lavabo').
 * "Phòng nào chưa có ổ cắm?". Chỉ chạy khi có room (S3b) — rỗng nếu chưa detect room.
 * PURE — nền cho AI Review (Sprint 6).
 */
export function roomsMissingType(objects: GraphObject[], requiredType: string): RoomNode[] {
  const building = assembleBuilding(objects);
  const missing: RoomNode[] = [];
  for (const f of building.floors) {
    for (const r of f.rooms) {
      if (!(r.typeCounts[requiredType] > 0)) missing.push(r);
    }
  }
  return missing;
}
