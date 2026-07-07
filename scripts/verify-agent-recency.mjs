// Đo hit-rate & recency của "não" agent sau nâng cấp — chạy trên dist (npm run build trước).
// Usage: node scripts/verify-agent-recency.mjs
//   - Phần OFFLINE (recency ranking, unify regex, dynamic year) luôn chạy.
//   - Phần LIVE cần GEMINI_API_KEY (.env): so query CŨ (pin 12/2021 & "năm 2025")
//     vs MỚI (recency-first, năm động) trên CÙNG Gemini grounded → hit-rate before/after.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = (p) => require(path.join(root, 'dist', p));

const { rankSource, pickBetterSource } = D('estimate/source.js');
const { parseSourceDate, currentYear, latestQuarterLabel } = D('estimate/recency.js');
const { extractNormCodes, isNormCode } = D('catalog/norm-code.js');
const { buildQueries } = D('estimate/norm-web-lookup.service.js');
const priceMod = D('estimate/price-web-lookup.service.js');
const { buildPriceQuery, parseNumbers } = priceMod;

console.log('== OFFLINE: recency ranking (ưu tiên nguồn mới) ==');
const staleGov = rankSource({ type: 'government', date: '2018' });
const freshSup = rankSource({ type: 'supplier', date: latestQuarterLabel() });
console.log(`  gov 2018 → confidence ${staleGov.confidence} | supplier ${latestQuarterLabel()} → ${freshSup.confidence}`);
console.log(`  pickBetterSource ⇒ ${pickBetterSource({ type: 'government', date: '2018' }, { type: 'supplier', date: latestQuarterLabel() }).type} (kỳ vọng: supplier)`);

console.log('\n== OFFLINE: unify regex mã (web ↔ catalog) ==');
for (const c of ['AF.61120', 'SAA.1234', 'AB.11411a', 'AF.111'])
  console.log(`  ${c.padEnd(12)} → isNormCode=${isNormCode(c)}`);
console.log(`  extract từ text: ${JSON.stringify(extractNormCodes('trát AK.21214, xây ae-11411, af.61120'))}`);

console.log('\n== OFFLINE: query năm động (không cứng "năm 2025") ==');
console.log(`  năm hiện hành=${currentYear()}, quý=${latestQuarterLabel()}`);
console.log(`  price query MỚI: ${buildPriceQuery('xây tường gạch', 'm3', 'Bình Dương').slice(0, 140)}…`);

// ===== LIVE =====
let key = process.env.GEMINI_API_KEY;
const envPath = path.join(root, '.env');
if (!key && existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
  if (m) key = m[1].trim().replace(/^["']|["']$/g, '');
}
if (!key) {
  console.log('\n(no GEMINI_API_KEY — skip live run)');
  process.exit(0);
}
process.env.GEMINI_API_KEY = key;
const { AiService } = D('ai/ai.service.js');
const ai = new AiService({ get: (k) => process.env[k] });

// Query CŨ (đã bị thay) — tái dựng để so sánh trên cùng Gemini.
const OLD_NORM = (wn) => `mã hiệu định mức "${wn}" theo Thông tư 12/2021/TT-BXD. Ghi rõ mã hiệu dạng XX.NNNNN.`;
const OLD_PRICE = (wn, unit, prov) =>
  `Đơn giá thi công (nhân công + vật liệu) công tác "${wn}" tại ${prov} năm 2025, đơn vị ${unit}, VNĐ. Nêu con số cụ thể.`;

const groundedCode = async (q) => {
  const r = await ai.research(q);
  if (!r || !r.text || r.sources.length === 0) return { sources: 0, codes: [] };
  return { sources: r.sources.length, codes: extractNormCodes(r.text) };
};
const groundedPrice = async (q) => {
  const r = await ai.research(q);
  if (!r || !r.text || r.sources.length === 0) return { sources: 0, nums: [], dated: false };
  const nums = parseNumbers(r.text).filter((n) => n >= 1000 && n <= 100000000).slice(0, 3);
  const dated = /(q[1-4]|quý\s*[1-4])[\/\-. ]?\d{4}|\b20\d{2}\b/i.test(r.text) && !!parseSourceDate(r.text.match(/(q[1-4][\/\-. ]?\d{4}|20\d{2})/i)?.[0]);
  return { sources: r.sources.length, nums, dated };
};

const WORKS = [
  { wn: 'bê tông cột', hintKey: 'column_concrete', unit: 'm3', prov: 'Bình Dương' },
  { wn: 'xây tường gạch', hintKey: 'wall_volume', unit: 'm3', prov: 'Bình Dương' },
];

let oldHit = 0, newHit = 0;
for (const w of WORKS) {
  console.log(`\n== LIVE "${w.wn}" ==`);
  const oldN = await groundedCode(OLD_NORM(w.wn));
  const newN = await groundedCode(buildQueries(w.hintKey, w.wn)[0]);
  const oOk = oldN.codes.length > 0, nOk = newN.codes.length > 0;
  oldHit += oOk ? 1 : 0; newHit += nOk ? 1 : 0;
  console.log(`  NORM cũ  : sources=${oldN.sources} codes=${JSON.stringify(oldN.codes)} ${oOk ? 'HIT' : 'miss'}`);
  console.log(`  NORM mới : sources=${newN.sources} codes=${JSON.stringify(newN.codes)} ${nOk ? 'HIT' : 'miss'}`);
  const oldP = await groundedPrice(OLD_PRICE(w.wn, w.unit, w.prov));
  const newP = await groundedPrice(buildPriceQuery(w.wn, w.unit, w.prov));
  console.log(`  PRICE cũ : sources=${oldP.sources} nums=${JSON.stringify(oldP.nums)} có-ngày=${oldP.dated}`);
  console.log(`  PRICE mới: sources=${newP.sources} nums=${JSON.stringify(newP.nums)} có-ngày=${newP.dated}`);
}
console.log(`\nNORM hit-rate: cũ ${oldHit}/${WORKS.length} → mới ${newHit}/${WORKS.length}`);
console.log('(live miss được phép do quota/web — mục tiêu là query mới ≥ cũ và bắt được mã/ngày mới hơn)');
