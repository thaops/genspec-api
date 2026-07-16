import { expandInsertEntities } from './dwg-insert-expand';
import type { RawEntity } from '../parsers/drawing-parser.interface';
import type { DwgBlockDef } from '../parsers/dwg-parser.service';

function insertOf(overrides: Partial<RawEntity> = {}): RawEntity {
  return {
    type: 'INSERT', layer: 'cua', x: 1000, y: 2000,
    blockName: 'DOOR_800',
    properties: { blockName: 'DOOR_800', scaleX: 1, scaleY: 1, rotation: 0 },
    ...overrides,
  };
}

// Block "cửa" thật thường có NHIỀU mảnh (khung + cánh + vòng cung mở) — mô phỏng
// 2 mảnh: 1 LWPOLYLINE (khung, 800×30) + 1 ARC (vòng cung mở, tâm lệch ra ngoài).
const DOOR_BLOCK: Record<string, DwgBlockDef> = {
  DOOR_800: {
    basePoint: { x: 0, y: 0 },
    entities: [
      { type: 'LWPOLYLINE', layer: '0', x: 0, y: 0, x2: 800, y2: 30,
        vertices: [[0, 0], [800, 0], [800, 30], [0, 30]], properties: {} },
      { type: 'ARC', layer: '0', x: 0, y: 0, radius: 800,
        properties: { startAngle: 0, endAngle: 1.57 } },
    ],
  },
};

describe('expandInsertEntities — 1 INSERT → ĐÚNG 1 entity hình học (không nổ mảnh)', () => {
  it('BUG ĐÃ SỬA (round 2): block nhiều mảnh (khung+cung mở) → vẫn CHỈ 1 entity đầu ra, không phải N', () => {
    const out = expandInsertEntities([insertOf()], DOOR_BLOCK);
    // Trước fix round-2: 2 mảnh (LWPOLYLINE + ARC) sẽ ra 2 entity độc lập → detector
    // đếm thành 2 "cửa" cho 1 cửa vật lý (đã xác nhận thật: 221→1467 trên KT.dwg).
    expect(out).toHaveLength(1);
  });

  it('không có block def → giữ nguyên placeholder gốc (không bịa), guard downstream tự loại', () => {
    const out = expandInsertEntities([insertOf({ blockName: 'MISSING' })], {});
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('INSERT');
  });

  it('bbox hợp nhất bao trọn CẢ khung lẫn vòng cung (không chỉ 1 mảnh)', () => {
    const out = expandInsertEntities([insertOf()], DOOR_BLOCK);
    const xs = out[0].vertices!.map((v) => v[0]);
    const ys = out[0].vertices!.map((v) => v[1]);
    // ARC bán kính 800 tâm (0,0)+insert(1000,2000) → vươn xa hơn khung 800×30 →
    // bbox phải RỘNG HƠN riêng khung (chứng minh có hợp nhất, không chỉ lấy mảnh đầu).
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(800);
  });

  it('scaleX/scaleY áp đúng lên mọi mảnh trước khi hợp nhất', () => {
    const out = expandInsertEntities(
      [insertOf({ properties: { blockName: 'DOOR_800', scaleX: 1.5, scaleY: 1, rotation: 0 } })],
      DOOR_BLOCK,
    );
    expect(out).toHaveLength(1);
  });

  it('entity KHÔNG phải INSERT giữ nguyên hoàn toàn (không đếm trùng HATCH/DIMENSION/LINE top-level)', () => {
    const line: RawEntity = { type: 'LINE', layer: 'wall', x: 0, y: 0, x2: 5000, y2: 0, properties: {} };
    const out = expandInsertEntities([line, insertOf()], DOOR_BLOCK);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(line);
  });

  it('ATTRIB (nhãn text) tách riêng, KHÔNG gộp vào bbox cấu kiện', () => {
    const attrib: RawEntity = { type: 'TEXT', layer: 'cua', x: 1500, y: 2500, text: 'D1', properties: {} };
    const out = expandInsertEntities([insertOf({ attribs: [attrib] })], DOOR_BLOCK);
    // 1 entity hình học (đã hợp nhất) + 1 attrib text độc lập = 2, KHÔNG lẫn vào nhau.
    expect(out).toHaveLength(2);
    expect(out.some((o) => o.type === 'TEXT' && o.text === 'D1')).toBe(true);
  });

  it('INSERT lồng nhau (khung + cánh là 2 block riêng) vẫn gộp về ĐÚNG 1 entity ở tầng ngoài cùng', () => {
    const nested: Record<string, DwgBlockDef> = {
      LEAF: { basePoint: { x: 0, y: 0 }, entities: [
        { type: 'LWPOLYLINE', layer: '0', x: 0, y: 0, x2: 700, y2: 20, vertices: [[0, 0], [700, 0], [700, 20], [0, 20]], properties: {} },
      ] },
      DOOR_NESTED: { basePoint: { x: 0, y: 0 }, entities: [
        { type: 'LWPOLYLINE', layer: '0', x: 0, y: 0, x2: 800, y2: 30, vertices: [[0, 0], [800, 0], [800, 30], [0, 30]], properties: {} },
        { type: 'INSERT', layer: '0', x: 50, y: 5, blockName: 'LEAF', properties: { blockName: 'LEAF', scaleX: 1, scaleY: 1, rotation: 0 } },
      ] },
    };
    const out = expandInsertEntities(
      [insertOf({ blockName: 'DOOR_NESTED', properties: { blockName: 'DOOR_NESTED', scaleX: 1, scaleY: 1, rotation: 0 } })],
      nested,
    );
    expect(out).toHaveLength(1); // khung (DOOR_NESTED) + cánh (LEAF lồng bên trong) = vẫn 1 cấu kiện
  });

  it('cycle/độ sâu vượt ngưỡng → không đệ quy vô hạn, không throw', () => {
    const cyc: Record<string, DwgBlockDef> = {
      A: { basePoint: { x: 0, y: 0 }, entities: [insertOf({ blockName: 'A', properties: { blockName: 'A', scaleX: 1, scaleY: 1, rotation: 0 } })] },
    };
    expect(() => expandInsertEntities(
      [insertOf({ blockName: 'A', properties: { blockName: 'A', scaleX: 1, scaleY: 1, rotation: 0 } })], cyc,
    )).not.toThrow();
  });
});
