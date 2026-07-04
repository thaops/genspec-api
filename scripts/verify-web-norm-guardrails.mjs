// Verify 3 rào chống bịa của web norm lookup + query hints — chạy trên dist (npm run build trước).
// Usage: node scripts/verify-web-norm-guardrails.mjs
// Nếu GEMINI_API_KEY có trong .env → chạy live 3 key (column_concrete, wall_volume, door).
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = require(path.join(root, 'dist/estimate/norm-web-lookup.service.js'));
const {
  WEB_NORM_CODE_RE,
  validateWebHit,
  literalCodeInText,
  pickValidCandidate,
  normalizeWorkName,
  buildQueries,
  QUERY_HINTS,
  MAX_QUERIES_PER_KEY,
} = mod;

let n = 0;
let failed = 0;
function assert(cond, label) {
  n++;
  if (cond) console.log(`  ok ${n}. ${label}`);
  else {
    failed++;
    console.error(`FAIL ${n}. ${label}`);
  }
}

console.log('== Rào 2: regex format ==');
assert(WEB_NORM_CODE_RE.test('AF.11111'), 'AF.11111 hợp lệ');
assert(WEB_NORM_CODE_RE.test('AB.1141a'), 'AB.1141a (hậu tố thường) hợp lệ');
assert(!WEB_NORM_CODE_RE.test('AF11111'), 'thiếu dấu chấm → fail');
assert(!WEB_NORM_CODE_RE.test('af.11111'), 'chữ thường → fail');
assert(!WEB_NORM_CODE_RE.test('AF.111'), '3 số → fail');
assert(!WEB_NORM_CODE_RE.test('AF.111111'), '6 số → fail');

console.log('== Rào 3: literal-in-text (validateWebHit) ==');
const text = 'Theo TT12/2021, công tác bê tông lót móng đá 4x6 có mã AF.11111 và trát tường AK.21234.';
assert(validateWebHit('AF.11111', text) === 'AF.11111', 'mã nguyên văn → pass');
assert(validateWebHit('AF.99999', text) === null, 'mã không có trong text → null (chống bịa)');
assert(validateWebHit('AF11111', text) === null, 'sai format → null dù text chứa gần giống');
assert(validateWebHit(null, text) === null, 'code null → null');
assert(validateWebHit('AF.11111', '') === null, 'text rỗng (không grounding) → null');

console.log('== Rào 3 nới đúng mức: spacing + case ==');
assert(literalCodeInText('AE.62210', 'bảng mã: AE. 62210 xây tường'), '"AE. 62210" spacing quanh dấu chấm → match');
assert(literalCodeInText('AE.62210', 'mã ae.62210 trong bảng'), 'không phân biệt hoa thường → match');
assert(!literalCodeInText('AE.62210', 'mã AE.62211 khác'), 'mã khác số → không match');
assert(validateWebHit('AE.62210', 'bảng: AE .62210') === 'AE.62210', 'validateWebHit dùng spacing match');

console.log('== Extract nhiều ứng viên: pickValidCandidate ==');
const gtext = 'Bảng định mức: AF.12345 bê tông cột; xem thêm AF. 22222.';
const p1 = pickValidCandidate(
  [
    { code: 'AF.99999', name: 'bịa - không literal' },
    { code: 'AF.12345', name: 'bê tông cột' },
  ],
  gtext,
);
assert(p1.code === 'AF.12345', 'candidate 1 fail literal → chọn candidate 2 pass');
const p2 = pickValidCandidate([{ code: 'XYZ123' }, { code: 'AF.99999' }], gtext);
assert(p2.code === null && p2.failReason === 'literal', 'có mã đúng format nhưng không literal → failReason=literal');
const p3 = pickValidCandidate([{ code: 'abc' }, { code: '123' }], gtext);
assert(p3.code === null && p3.failReason === 'format', 'toàn mã sai format → failReason=format');
assert(pickValidCandidate([{ code: 'AF. 22222'.replace(/\s/g, '') }], gtext).code === 'AF.22222', 'candidate match text có spacing "AF. 22222"');

console.log('== Query hints + normalize ==');
const engineKeys = [
  'wall_area', 'wall_volume', 'column_concrete', 'column_formwork',
  'beam_concrete', 'beam_formwork', 'door', 'window', 'slab',
];
assert(engineKeys.every((k) => Array.isArray(QUERY_HINTS[k]) && QUERY_HINTS[k].length >= 2), 'QUERY_HINTS có đủ 9 key engine, mỗi key ≥2 query');
assert(normalizeWorkName('Xây/trát tường') === 'xây tường', '"xây/trát tường" → "xây tường" (bỏ "/")');
assert(normalizeWorkName('Sàn (diện tích)') === 'sàn', 'bỏ chú thích trong ngoặc');
assert(buildQueries('column_concrete', 'bê tông cột').length === MAX_QUERIES_PER_KEY, `tối đa ${MAX_QUERIES_PER_KEY} query/key`);
assert(buildQueries('column_concrete', 'bê tông cột')[0] === QUERY_HINTS.column_concrete[0], 'hintKey → dùng QUERY_HINTS trước');
assert(buildQueries(undefined, 'công tác lạ').every((q) => q.includes('công tác lạ')), 'không hintKey → query generic chứa workName chuẩn hoá');

console.log(`\n${n - failed}/${n} asserts pass`);
if (failed) process.exit(1);

// ===== Live run (tuỳ chọn — cần GEMINI_API_KEY trong .env) =====
const envPath = path.join(root, '.env');
let geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey && existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
  if (m) geminiKey = m[1].trim().replace(/^["']|["']$/g, '');
}
if (!geminiKey) {
  console.log('\n(no GEMINI_API_KEY — skip live run)');
  process.exit(0);
}

console.log('\n== Live run: column_concrete, wall_volume, door ==');
process.env.GEMINI_API_KEY = geminiKey;
const { AiService } = require(path.join(root, 'dist/ai/ai.service.js'));
const { NormWebLookupService } = mod;
const configStub = { get: (k) => process.env[k] };
const ai = new AiService(configStub);
// cacheModel stub: không Mongo — luôn miss, ghi bỏ qua.
const cacheStub = {
  findOne: () => ({ lean: () => ({ catch: () => Promise.resolve(null) }) }),
  updateOne: () => ({ catch: () => Promise.resolve() }),
};
const svc = new NormWebLookupService(ai, configStub, cacheStub);
const liveQueries = [
  { key: 'column_concrete', hintKey: 'column_concrete', workName: 'bê tông cột' },
  { key: 'wall_volume', hintKey: 'wall_volume', workName: 'xây tường' },
  { key: 'door', hintKey: 'door', workName: 'cửa đi' },
];
const hits = await svc.lookupCodes(liveQueries);
for (const q of liveQueries) {
  const h = hits.get(q.key);
  console.log(`  ${q.key}: ${h ? `${h.code} — ${h.name} (${h.sourceUri ?? h.sourceTitle ?? 'web'})` : 'MISS (xem [WebNorm] log ở trên để biết failReason)'}`);
}
console.log('(live miss được phép — quota/web; quan trọng là log [WebNorm] nêu rõ vì sao)');
