import { Injectable } from '@nestjs/common';
import { MIN_SECTION_M, SECTION_TYPES } from '../../estimate/takeoff-engine.service';
import { normalizeLayerName } from '../layer-name';

export interface NormalizedObject {
  stableId: string;
  rawType: string;
  layer: string;
  boundingBox: { x: number; y: number; w: number; h: number; page?: number };
  geometry: number[][];
  text?: string;
  properties: Record<string, string | number>;
  floor?: string;
}

export type DetectionRule =
  | 'layer_override'  // per-project user rule (Tier 2) — highest priority
  | 'layer_map'       // layer name matched LAYER_TYPE_MAP
  | 'label_pattern'   // text label matched regex
  | 'aspect_ratio'    // bounding box ratio heuristic
  | 'geometry'        // shape heuristic (layer-independent, multi-candidate)
  | 'topology'        // spatial-relation refinement (Tier 2.5)
  | 'entity_type'     // DXF entity type fallback
  | 'discipline_gate' // type ngoài bộ môn của bản vẽ → hạ về symbol (V1)
  | 'none';           // unclassified

/**
 * GATE BỘ MÔN (V1) — mỗi bản vẽ chỉ được sinh cấu kiện THUỘC bộ môn của nó.
 *
 * Root cause đã đo: detector phân loại theo hình học/layer HOÀN TOÀN MÙ bộ môn, nên bản
 * NƯỚC ra 408 "cột" + 248 "tường" (circle=đèn/thiết bị → column; 2 nét song song → wall).
 * Gate ở tầng detector (không phải lọc BOQ ở cuối): type ngoài bộ môn → hạ về 'symbol'
 * ngay khi phân loại, nên KHÔNG lọt vào object statistics / finding / cluster / BOQ.
 *
 * Chỉ gate các type ĐO ĐƯỢC (cấu kiện KT/KC + thiết bị MEP). Type trung tính (axis,
 * dimension, text, symbol, hatch, unknown, polyline…) luôn cho qua — chúng không bị đếm
 * thành cấu kiện. `KHAC`/undefined = KHÔNG giới hạn (bản chưa gắn bộ môn).
 */
export const DISCIPLINE_ALLOWED_TYPES: Record<string, Set<string>> = {
  KT: new Set(['wall', 'slab', 'roof', 'stair', 'door', 'window', 'opening', 'room']),
  KC: new Set(['column', 'beam', 'footing', 'pile', 'slab', 'rebar', 'wall']),
  DIEN: new Set(['light', 'socket', 'switch', 'electric_panel', 'cable_tray', 'conduit', 'wire', 'smoke_detector']),
  NUOC: new Set(['pipe', 'valve', 'sanitary', 'floor_drain', 'duct', 'diffuser', 'hvac_unit']),
};

/** Type ĐO ĐƯỢC (bị gate theo bộ môn). Ngoài tập này = trung tính, luôn cho qua. */
export const DISCIPLINE_GATED_TYPES = new Set<string>([
  // cấu kiện KT/KC
  'wall', 'slab', 'roof', 'stair', 'door', 'window', 'room', 'column', 'beam', 'footing', 'pile', 'rebar',
  // thiết bị/ tuyến MEP
  'light', 'socket', 'switch', 'electric_panel', 'cable_tray', 'conduit', 'wire', 'smoke_detector',
  'pipe', 'valve', 'sanitary', 'floor_drain', 'duct', 'diffuser', 'hvac_unit',
]);

/** Per-project layer→type override (Tier 2). Undefined discriminator = match any. */
export interface LayerOverride {
  layer: string;      // upper-cased layer name
  color?: number;     // optional ACI discriminator
  lineType?: string;  // optional linetype-name discriminator (upper-cased)
  type: string;       // target type, or 'ignored'
}

// Built-in overrides that always apply. DEFPOINTS is AutoCAD's non-plotting
// dimension-definition layer — never a real object, must be excluded from BOQ.
const BUILTIN_OVERRIDES: LayerOverride[] = [{ layer: 'DEFPOINTS', type: 'ignored' }];

/** One weighted hypothesis. Geometry rules emit several; deterministic rules emit one. */
export interface Candidate {
  type: string;
  prob: number; // 0..1, distribution over the coarse class (not required to sum to 1)
}

export interface DetectionResult {
  objectType: string;   // argmax(candidates) — convenience only, NOT a committed answer for geometry guesses
  confidence: number;   // prob of the top candidate
  candidates: Candidate[];
  ambiguous: boolean;   // true when top-2 candidates are close → must NOT auto-count into BOQ
  matchedRule: DetectionRule;
  reason: string;       // human-readable explanation — used by Explain AI
  fallback: boolean;    // true if result is a best-effort guess
}

export interface DetectedObject extends NormalizedObject {
  detection: DetectionResult;
  // Convenience aliases kept for pipeline compatibility
  objectType: string;
  confidence: number;
  candidates: Candidate[];
}

const LAYER_TYPE_MAP: Record<string, string> = {
  // Structural — beam
  BEAM: 'beam', DAM: 'beam', 'KCC-DAM': 'beam', 'S-BEAM': 'beam', 'KC-DAM': 'beam',
  // Structural — column
  COLUMN: 'column', COT: 'column', 'KCC-COT': 'column', 'S-COL': 'column', 'KC-COT': 'column',
  // Wall
  WALL: 'wall', TUONG: 'wall', 'KCC-TUONG': 'wall', 'A-WALL': 'wall', 'S-WALL': 'wall',
  'TUONG-GACH': 'wall', 'TUONG-BT': 'wall',
  // Slab / floor
  SLAB: 'slab', SAN: 'slab', 'KCC-SAN': 'slab', 'S-SLAB': 'slab', 'KC-SAN': 'slab',
  // Stair
  STAIR: 'stair', THANG: 'stair', 'A-STAIR': 'stair',
  // Roof
  ROOF: 'roof', MAI: 'roof', 'A-ROOF': 'roof',
  // Foundation
  FOOTING: 'footing', MONG: 'footing', 'KCC-MONG': 'footing', 'S-FNDTN': 'footing', 'KC-MONG': 'footing',
  // Pile
  PILE: 'pile', COC: 'pile', 'S-PILE': 'pile',
  // Cốt thép (bản kết cấu) — nhận diện để lọc/hiển thị; khối lượng thép bóc từ
  // callout text (%%C=Ø) qua rebar-takeoff, KHÔNG đo hình học ở đây.
  THEP: 'rebar', 'THEP DAI': 'rebar', 'THEP DOC': 'rebar', 'THEP CHIU LUC': 'rebar',
  TTHEP: 'rebar', NETTHEP: 'rebar', LONGTHEP: 'rebar', THEPTRON: 'rebar',
  'KC-THEP': 'rebar', 'KC-THEPDAI': 'rebar', 'T-DAI': 'rebar', TTHEPDAI: 'rebar', NETFEDAI: 'rebar',
  // Door
  DOOR: 'door', CUA: 'door', 'A-DOOR': 'door', 'CUAN': 'door',
  // Window
  WINDOW: 'window', 'CUA-SO': 'window', 'A-WIND': 'window', 'CUASO': 'window',
  // Axis / grid lines — visual only, not structural
  TRUC: 'axis', TRUCL: 'axis', 'TIM-TRUC': 'axis', GRID: 'axis', 'A-GRID': 'axis',
  'TRUC-CHINH': 'axis', 'TRUC-PHU': 'axis',
  // Dimension / annotation
  DIM: 'dimension', DIMENSION: 'dimension', 'A-ANNO-DIMS': 'dimension',
  'Layer-DIM': 'dimension', 'KICH-THUOC': 'dimension', 'KT': 'dimension',
  ANNO: 'dimension', TEXT: 'text', 'A-TEXT': 'text', 'A-ANNO-TEXT': 'text',
  // Hatch / fill
  HATCH: 'hatch', 'A-HATCH': 'hatch', 'CAT': 'hatch',
  // Symbols
  SYMBOL: 'symbol', 'A-SYMB': 'symbol', 'KY-HIEU': 'symbol',

  // ===== MEP — Điện (Electrical) =====
  // Thiết bị = block/INSERT trên layer điện → đếm số lượng (Building Graph).
  DEN: 'light', LIGHT: 'light', 'E-LIGHT': 'light', 'E-LITE': 'light', LIGHTING: 'light', 'DEN-CHIEU-SANG': 'light',
  OCAM: 'socket', 'O-CAM': 'socket', SOCKET: 'socket', 'E-SOCKET': 'socket', 'E-POWER': 'socket', 'OCAM-DIEN': 'socket',
  CONGTAC: 'switch', 'CONG-TAC': 'switch', SWITCH: 'switch', 'E-SWITCH': 'switch',
  TUDIEN: 'electric_panel', 'TU-DIEN': 'electric_panel', PANEL: 'electric_panel', 'E-PANEL': 'electric_panel', MDB: 'electric_panel', SMDB: 'electric_panel',
  MANGCAP: 'cable_tray', 'MANG-CAP': 'cable_tray', CABLETRAY: 'cable_tray', 'CABLE-TRAY': 'cable_tray', 'E-TRAY': 'cable_tray',
  ONGDIEN: 'conduit', 'ONG-DIEN': 'conduit', CONDUIT: 'conduit', 'E-COND': 'conduit',
  DAYDIEN: 'wire', 'DAY-DIEN': 'wire', WIRE: 'wire', 'E-WIRE': 'wire', 'E-CABLE': 'wire',
  // PCCC / báo cháy
  BAOCHAY: 'smoke_detector', 'DAU-BAO-CHAY': 'smoke_detector', SMOKE: 'smoke_detector', 'SMOKE-DETECTOR': 'smoke_detector',

  // ===== MEP — Nước (Plumbing) =====
  // "THOAT" (thoát nước) đứng riêng an toàn nhờ discipline gate: 'pipe' chỉ hợp lệ trên bản
  // NUOC; bản KT có "thoát hiểm" → gate loại. Đo thật: layer "n-thoát" (175 obj) trước rơi axis.
  ONGNUOC: 'pipe', 'ONG-NUOC': 'pipe', PIPE: 'pipe', 'P-PIPE': 'pipe', 'CAP-NUOC': 'pipe', 'THOAT-NUOC': 'pipe', THOAT: 'pipe',
  VAN: 'valve', VALVE: 'valve', 'P-VALVE': 'valve',
  // ⚠ KHÔNG map "FIXTURE"/"AR-FIXTURE" → sanitary: thiết bị vệ sinh vẽ bằng NHIỀU nét (LINE/ARC),
  // đếm mỗi nét = 1 thiết bị → over-count (đo thật: 556 "thiết bị" từ 305 LINE+239 ARC). Sanitary
  // phải đếm theo BLOCK/INSERT — cần fixture detection tầng block (roadmap V5), không phải alias.
  'TB-VS': 'sanitary', 'THIET-BI-VS': 'sanitary', SANITARY: 'sanitary', LAVABO: 'sanitary', 'BON-CAU': 'sanitary', 'THIET-BI-VE-SINH': 'sanitary',
  HOGA: 'floor_drain', 'HO-GA': 'floor_drain', 'THOAT-SAN': 'floor_drain', 'FLOOR-DRAIN': 'floor_drain', DRAIN: 'floor_drain',

  // ===== MEP — HVAC (điều hòa/thông gió) =====
  ONGGIO: 'duct', 'ONG-GIO': 'duct', DUCT: 'duct', 'H-DUCT': 'duct',
  MIENGGIO: 'diffuser', 'MIENG-GIO': 'diffuser', DIFFUSER: 'diffuser', GRILLE: 'diffuser',
  DIEUHOA: 'hvac_unit', 'DIEU-HOA': 'hvac_unit', 'MAY-LANH': 'hvac_unit', FCU: 'hvac_unit', AHU: 'hvac_unit', CHILLER: 'hvac_unit', HVAC: 'hvac_unit',
};

// 2 Set MEP nay da chuyen sang '../mep-types' (module trung lap, pha vong import
// detector <-> takeoff-engine). Re-export de khong pha importer cu.
export { MEP_COUNT_TYPES, MEP_LENGTH_TYPES } from '../mep-types';

// Layer chú thích/ký hiệu/kích thước/chi tiết/khung tên — object trên đây KHÔNG phải
// cấu kiện xây dựng (thường là circle/arc/text ký hiệu, hay bị geometry đoán nhầm thành
// cột/cọc). Khớp theo SUBSTRING trên tên layer đã upper-case.
const ANNOTATION_LAYER_RE =
  /KIHIEU|KYHIEU|GHICHU|CHUTHICH|CHIDAN|THUYETMINH|KICHTHUOC|COTATION|TIEUDE|BORDER|KHUNGBO|KHUNGTEN|TITLE|LEGEND|CHITIET|CHU-?THICH/;

/**
 * LỚP HÌNH CHIẾU KHÔNG PHẢI MẶT BẰNG (V2) — mặt đứng / mặt cắt / chi tiết cắt cấu kiện.
 *
 * Root cause đo thật (bản KT F550): 713 "tường" nhưng chỉ ~18 là tường MẶT BẰNG (layer
 * "Tuong"); 197 nằm layer "Tường bao mặt đứng" (ELEVATION), 367 layer "Cắt tường" (SECTION).
 * Engine đo TẤT CẢ như tường mặt bằng → diện tích trát phồng ~50×. Mặt đứng/mặt cắt là HÌNH
 * CHIẾU của cùng vật thể, KHÔNG phải khối lượng cộng thêm → loại khỏi đo (→ 'symbol').
 *
 * Quy ước CAD Việt Nam CHUNG (không gắn 1 bản): "mặt đứng", "mặt cắt", "cắt <cấu kiện>".
 * "CAT" đứng một mình KHÔNG match (tránh nhầm "cát" = sand) — chỉ "CAT" + tên cấu kiện.
 * "chi tiết" đã do ANNOTATION_LAYER_RE lo.
 */
// MẶT ĐỨNG (elevation): hình chiếu đứng — KHÔNG BAO GIỜ là khối lượng, loại cho MỌI bộ môn.
const ELEVATION_LAYER_RE = /MAT\s*DUNG|ELEVATION/;
// MẶT CẮT / CẮT cấu-kiện (section): với KT là hình chi tiết (loại); với KC là CƠ SỞ ĐO tiết
// diện cột/dầm (GIỮ). Nên section chỉ loại khi bản là KT. "CAT" đơn KHÔNG match (nhầm "cát").
const SECTION_LAYER_RE = /MAT\s*CAT|SECTION|\bCAT[\s_-]*(TUONG|COT|DAM|SAN|MONG|MAI|VACH)/;

/**
 * Tier 1c — layer đặt tên bằng CỤM TỪ tiếng Việt có dấu cách: "ỐNG CẤP", "CẤP THOÁT NƯỚC".
 * `LAYER_TYPE_MAP` (exact/`-`/token) không khớp được vì key là 1 từ (`CAP-NUOC`, `ONGNUOC`).
 *
 * ⚠ CHỈ nhận cụm KHÔNG MẬP MỜ. Token `CAP` đứng một mình BỊ LOẠI có chủ ý: bản nước là
 * "cấp", bản điện là "cáp" (máng cáp) — đoán = sai. Cùng lý do, layer "N - CẤP" (301
 * entity thật) KHÔNG nhận ở đây dù gần chắc là nước: thà thiếu còn hơn sai.
 *
 * Đo thật (4 bản "THỰC HÀNH 2"): khớp 458 entity, TẤT CẢ nằm đúng bản NUOC, 0 nhầm sang
 * KC/KT/DIEN. Bản nước trước đó chỉ nhận 13/7321 entity (0,2%).
 */
const PHRASE_TYPE_RULES: Array<{ phrase: string; type: string }> = [
  { phrase: 'CAP THOAT NUOC', type: 'pipe' },
  { phrase: 'CAP NUOC', type: 'pipe' },
  { phrase: 'THOAT NUOC', type: 'pipe' },
  { phrase: 'NUOC THOAT', type: 'pipe' },
  { phrase: 'ONG CAP', type: 'pipe' },
  { phrase: 'ONG THOAT', type: 'pipe' },
  { phrase: 'THOAT MUA', type: 'pipe' },
  { phrase: 'ONG GIO', type: 'duct' },
  { phrase: 'MIENG GIO', type: 'diffuser' },
  { phrase: 'THIET BI VE SINH', type: 'sanitary' },
];

// ---------------------------------------------------------------------------
// Tier 1b — layer KẾT CẤU đặt tên tự do (bản KC thực tế: "netCOT", "KC-COT-500",
// "COT_TANG1", "MONG-BANG", "BTCT-DAM"). LAYER_TYPE_MAP chỉ khớp exact/`-`-delimited
// nên các tên này rơi xuống geometry → đoán bừa. Ở đây khớp theo TOKEN (tách bởi ký
// tự không phải chữ/số) + tiền tố nhiễu quen thuộc, ANCHORED để không dính nhầm
// ("COTATION", "COTCAO" = cao độ đều KHÔNG khớp `^COT\d*$`).
const KC_NOISE_PREFIX = '(?:NET|LINE|TT|KCC|KC|BTCT|BT|BETONG|BE|TONG|S)?';
const kcRe = (body: string) => new RegExp(`^${KC_NOISE_PREFIX}(?:${body})\\d*$`);

/** Token "tim/trục" → đường trục, KHÔNG phải cấu kiện (chặn "TIM-COT" thành cột). */
const KC_AXIS_TOKEN_RE = kcRe('TIM|TRUC|TRUCL');

/**
 * Token layer → type kết cấu. Cố ý BỎ token "DAI" đứng một mình: đài móng và thép
 * đai trùng chữ → không chắc thì không gán (thà thiếu còn hơn sai). Chỉ nhận
 * DAIMONG/DAICOC.
 */
const KC_LAYER_RULES: Array<{ re: RegExp; type: string }> = [
  { re: kcRe('MONG|FOOTING|FOUND|DAIMONG|DAICOC'), type: 'footing' },
  { re: kcRe('COC|PILE'), type: 'pile' },
  { re: kcRe('COT|COL|COLUMN'), type: 'column' },
  { re: kcRe('DAM|GIANG|BEAM'), type: 'beam' },
  { re: kcRe('SAN|SLAB'), type: 'slab' },
  { re: kcRe('THEP|REBAR'), type: 'rebar' },
];

/**
 * Entity CHÚ THÍCH: nằm trên layer kết cấu vẫn KHÔNG phải cấu kiện (đường kích
 * thước trên layer "netDAM" là đường kích thước, không phải dầm).
 */
const ANNOTATION_RAW = new Set(['DIMENSION', 'TEXT', 'MTEXT', 'LEADER', 'ATTRIB', 'ATTDEF']);

/**
 * Entity CÓ THỂ là mặt cắt kín (đo được diện tích/chu vi). LINE/ARC/SPLINE là NÉT
 * ĐƠN — bản KC vẽ móng/dầm bằng nhiều nét rời, 1 nét KHÔNG phải 1 cấu kiện. Đếm nét
 * thành cấu kiện = số khống (đã gặp thật: 12 LINE trên "netMONG" → "12 móng").
 */
const SECTION_CAPABLE_RAW = new Set(['LWPOLYLINE', 'POLYLINE', 'HATCH', 'SOLID', 'CIRCLE', 'ELLIPSE']);

/** Type kết cấu suy từ tên layer đặt tự do; undefined = không chắc → để tier sau. */
function kcTypeFromLayer(layerUpper: string): string | undefined {
  const tokens = layerUpper.split(/[^A-Z0-9]+/).filter(Boolean);
  for (const { re, type } of KC_LAYER_RULES) {
    if (tokens.some((t) => re.test(t))) return type;
  }
  return undefined;
}

const LABEL_PATTERNS: Array<{ pattern: RegExp; type: string; hint: string }> = [
  { pattern: /^[Bb]\d/, type: 'beam',    hint: 'Label matches beam pattern (B + digit)' },
  { pattern: /^[Cc]\d/, type: 'column',  hint: 'Label matches column pattern (C + digit)' },
  { pattern: /^[Ww]\d/, type: 'wall',    hint: 'Label matches wall pattern (W + digit)' },
  { pattern: /^[Ss][Ll]\d/i, type: 'slab', hint: 'Label matches slab pattern (SL + digit)' },
  { pattern: /^[Ff]\d/, type: 'footing', hint: 'Label matches footing pattern (F + digit)' },
  { pattern: /^[Pp][Cc]\d/i, type: 'pile', hint: 'Label matches pile pattern (PC + digit)' },
  { pattern: /^[Dd]\d/, type: 'door',    hint: 'Label matches door pattern (D + digit)' },
];

const ENTITY_TYPE_MAP: Record<string, string> = {
  TEXT: 'text', MTEXT: 'text',
  DIMENSION: 'dimension', LEADER: 'leader', MULTILEADER: 'leader',
  INSERT: 'block', HATCH: 'hatch',
  VIEWPORT: 'viewport',
};

@Injectable()
export class DrawingDetectorService {
  /**
   * @param unitFactor m/đơn vị vẽ (unitsPerDrawingUnit) — có thì bật kiểm tra tiết diện thật.
   * @param discipline bộ môn của bản vẽ (KT/KC/DIEN/NUOC) — gate type ngoài bộ môn (V1).
   *        undefined / 'KHAC' = không giới hạn.
   */
  detect(objects: NormalizedObject[], overrides: LayerOverride[] = [], unitFactor?: number, discipline?: string): DetectedObject[] {
    const stats = this.computeStats(objects);
    const overrideMap = this.buildOverrideMap(overrides);
    const detected = objects.map((obj) => {
      const detection = this.classify(obj, stats, overrideMap, unitFactor, discipline);
      const floor = this.inferFloor(obj);
      return {
        ...obj,
        floor: floor ?? obj.floor,
        detection,
        objectType: detection.objectType,
        confidence: detection.confidence,
        candidates: detection.candidates,
      };
    });
    // Tier 2.5 — resolve ambiguous objects from spatial context (in-place).
    this.refineByTopology(detected);
    // Topology có thể GẮN lại type (beam/opening) → gate bộ môn LẦN NỮA để không lọt
    // cấu kiện ngoài bộ môn qua đường topology.
    if (discipline && DISCIPLINE_ALLOWED_TYPES[discipline]) {
      for (const o of detected) {
        const gated = this.gateDiscipline(o.detection, discipline);
        if (gated.objectType !== o.detection.objectType) {
          o.detection = gated;
          o.objectType = gated.objectType;
          o.confidence = gated.confidence;
          o.candidates = gated.candidates;
        }
      }
    }
    return detected;
  }

  /** Index overrides by layer|color|lineType for O(1) lookup; built-ins first, user rules win. */
  private buildOverrideMap(overrides: LayerOverride[]): Map<string, LayerOverride> {
    const map = new Map<string, LayerOverride>();
    for (const o of [...BUILTIN_OVERRIDES, ...overrides]) {
      const layer = o.layer.toUpperCase();
      const lt = o.lineType ? o.lineType.toUpperCase() : '*';
      map.set(`${layer}|${o.color ?? '*'}|${lt}`, { ...o, layer });
    }
    return map;
  }

  /** Match an object: most-specific fingerprint (color+linetype) first, widening to any. */
  private matchOverride(obj: NormalizedObject, map: Map<string, LayerOverride>): LayerOverride | undefined {
    const layer = obj.layer.toUpperCase();
    const props = obj.properties ?? {};
    const rawColor = props.colorIndex ?? props.color;
    const color = typeof rawColor === 'number' ? rawColor : parseInt(String(rawColor), 10);
    const c = Number.isFinite(color) ? String(color) : '*';
    const lt = typeof props.lineType === 'string' && props.lineType.trim() ? props.lineType.trim().toUpperCase() : '*';
    // Specificity order: color+linetype → color → linetype → any.
    for (const key of [`${layer}|${c}|${lt}`, `${layer}|${c}|*`, `${layer}|*|${lt}`, `${layer}|*|*`]) {
      const hit = map.get(key);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Build a result from a hypothesis distribution: sort, pick argmax, flag ambiguity. */
  private result(candidates: Candidate[], rule: DetectionRule, reason: string, fallback: boolean): DetectionResult {
    const sorted = candidates.filter((c) => c.prob > 0).sort((a, b) => b.prob - a.prob);
    if (sorted.length === 0) {
      return { objectType: 'unknown', confidence: 0, candidates: [], ambiguous: false, matchedRule: 'none', reason, fallback: true };
    }
    const [top, second] = sorted;
    // Close top-2 → ambiguous: geometry cannot decide, so downstream must not auto-count into BOQ.
    const ambiguous = !!second && top.prob - second.prob < 0.15;
    // confidence is schema-capped at 1 (topology boosts can push a candidate prob above 1).
    return { objectType: top.type, confidence: Math.min(top.prob, 0.99), candidates: sorted, ambiguous, matchedRule: rule, reason, fallback };
  }

  /** Deterministic single-hypothesis rule (layer/label/entity). */
  private single(type: string, prob: number, rule: DetectionRule, reason: string, fallback: boolean): DetectionResult {
    return this.result([{ type, prob }], rule, reason, fallback);
  }

  /**
   * Có gợi ý type nhưng CHƯA CHỐT — downstream KHÔNG được tự tính vào BOQ.
   * Khác `single`: giữ nguyên thông tin (user thấy "móng, chưa chốt") thay vì vứt
   * về 'unknown', nhưng `ambiguous` chặn không cho sinh khối lượng.
   */
  private unsettled(type: string, prob: number, rule: DetectionRule, reason: string): DetectionResult {
    return {
      objectType: type, confidence: prob, candidates: [{ type, prob }],
      ambiguous: true, matchedRule: rule, reason, fallback: false,
    };
  }

  /**
   * Dataset-relative scale so geometry rules stay unit-agnostic (mm vs m vs inch).
   * Area is measured only on closed polygons (real footprints); tiny noise entities
   * naturally fall below the median so they don't skew "large vs small" comparisons.
   */
  private computeStats(objects: NormalizedObject[]): { medianArea: number; medianLength: number } {
    const areas: number[] = [];
    const lengths: number[] = [];
    for (const obj of objects) {
      const g = this.geometryOf(obj);
      if (g.area > 0) areas.push(g.area);
      if (g.length > 0) lengths.push(g.length);
    }
    return { medianArea: median(areas), medianLength: median(lengths) };
  }

  /** Length, area, closedness and rectangularity from geometry (fallback bbox). */
  private geometryOf(obj: NormalizedObject): {
    length: number; area: number; closed: boolean; rectangularity: number; aspect: number; points: number;
  } {
    const geo = obj.geometry ?? [];
    const { w, h } = obj.boundingBox;
    const points = geo.length;
    let length = 0;
    for (let i = 1; i < points; i++) {
      length += Math.hypot(geo[i][0] - geo[i - 1][0], geo[i][1] - geo[i - 1][1]);
    }
    if (points < 2) length = Math.max(w, h);

    let area = 0;
    if (points >= 3) {
      let a = 0;
      for (let i = 0, j = points - 1; i < points; j = i++) {
        a += (geo[j][0] + geo[i][0]) * (geo[j][1] - geo[i][1]);
      }
      area = Math.abs(a) / 2;
    }
    // closed when first ~ last point relative to perimeter
    const closed =
      points >= 3 &&
      Math.hypot(geo[0][0] - geo[points - 1][0], geo[0][1] - geo[points - 1][1]) < 0.02 * (length || 1);
    if (!closed) area = 0;

    const bboxArea = w * h;
    const rectangularity = bboxArea > 0 && area > 0 ? area / bboxArea : 0;
    const aspect = w > 0 && h > 0 ? Math.max(w, h) / Math.min(w, h) : 1;
    return { length, area, closed, rectangularity, aspect, points };
  }

  private classify(
    obj: NormalizedObject,
    stats?: { medianArea: number; medianLength: number },
    overrides?: Map<string, LayerOverride>,
    unitFactor?: number,
    discipline?: string,
  ): DetectionResult {
    return this.gateDiscipline(this.classifyRaw(obj, stats, overrides, unitFactor, discipline), discipline);
  }

  /**
   * Hạ type ĐO ĐƯỢC nằm NGOÀI bộ môn về 'symbol' (V1). Chạy SAU mọi tier — kể cả layer
   * match mạnh — vì trên bản MEP một layer trùng token "COT" vẫn là nhiễu, không phải cột
   * cần đo. Type trung tính + override của user (rule 'layer_override') được giữ nguyên.
   */
  private gateDiscipline(r: DetectionResult, discipline?: string): DetectionResult {
    const allowed = discipline ? DISCIPLINE_ALLOWED_TYPES[discipline] : undefined;
    if (!allowed) return r; // KHAC / undefined / bộ môn lạ → không giới hạn
    if (r.matchedRule === 'layer_override') return r; // user chốt tay → luôn thắng
    if (!DISCIPLINE_GATED_TYPES.has(r.objectType)) return r; // trung tính → cho qua
    if (allowed.has(r.objectType)) return r; // đúng bộ môn → giữ
    return this.single(
      'symbol', 0.6, 'discipline_gate',
      `Gợi ý ${r.objectType} nhưng bản vẽ bộ môn ${discipline} → không tính (ngoài bộ môn)`,
      false,
    );
  }

  private classifyRaw(
    obj: NormalizedObject,
    stats?: { medianArea: number; medianLength: number },
    overrides?: Map<string, LayerOverride>,
    unitFactor?: number,
    discipline?: string,
  ): DetectionResult {
    // 0. Per-project layer override (Tier 2) — user truth beats every heuristic.
    if (overrides?.size) {
      const ov = this.matchOverride(obj, overrides);
      if (ov) {
        const via = ov.color != null ? `${ov.layer} (color ${ov.color})` : ov.layer;
        return this.single(ov.type, 0.98, 'layer_override', `Project rule: layer "${via}" → ${ov.type}`, false);
      }
    }

    // BỎ DẤU trước mọi so khớp layer: file CAD Việt Nam đặt layer có dấu
    // ("5- Cắt tường", "3- Tường bao mặt đứng", "Lưới trục"). Trước đây so chuỗi
    // THÔ nên chữ có dấu không bao giờ khớp key ASCII, và tokenizer [^A-Z0-9]
    // còn coi ắ/ư/ờ là DẤU PHÂN CÁCH → "CẮT TƯỜNG" vỡ thành ["C","T","T","NG"].
    // Hệ quả thật (F550): 445 entity layer "5- Cắt tường" vô hình với detector.
    const layerUpper = normalizeLayerName(obj.layer);

    // 0b. Token "tim/trục" ở bất kỳ đâu trong tên layer → đường trục, KHÔNG phải cấu
    // kiện. Chạy TRƯỚC LAYER_TYPE_MAP vì "TIM-COT"/"TRUC-DAM" là tim cột/tim dầm (nét
    // dựng hình) nhưng lại khớp hậu tố "-COT"/"-DAM" → bị đếm thành cột/dầm khống.
    if (layerUpper.split(/[^A-Z0-9]+/).some((t) => t && KC_AXIS_TOKEN_RE.test(t))) {
      return this.single('axis', 0.9, 'layer_map', `Layer "${obj.layer}" là tim/trục → không tính cấu kiện`, false);
    }

    // 0c. Layer CHÚ THÍCH/KÝ HIỆU/KÍCH THƯỚC/CHI TIẾT/KHUNG → 'symbol'. Chạy TRƯỚC
    // LAYER_TYPE_MAP: "GHICHU-COT" (ghi chú cột) khớp hậu tố "-COT" → bị đếm thành cột
    // khống. Chú thích luôn thắng: thà thiếu còn hơn sai.
    if (ANNOTATION_LAYER_RE.test(layerUpper)) {
      return this.single('symbol', 0.9, 'layer_map', `Layer "${obj.layer}" là chú thích/ký hiệu → không tính cấu kiện`, false);
    }

    // 0d. Layer MẶT ĐỨNG (hình chiếu đứng) → loại cho MỌI bộ môn. Chạy TRƯỚC LAYER_TYPE_MAP:
    // "Tường bao mặt đứng" chứa token "TUONG" nên nếu không chặn sẽ bị đếm thành tường (phồng).
    if (ELEVATION_LAYER_RE.test(layerUpper)) {
      return this.single('symbol', 0.9, 'layer_map', `Layer "${obj.layer}" là mặt đứng → hình chiếu, không tính khối lượng`, false);
    }
    // 0e. Layer MẶT CẮT chỉ loại với bản KT (hình chi tiết). Bản KC thì mặt cắt LÀ cơ sở đo
    // tiết diện cột/dầm → GIỮ. "Cắt tường" trên bản kiến trúc = 367 entity phồng ở F550.
    if (discipline === 'KT' && SECTION_LAYER_RE.test(layerUpper)) {
      return this.single('symbol', 0.9, 'layer_map', `Layer "${obj.layer}" là mặt cắt/chi tiết trên bản kiến trúc → không tính khối lượng mặt bằng`, false);
    }

    // 1. Layer name — exact, prefix, or suffix match (case-insensitive)
    for (const [key, type] of Object.entries(LAYER_TYPE_MAP)) {
      const k = key.toUpperCase();
      if (layerUpper === k || layerUpper.startsWith(k + '-') || layerUpper.endsWith('-' + k) || layerUpper.includes('-' + k + '-')) {
        return this.single(type, 0.95, 'layer_map', `Layer "${obj.layer}" matched rule "${key}" → ${type}`, false);
      }
    }

    // 1a. Cùng LAYER_TYPE_MAP nhưng tách TOKEN (mọi ký tự không phải chữ/số làm dấu tách),
    // không chỉ `-`. File CAD Việt Nam đặt tên layer có DẤU CÁCH: "5- Cắt tường",
    // "3- Tường bao mặt đứng" → tier 1 (chỉ nhận `-TUONG`/`TUONG-`) trượt hết, entity rơi
    // xuống geometry → `polyline` chưa phân loại. Đo thật trên 3 bản "THỰC HÀNH 2":
    // **714 entity TƯỜNG** bị bỏ theo kiểu này (bản kiến trúc chỉ nhận 18 tường ⇒ engine
    // tự báo "Tường 40m KHÔNG ĐỦ bao sàn 314 m²"). Chạy SAU tier 1 nên không đổi hành vi
    // cũ — chỉ vớt thứ đang trượt. Rào chú thích (ANNOTATION_LAYER_RE) đã chặn ở trên.
    const layerTokens = new Set(layerUpper.split(/[^A-Z0-9]+/).filter(Boolean));
    if (layerTokens.size > 0) {
      for (const [key, type] of Object.entries(LAYER_TYPE_MAP)) {
        if (layerTokens.has(key.toUpperCase())) {
          return this.single(type, 0.9, 'layer_map', `Layer "${obj.layer}" chứa token "${key}" → ${type}`, false);
        }
      }
    }

    // 1c. Cụm từ tiếng Việt có dấu cách ("ỐNG CẤP", "CẤP THOÁT NƯỚC") — xem PHRASE_TYPE_RULES.
    const phrase = PHRASE_TYPE_RULES.find((r) => layerUpper.includes(r.phrase));
    if (phrase) {
      return this.single(phrase.type, 0.9, 'layer_map', `Layer "${obj.layer}" chứa cụm "${phrase.phrase}" → ${phrase.type}`, false);
    }

    // 1b. Layer KC đặt tên tự do (COT/DAM/MONG/COC/THEP…) → type kết cấu. Kèm kiểm tra
    // tiết diện: cấu kiện KC cạnh nhỏ < MIN_SECTION_M là KÝ HIỆU (bọt lưới trục, đầu
    // dóng), không phải mặt cắt thật → 'symbol', không đo. Chỉ kiểm khi biết tỉ lệ;
    // không biết thì để guard của engine (isRealSection) chặn lúc đo.
    const kcType = kcTypeFromLayer(layerUpper);
    const rawUpper = (obj.rawType ?? '').toUpperCase();
    // Chú thích trên layer KC → KHÔNG phải cấu kiện; rơi xuống tier sau (dimension/text).
    if (kcType && !ANNOTATION_RAW.has(rawUpper)) {
      // Nét đơn (LINE/ARC) trên layer KC: bản vẽ dựng móng/dầm bằng NHIỀU nét rời — 1
      // nét KHÔNG phải 1 cấu kiện. Giữ gợi ý type nhưng CHƯA CHỐT → không tính khối
      // lượng (thà thiếu còn hơn sai). Muốn đếm phải ghép nét/khoanh vùng.
      if (SECTION_TYPES.has(kcType) && !SECTION_CAPABLE_RAW.has(rawUpper)) {
        return this.unsettled(
          kcType,
          0.6,
          'layer_map',
          `Layer "${obj.layer}" gợi ý ${kcType} nhưng entity là ${obj.rawType} (nét đơn, không phải mặt cắt kín) → chưa chốt, KHÔNG tính khối lượng; cần khoanh vùng/ghép nét`,
        );
      }
      if (unitFactor != null && SECTION_TYPES.has(kcType) && !this.isPlausibleSection(obj, unitFactor)) {
        return this.single(
          'symbol',
          0.9,
          'layer_map',
          `Layer "${obj.layer}" gợi ý ${kcType} nhưng tiết diện < ${MIN_SECTION_M * 100}cm → ký hiệu, không đo (cần khoanh vùng nếu là cấu kiện thật)`,
          false,
        );
      }
      return this.single(kcType, 0.9, 'layer_map', `Layer "${obj.layer}" có token kết cấu → ${kcType}`, false);
    }

    // 2. Label text pattern
    if (obj.text && typeof obj.text === 'string') {
      for (const { pattern, type, hint } of LABEL_PATTERNS) {
        if (pattern.test(obj.text.trim())) {
          return this.single(type, 0.85, 'label_pattern', `${hint} (text: "${obj.text}")`, false);
        }
      }
    }

    // 3. Geometry / topology — layer-independent hypotheses (multi-candidate, never a hard type)
    if (stats) {
      const geometryGuess = this.classifyByGeometry(obj, stats);
      if (geometryGuess) return geometryGuess;
    }

    // 4. DXF entity type fallback
    const fallbackType = ENTITY_TYPE_MAP[obj.rawType];
    if (fallbackType) {
      return this.single(fallbackType, 0.5, 'entity_type', `DXF entity type ${obj.rawType} → ${fallbackType}`, true);
    }

    return this.single('unknown', 0, 'none', 'No matching rule found', true);
  }

  /** Cạnh nhỏ của bbox ≥ MIN_SECTION_M → tiết diện cấu kiện thật (cùng ngưỡng với engine). */
  private isPlausibleSection(obj: NormalizedObject, unitFactor: number): boolean {
    const { w, h } = obj.boundingBox;
    return Math.min(w, h) * unitFactor >= MIN_SECTION_M;
  }

  /**
   * Shape-based hypotheses when layer/label give nothing. Geometry alone CANNOT decide
   * a single type — a long rectangle may be beam / wall / slab-strip / footing-strip /
   * ramp; a circle may be column / pile / footing / symbol. So this emits a candidate
   * DISTRIBUTION (fallback:true) for Tier 2 (layer/CAD fingerprint), Tier 2.5 (topology)
   * or Tier 3 (LLM) to resolve. Uses dataset-relative scale (median) → unit-agnostic.
   */
  private classifyByGeometry(
    obj: NormalizedObject,
    stats: { medianArea: number; medianLength: number },
  ): DetectionResult | null {
    const rawType = obj.rawType.toUpperCase();
    const g = this.geometryOf(obj);
    const rel = (v: number, base: number) => v / (base || 1);

    // Radial (circle/arc): could be column, pile, footing or a symbol
    if (rawType === 'CIRCLE' || rawType === 'ARC') {
      const small = g.area > 0 && g.area < stats.medianArea;
      const cands = small
        ? [{ type: 'symbol', prob: 0.35 }, { type: 'pile', prob: 0.3 }, { type: 'column', prob: 0.2 }, { type: 'footing', prob: 0.15 }]
        : [{ type: 'column', prob: 0.35 }, { type: 'footing', prob: 0.3 }, { type: 'pile', prob: 0.2 }, { type: 'symbol', prob: 0.15 }];
      return this.result(cands, 'geometry', `Radial ${rawType} (${small ? 'small' : 'large'}) — column/pile/footing/symbol candidates`, true);
    }

    // Degenerate / noise: tiny footprint relative to dataset → marker/symbol
    if (g.area > 0 && g.area < stats.medianArea * 0.01 && g.length < stats.medianLength * 0.05) {
      return this.result(
        [{ type: 'symbol', prob: 0.7 }, { type: 'polyline', prob: 0.3 }],
        'geometry',
        `Very small element (relative area ${rel(g.area, stats.medianArea).toFixed(3)}) → marker/symbol`,
        true,
      );
    }

    // Closed rectangle → distinguish only linear vs planar; NOT the semantic type
    if (g.closed && g.rectangularity > 0.6) {
      if (g.aspect >= 4) {
        // Linear rectangular object — genuinely ambiguous family
        return this.result(
          [
            { type: 'beam', prob: 0.34 },
            { type: 'wall', prob: 0.3 },
            { type: 'slab', prob: 0.14 }, // dải sàn
            { type: 'footing', prob: 0.12 }, // móng băng
            { type: 'ramp', prob: 0.1 },
          ],
          'geometry',
          `Linear rectangular object (aspect ${g.aspect.toFixed(1)}) — beam/wall/slab-strip/footing/ramp candidates`,
          true,
        );
      }
      const large = g.area >= stats.medianArea;
      return large
        ? this.result(
            [{ type: 'slab', prob: 0.5 }, { type: 'roof', prob: 0.2 }, { type: 'footing', prob: 0.18 }, { type: 'opening', prob: 0.12 }],
            'geometry',
            `Large closed polygon (area ${rel(g.area, stats.medianArea).toFixed(1)}× median) — slab/roof/footing candidates`,
            true,
          )
        : this.result(
            [{ type: 'column', prob: 0.38 }, { type: 'footing', prob: 0.25 }, { type: 'pile', prob: 0.2 }, { type: 'symbol', prob: 0.17 }],
            'geometry',
            `Compact closed polygon (aspect ${g.aspect.toFixed(1)}) — column/footing/pile candidates`,
            true,
          );
    }

    // Open long straight polyline → axis / grid line (or a wall centreline)
    if (!g.closed && g.points <= 3 && g.length >= stats.medianLength) {
      return this.result(
        [{ type: 'axis', prob: 0.55 }, { type: 'wall', prob: 0.28 }, { type: 'polyline', prob: 0.17 }],
        'geometry',
        `Long straight open line (length ${rel(g.length, stats.medianLength).toFixed(1)}× median) → axis/grid or wall centreline`,
        true,
      );
    }

    // Any other polyline with real extent → still better than unknown, but low & spread
    if (g.length > 0) {
      return this.result(
        [{ type: 'polyline', prob: 0.5 }, { type: 'wall', prob: 0.2 }, { type: 'axis', prob: 0.16 }, { type: 'beam', prob: 0.14 }],
        'geometry',
        'Open/irregular polyline — shape inconclusive',
        true,
      );
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Tier 2.5 — topology / spatial-context refinement
  // ---------------------------------------------------------------------------

  /**
   * Re-weight candidates of AMBIGUOUS objects using confidently-classified
   * neighbours (walls, columns, footings). Unit-agnostic: uses each anchor's own
   * bbox as the tolerance, never absolute distances. Boosts existing hypotheses —
   * never forces a type — so a wrong anchor can't fabricate a confident answer.
   */
  private refineByTopology(objects: DetectedObject[]): void {
    const targets = objects.filter((o) => o.detection.ambiguous);
    if (!targets.length) return;

    const isAnchor = (o: DetectedObject) => !o.detection.ambiguous && o.confidence >= 0.7;
    const verticals = objects.filter((o) => isAnchor(o) && ['column', 'footing', 'pile'].includes(o.objectType));
    const walls = objects.filter((o) => isAnchor(o) && o.objectType === 'wall');
    if (!verticals.length && !walls.length) return;

    const vGrid = this.buildGrid(verticals);
    const wGrid = this.buildGrid(walls);

    for (const o of targets) {
      const cands = o.detection.candidates;
      const has = (t: string) => cands.some((c) => c.type === t);

      // (a) Linear element whose two far ends rest on verticals → structural beam.
      // Use bbox ends along the long axis (works for closed rectangles too, whose
      // polyline first/last vertex coincide and would give a single point).
      if (has('beam') || has('wall')) {
        const bb = o.boundingBox;
        const [e0, e1]: number[][] = bb.w >= bb.h
          ? [[bb.x, bb.y + bb.h / 2], [bb.x + bb.w, bb.y + bb.h / 2]]
          : [[bb.x + bb.w / 2, bb.y], [bb.x + bb.w / 2, bb.y + bb.h]];
        if (vGrid.hits(e0) && vGrid.hits(e1)) {
          this.applyBoost(o, 'beam', 2.2, 'Two ends rest on columns → spans between supports');
          continue;
        }
      }

      // (b) Compact/short element embedded in a wall run → opening (door/window/lỗ mở).
      const linear = has('beam') || has('wall');
      if (!linear && wGrid.overlaps(o.boundingBox)) {
        this.applyBoost(o, 'opening', 1.8, 'Embedded in a wall run → opening (door/window)', true);
      }
    }
  }

  /** Bucket anchors into a uniform grid sized from their median extent for O(1) neighbour lookup. */
  private buildGrid(anchors: DetectedObject[]) {
    const sizes = anchors.map((a) => Math.max(a.boundingBox.w, a.boundingBox.h)).filter((v) => v > 0);
    const cell = Math.max(median(sizes) * 2, 1e-6);
    const grid = new Map<string, DetectedObject[]>();
    const key = (cx: number, cy: number) => `${cx}:${cy}`;
    for (const a of anchors) {
      const { x, y, w, h } = a.boundingBox;
      for (let cx = Math.floor(x / cell); cx <= Math.floor((x + w) / cell); cx++) {
        for (let cy = Math.floor(y / cell); cy <= Math.floor((y + h) / cell); cy++) {
          const k = key(cx, cy);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(a);
        }
      }
    }
    const near = (px: number, py: number): DetectedObject[] => {
      const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
      const out: DetectedObject[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(key(cx + dx, cy + dy));
        if (bucket) out.push(...bucket);
      }
      return out;
    };
    return {
      // A point "hits" an anchor if it falls inside the anchor bbox grown by 25% of its size.
      hits: (p: number[]) =>
        near(p[0], p[1]).some((a) => pointInBbox(p[0], p[1], a.boundingBox, 0.25)),
      // A bbox "overlaps" an anchor if their AABBs intersect.
      overlaps: (bb: { x: number; y: number; w: number; h: number }) =>
        near(bb.x + bb.w / 2, bb.y + bb.h / 2).some((a) => bboxOverlap(bb, a.boundingBox)),
    };
  }

  /**
   * Multiply the matched candidate's probability (or inject it) and re-derive the
   * result. Keeps fallback:true — topology strengthens a guess, it is not ground truth.
   */
  private applyBoost(o: DetectedObject, type: string, factor: number, reason: string, allowInject = false): void {
    const cands = o.detection.candidates.map((c) => ({ ...c }));
    const hit = cands.find((c) => c.type === type);
    if (hit) hit.prob *= factor;
    else if (allowInject) cands.push({ type, prob: 0.55 }); // strong enough to lead when topology is decisive
    else return;

    const refined = this.result(cands, 'topology', `${o.detection.reason} · Topology: ${reason}`, true);
    o.detection = refined;
    o.objectType = refined.objectType;
    o.confidence = refined.confidence;
    o.candidates = refined.candidates;
  }

  private inferFloor(obj: NormalizedObject): string | undefined {
    const match = obj.layer.match(/(?:T|TANG|FLOOR|FL)[-_]?(\d+|MONG|MAI|ROOF|BASE)/i);
    if (match) {
      const token = match[1].toUpperCase();
      if (['MONG', 'BASE'].includes(token)) return 'Móng';
      if (['MAI', 'ROOF'].includes(token)) return 'Mái';
      return `Tầng ${token}`;
    }
    if (obj.boundingBox.page) return `Tầng ${obj.boundingBox.page}`;
    return undefined;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Box = { x: number; y: number; w: number; h: number };

/** Point inside bbox grown by `margin` × its size on each side (unit-agnostic tolerance). */
function pointInBbox(px: number, py: number, b: Box, margin: number): boolean {
  const mx = b.w * margin, my = b.h * margin;
  return px >= b.x - mx && px <= b.x + b.w + mx && py >= b.y - my && py <= b.y + b.h + my;
}

/** Axis-aligned bbox intersection test. */
function bboxOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
