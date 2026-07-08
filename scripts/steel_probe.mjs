// Dò dữ liệu THÉP trong bản KC: parse DWG → gom TEXT/MTEXT → lọc tín hiệu thép
// (đường kính Ø/%%c/phi/d\d, "kg", "L=", "thống kê", "thép"). Xem thép nằm ở dạng
// bảng schedule (text lưới) hay ACAD_TABLE → cơ sở thiết kế bóc thép.
// Usage: node scripts/steel_probe.mjs "<KC.dwg>"
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('Cần đường dẫn .dwg'); process.exit(1); }
const { DwgParserService } = require(path.join(root, 'dist/drawing/parsers/dwg-parser.service.js'));

const t0 = Date.now();
const res = await new DwgParserService().parse(file);
const ents = Array.isArray(res.pages) ? res.pages.flatMap((p) => p.entities || []) : (res.entities || []);
console.log(`\nparse ${((Date.now() - t0) / 1000).toFixed(1)}s — ${ents.length} entities, ${res.layers?.length ?? '?'} layers`);

const byType = {};
for (const e of ents) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('theo loại:', Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t}=${n}`).join(', '));

const layers = [...new Set(ents.map((e) => e.layer).filter(Boolean))];
const steelLayers = layers.filter((l) => /thep|cot ?thep|reinf|rebar|thong ?ke|tk/i.test(l));
console.log(`\nlayers có thể là thép (${steelLayers.length}):`, steelLayers.join(' | ') || '(không thấy tên rõ)');
console.log('tất cả layer:', layers.slice(0, 40).join(' | '));

// Gom text
const textOf = (e) => {
  const v = e.text ?? e.value ?? e.contents ?? '';
  return typeof v === 'object' ? (v.text ?? v.value ?? '') : String(v);
};
const texts = ents.filter((e) => e.type === 'TEXT' || e.type === 'MTEXT').map((e) => ({ s: textOf(e).trim(), layer: e.layer }));
console.log(`\ntổng text: ${texts.length}`);

// Tín hiệu thép: Ø / %%c / phi / d6..d32 / L= / kg / thống kê thép
const STEEL_RE = /(%%c|Ø|ø|\bphi\b|\bd\s?\d{1,2}\b|\bΦ\b|\bϕ\b|L\s?=|\bkg\b|thong ke|thống kê|thep|thép|đai|dai)/i;
const hits = texts.filter((t) => STEEL_RE.test(t.s) && t.s.length <= 40);
console.log(`text khớp tín hiệu thép: ${hits.length}`);
const byLayer = {};
for (const h of hits) byLayer[h.layer] = (byLayer[h.layer] || 0) + 1;
console.log('phân bố theo layer:', Object.entries(byLayer).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l, n]) => `${l}=${n}`).join(', '));
console.log('\n--- 40 mẫu text thép ---');
for (const h of hits.slice(0, 40)) console.log(`  [${h.layer}] ${h.s}`);

// Diameter cụ thể (thống kê phổ biến d6/d8/d10...)
const dia = {};
for (const t of texts) { const m = t.s.match(/(%%c|Ø|ø|Φ|ϕ|phi|d)\s?(\d{1,2})/i); if (m) dia['d' + m[2]] = (dia['d' + m[2]] || 0) + 1; }
console.log('\nđường kính bắt được:', Object.entries(dia).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}×${n}`).join(', ') || '(không)');
