import { Computed, resourcePrice } from './boq.engine';
import {
  Benchmark,
  ConsistencyIssue,
  EstimateState,
  PriceSource,
  ValidationFinding,
  ValidationReport,
  ValidationStatus,
} from './estimate.types';
import { reliabilityOf } from './source';
import { amendedNorms2025 } from './knowledge/qs-knowledge';

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round(((a - b) / b) * 1000) / 10);
const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN');

/** Reasonable unit-price bands (đơn giá tổng VL+NC+Máy) keyed by work keyword + unit. */
const PRICE_BANDS: { kw: RegExp; unit: RegExp; low: number; high: number; label: string }[] = [
  { kw: /bê ?tông/i, unit: /m3|m³/i, low: 1_000_000, high: 4_500_000, label: 'bê tông (m³)' },
  { kw: /thép|cốt thép/i, unit: /\bkg\b/i, low: 14_000, high: 40_000, label: 'cốt thép (kg)' },
  { kw: /thép|cốt thép/i, unit: /tấn|tan/i, low: 14_000_000, high: 40_000_000, label: 'cốt thép (tấn)' },
  { kw: /xây|tường/i, unit: /m3|m³/i, low: 900_000, high: 3_800_000, label: 'xây tường (m³)' },
  { kw: /xây|tường/i, unit: /m2|m²/i, low: 120_000, high: 600_000, label: 'xây tường (m²)' },
  { kw: /trát|tô/i, unit: /m2|m²/i, low: 60_000, high: 350_000, label: 'trát (m²)' },
  { kw: /ván khuôn|cốp pha|cofa/i, unit: /m2|m²/i, low: 120_000, high: 700_000, label: 'ván khuôn (m²)' },
  { kw: /sơn/i, unit: /m2|m²/i, low: 30_000, high: 250_000, label: 'sơn (m²)' },
];

/** Major cost categories — used to flag a structurally incomplete estimate. */
const MAJOR_GROUPS: { id: string; kw: RegExp; label: string }[] = [
  { id: 'foundation', kw: /móng|cọc|đài|giằng móng/i, label: 'Phần móng' },
  { id: 'structure', kw: /cột|dầm|sàn|thân|kết cấu|bê ?tông cốt thép/i, label: 'Phần thân/kết cấu' },
  { id: 'masonry', kw: /xây|tường/i, label: 'Phần xây' },
  { id: 'finishing', kw: /trát|tô|sơn|ốp|lát|hoàn thiện|trần/i, label: 'Phần hoàn thiện' },
];

/**
 * Self-check: cross-sheet consistency + sanity heuristics + benchmark deviation.
 * Pure (no AI). Computed live in the DTO and embedded in copilot proposals.
 */
export function validate(state: EstimateState, computed: Computed, benchmark?: Benchmark): ValidationReport {
  const findings: ValidationFinding[] = [];
  const consistency: ConsistencyIssue[] = [];
  let n = 0;
  const nid = (p: string) => `${p}-${++n}`;

  // ---- Consistency ----
  const analysisByCode = new Map(state.analyses.map((a) => [a.code.toLowerCase(), a]));

  // Orphan takeoff: a BOQ row aggregated from takeoff with no resolvable unit price.
  for (const row of computed.boq) {
    if (row.quantity > 0 && row.unitPrice <= 0) {
      const a = analysisByCode.get(row.code.toLowerCase());
      if (!a) {
        consistency.push({
          id: nid('orphan'),
          severity: 'error',
          kind: 'orphan_takeoff',
          message: `Công tác "${row.name || row.code}" có khối lượng nhưng thiếu phân tích đơn giá → đơn giá = 0.`,
          refCode: row.code,
        });
      } else {
        consistency.push({
          id: nid('empty'),
          severity: 'error',
          kind: 'empty_analysis',
          message: `Phân tích đơn giá "${a.code}" rỗng hoặc tài nguyên chưa có giá → đơn giá = 0.`,
          refCode: a.code,
        });
      }
    }
  }

  // Unresolved refs & zero-priced resources used inside analyses.
  const seenZero = new Set<string>();
  for (const a of state.analyses) {
    for (const c of a.components ?? []) {
      const key = (c.ref ?? '').toLowerCase();
      const exists =
        c.kind === 'material'
          ? state.materials.some((m) => m.code.toLowerCase() === key || m.name.toLowerCase() === key)
          : c.kind === 'labor'
            ? state.labor.some((l) => l.grade.toLowerCase() === key || l.name.toLowerCase() === key)
            : state.equipment.some((e) => e.code.toLowerCase() === key || e.name.toLowerCase() === key);
      if (!exists) {
        consistency.push({
          id: nid('ref'),
          severity: 'error',
          kind: 'unresolved_ref',
          message: `Phân tích "${a.code}" tham chiếu ${c.kind} "${c.ref}" không tồn tại trong bảng giá.`,
          refCode: a.code,
        });
        continue;
      }
      const { price } = resourcePrice(state, c.kind, c.ref);
      const dedup = `${c.kind}:${key}`;
      if (price <= 0 && !seenZero.has(dedup)) {
        seenZero.add(dedup);
        consistency.push({
          id: nid('zero'),
          severity: 'warn',
          kind: 'zero_price',
          message: `Tài nguyên ${c.kind} "${c.ref}" đang được dùng nhưng đơn giá ≤ 0.`,
          refCode: c.ref,
        });
      }
    }
  }

  // Sum reconciliation (guards rounding drift in A→F).
  const cs = computed.costSummary;
  const rebuilt = cs.directTotal + cs.overhead + cs.profit + cs.vat + cs.contingency;
  if (Math.abs(rebuilt - cs.total) > 2) {
    consistency.push({
      id: nid('sum'),
      severity: 'error',
      kind: 'sum_mismatch',
      message: `Tổng mức (F=${fmt(cs.total)}) không khớp tổng các bảng con (${fmt(rebuilt)}).`,
    });
  }

  // ---- Sanity: unit-price bands ----
  for (const row of computed.boq) {
    if (row.unitPrice <= 0) continue;
    const band = PRICE_BANDS.find((b) => b.kw.test(row.name) && b.unit.test(row.unit));
    if (!band) continue;
    if (row.unitPrice < band.low || row.unitPrice > band.high) {
      findings.push({
        id: nid('up'),
        severity: 'warn',
        area: 'unitPrice',
        title: `Đơn giá ${band.label} bất thường`,
        detail: `"${row.name}" = ${fmt(row.unitPrice)} đ, ngoài khoảng hợp lý ${fmt(band.low)}–${fmt(band.high)} đ.`,
        refCode: row.code,
        expected: `${fmt(band.low)}–${fmt(band.high)}`,
        actual: fmt(row.unitPrice),
      });
    }
  }

  // ---- Sanity: missing major groups ----
  const present = new Set<string>();
  for (const g of MAJOR_GROUPS) {
    if (computed.boq.some((r) => g.kw.test(r.name)) || state.takeoff.some((t) => g.kw.test(`${t.group ?? ''} ${t.name}`))) {
      present.add(g.id);
    }
  }
  const hasAnyWork = computed.boq.length > 0;
  if (hasAnyWork && present.has('structure')) {
    for (const g of MAJOR_GROUPS) {
      if (g.id === 'structure') continue;
      if (!present.has(g.id)) {
        findings.push({
          id: nid('miss'),
          severity: g.id === 'foundation' ? 'error' : 'warn',
          area: 'missing',
          title: `Có thể thiếu ${g.label}`,
          detail: `Dự toán có phần kết cấu nhưng chưa thấy hạng mục thuộc ${g.label}.`,
        });
      }
    }
  }

  // ---- Source reliability (Validate Sources layer) ----
  const priced: PriceSource[] = [
    ...state.materials.filter((m) => m.price > 0).map((m) => m.source),
    ...state.labor.filter((l) => l.dayRate > 0).map((l) => l.source),
    ...state.equipment.filter((e) => e.shiftRate > 0).map((e) => e.source),
  ].filter((s): s is PriceSource => !!s);
  const lowRel = priced.filter((s) => (reliabilityOf(s.type) ?? s.confidence ?? 0) < 60);
  const noSource = priced.filter((s) => !s.type && s.confidence == null && !s.url && !s.name).length;
  if (lowRel.length > 0) {
    findings.push({
      id: nid('src'),
      severity: 'warn',
      area: 'source',
      title: 'Có giá từ nguồn độ tin cậy thấp',
      detail: `${lowRel.length} đơn giá lấy từ nguồn cấp thấp (diễn đàn / AI ước lượng). Nên thay bằng thông báo giá Sở XD hoặc báo giá nhà cung cấp.`,
    });
  }
  if (noSource > 0) {
    findings.push({
      id: nid('src0'),
      severity: 'warn',
      area: 'source',
      title: 'Có giá chưa truy vết nguồn',
      detail: `${noSource} đơn giá chưa gắn nguồn — không kiểm toán được.`,
    });
  }

  // ---- Định mức đã sửa 2025 (ưu tiên bản mới nhất) ----
  // Gộp 1 finding info, chỉ khi thực sự có mã thuộc nhóm sửa — không spam từng dòng.
  const usedCodes = [
    ...state.analyses.map((a) => a.code),
    ...state.takeoff.map((t) => t.code),
  ];
  const amended = amendedNorms2025(usedCodes);
  if (amended.length > 0) {
    const list = amended.map((a) => `${a.code} (${a.group}, ${a.doc})`).join('; ');
    findings.push({
      id: nid('amend2025'),
      severity: 'info',
      area: 'unitPrice',
      title: `${amended.length} mã thuộc nhóm định mức vừa sửa 2025 — đối chiếu bản mới`,
      detail: `Các mã: ${list}. Định mức nhóm này được sửa/bổ sung bởi TT 08/2025 (hiệu lực 15/07/2025) và/hoặc TT 60/2025 (15/02/2026) — kiểm tra hao phí theo bản mới trước khi chốt. Lưu ý: định mức bê tông (AF) cũng có bổ sung 2025, đối chiếu khi cần.`,
    });
  }

  // ---- Benchmark deviation ----
  let deviationPct: number | undefined;
  if (benchmark && benchmark.metric === 'total' && cs.total > 0) {
    const mid = benchmark.mid ?? (benchmark.low + benchmark.high) / 2;
    deviationPct = pct(cs.total, mid);
    const within = cs.total >= benchmark.low && cs.total <= benchmark.high;
    const sev: ValidationFinding['severity'] = within || Math.abs(deviationPct) <= 15 ? 'info' : Math.abs(deviationPct) <= 40 ? 'warn' : 'error';
    findings.push({
      id: nid('bm'),
      severity: sev,
      area: 'benchmark',
      title:
        sev === 'info'
          ? 'Tổng mức nằm trong khoảng thị trường'
          : sev === 'warn'
            ? 'Tổng mức lệch khoảng thị trường'
            : 'Tổng mức có thể không thực tế',
      detail: `Kết quả ${fmt(cs.total)} đ so với benchmark ${fmt(benchmark.low)}–${fmt(benchmark.high)} đ (${benchmark.basis ?? ''}). Lệch ${deviationPct > 0 ? '+' : ''}${deviationPct}%${sev === 'error' ? ' — kiểm tra thiếu hạng mục hoặc sai đơn giá.' : '.'}`,
      actual: fmt(cs.total),
      expected: `${fmt(benchmark.low)}–${fmt(benchmark.high)}`,
      deviationPct,
    });
  }

  // ---- Aggregate status + score ----
  const errors = [...consistency.filter((c) => c.severity === 'error'), ...findings.filter((f) => f.severity === 'error')].length;
  const warns = [...consistency.filter((c) => c.severity === 'warn'), ...findings.filter((f) => f.severity === 'warn')].length;

  let status: ValidationStatus = 'reasonable';
  if (errors > 0) status = 'unrealistic';
  else if (warns > 0) status = 'warning';

  let score = 100 - errors * 22 - warns * 7;
  if (deviationPct != null) score -= Math.min(25, Math.max(0, Math.abs(deviationPct) - 15) / 2);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return { status, score, benchmark, deviationPct, findings, consistency };
}
