// Parse 1 file DWG THẬT (WASM libredwg) → thống kê scene. Không cần Mongo/HTTP.
// Kiểm phần ĐẦU pipeline bóc tách: bản vẽ này có đọc được không, giàu entity không.
// Usage: node scripts/parse_one.mjs "<path .dwg>"
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('Cần đường dẫn .dwg'); process.exit(1); }

const { DwgParserService } = require(path.join(root, 'dist/drawing/parsers/dwg-parser.service.js'));
let adapt;
try { adapt = require(path.join(root, 'dist/drawing/services/dwg-scene-adapter.js')).adaptDwgToDxfDocument; } catch {}

const t0 = Date.now();
const svc = new DwgParserService();
const res = await svc.parse(file);
console.log(`\nparse xong trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// DrawingParseResult: dò các field phổ biến (entities/layers/blocks/insUnits).
const keys = Object.keys(res || {});
console.log('DrawingParseResult keys:', keys.join(', '));
// entities nằm trong pages[].entities (không phải top-level).
const ents = res.entities || res.objects ||
  (Array.isArray(res.pages) ? res.pages.flatMap((p) => p.entities || p.objects || []) : []);
console.log(`layers khai báo: ${Array.isArray(res.layers) ? res.layers.length : 'n/a'}, extents: ${JSON.stringify(res.extMin)}→${JSON.stringify(res.extMax)}`);
console.log(`entities: ${Array.isArray(ents) ? ents.length : 'n/a'}`);
if (Array.isArray(ents) && ents.length) {
  const byType = {};
  for (const e of ents) { const t = e.type || e.entityType || '?'; byType[t] = (byType[t] || 0) + 1; }
  const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('theo loại:', top.map(([t, n]) => `${t}=${n}`).join(', '));
  const layers = new Set(ents.map((e) => e.layer).filter(Boolean));
  console.log(`layers dùng: ${layers.size}`);
  console.log('vài layer:', [...layers].slice(0, 20).join(' | '));
}
if (res.insUnits !== undefined) console.log('insUnits ($INSUNITS):', res.insUnits);

if (adapt) {
  try {
    const a = adapt(res);
    const doc = a?.document ?? a;
    const de = doc?.entities || [];
    console.log(`\nscene-adapter → entities=${Array.isArray(de) ? de.length : 'n/a'}, keys=${Object.keys(a || {}).join(',')}`);
    if (doc?.bbox || doc?.bounds) console.log('bbox:', JSON.stringify(doc.bbox ?? doc.bounds));
  } catch (e) { console.log('adapt lỗi:', e.message); }
}
console.log('\n(Đây là phần ĐẦU pipeline: parse+scene. Bước detect/đo cần Mongo+service — chạy harness E2E test_takeoff.py trên backend thật để ra khối lượng.)');
