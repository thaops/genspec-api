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

  /**
   * REGRESSION PRODUCTION (đã xảy ra thật): parse F550 chết với
   * `E11000 dup key: { stableId: "29b508bfe966cc56" }` — 551 nhóm trùng.
   * stableId = hash(layer, type, bbox, `handle|text`) nên 2 entity cùng handle +
   * cùng text + cùng bbox là TRÙNG → insertMany ném lỗi → hỏng CẢ bản vẽ.
   */
  describe('REGRESSION: ATTRIB của block lồng không được sinh trùng stableId', () => {
    const NESTED_ATTRIB: Record<string, DwgBlockDef> = {
      // Block cha chứa INSERT con; INSERT con mang ATTRIB toạ độ BLOCK-LOCAL.
      INNER: { basePoint: { x: 0, y: 0 }, entities: [
        { type: 'LWPOLYLINE', layer: '0', x: 0, y: 0, x2: 100, y2: 100, vertices: [[0,0],[100,0],[100,100],[0,100]], properties: {} },
      ] },
      OUTER: { basePoint: { x: 0, y: 0 }, entities: [
        { type: 'LWPOLYLINE', layer: '0', x: 0, y: 0, x2: 800, y2: 30, vertices: [[0,0],[800,0],[800,30],[0,30]], properties: {} },
        { type: 'INSERT', layer: '0', x: 10, y: 10, blockName: 'INNER',
          properties: { blockName: 'INNER', scaleX: 1, scaleY: 1, rotation: 0, handle: 'SHARED' },
          attribs: [{ type: 'TEXT', layer: '0', x: 5, y: 5, text: '2', properties: { handle: 'SHARED_ATTR' } }] },
      ] },
    };
    const outerAt = (x: number, y: number, handle: string): RawEntity => ({
      type: 'INSERT', layer: 'cua', x, y, blockName: 'OUTER',
      properties: { blockName: 'OUTER', scaleX: 1, scaleY: 1, rotation: 0, handle },
    });

    it('cùng block chèn 3 lần → ATTRIB phải có handle KHÁC NHAU (không trùng stableId)', () => {
      const out = expandInsertEntities(
        [outerAt(0, 0, 'H1'), outerAt(5000, 0, 'H2'), outerAt(9000, 0, 'H3')],
        NESTED_ATTRIB,
      );
      const attrs = out.filter((o) => o.type === 'TEXT');
      expect(attrs).toHaveLength(3);
      const handles = attrs.map((a) => String(a.properties.handle));
      expect(new Set(handles).size).toBe(3); // TRƯỚC fix: cả 3 đều 'SHARED_ATTR' → trùng
    });

    it('ATTRIB block-local phải được transform ra WORLD theo vị trí chèn (không dồn 1 chỗ)', () => {
      const out = expandInsertEntities(
        [outerAt(0, 0, 'H1'), outerAt(5000, 0, 'H2')],
        NESTED_ATTRIB,
      );
      const xs = out.filter((o) => o.type === 'TEXT').map((a) => a.x);
      expect(new Set(xs).size).toBe(2); // TRƯỚC fix: cả 2 cùng x=5 → sai vị trí + trùng
      expect(Math.abs(xs[1] - xs[0])).toBeCloseTo(5000, 3); // đúng khoảng cách 2 lần chèn
    });

    it('ATTRIB top-level (depth 0) giữ NGUYÊN toạ độ world — không transform 2 lần', () => {
      const attrib: RawEntity = { type: 'TEXT', layer: 'cua', x: 1500, y: 2500, text: 'D1', properties: { handle: 'A9' } };
      const out = expandInsertEntities([insertOf({ attribs: [attrib] })], DOOR_BLOCK);
      const t = out.find((o) => o.type === 'TEXT')!;
      expect(t.x).toBe(1500);
      expect(t.y).toBe(2500);
    });
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
