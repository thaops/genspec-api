// Verify tool layer + agentic runToolLoop — chạy trên dist (npm run build trước).
// Usage: node scripts/verify-agent-tools.mjs
//   OFFLINE: assert locateSheet/findRow/reconcileByCode (không cần key).
//   LIVE (cần GEMINI_API_KEY trong .env): gọi runToolLoop thật → xác nhận Gemini
//   CÓ dùng function-calling (locate_sheet/find_row) và trả grounding hợp lý.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = (p) => require(path.join(root, 'dist', p));

const { locateSheet, findRow, reconcileByCode, executeAgentTool, AGENT_TOOL_DECLARATIONS } = D('estimate/agent-tools.js');

const state = {
  projectInfo: { location: 'Bình Dương' },
  takeoff: [], analyses: [], materials: [], labor: [], equipment: [],
  markups: { overheadPct: 0, profitPct: 0, vatPct: 0, contingencyPct: 0 },
  sheets: [
    { id: 'ov', name: 'Tổng quan', data: { cellData: { '0': { '0': { v: 'Ghi chú' } } } } },
    { id: 'bt', name: 'Bóc tách', data: { cellData: {
      '0': { '0': { v: 'STT' }, '1': { v: 'Mã hiệu' }, '2': { v: 'Tên công tác' }, '3': { v: 'Khối lượng' } },
      '1': { '0': { v: 1 }, '1': { v: 'AE.62210' }, '2': { v: 'Xây tường' }, '3': { v: 12.5 } },
      '2': { '0': { v: 2 }, '1': { v: 'AK.21110' }, '2': { v: 'Trát tường' }, '3': { v: 40 } },
    } } },
  ],
};

let n = 0, failed = 0;
const ok = (c, l) => { n++; if (c) console.log(`  ok ${n}. ${l}`); else { failed++; console.error(`FAIL ${n}. ${l}`); } };

console.log('== OFFLINE tool layer ==');
ok(locateSheet(state, 'takeoff').sheetId === 'bt', "locateSheet('takeoff') → 'bt'");
ok(findRow(state, 'bt', 'AK.21110').row === 2, "findRow mã AK.21110 → row 2");
ok(findRow(state, 'bt', 'XX.99999').found === false, 'findRow mã lạ → không đoán');
const rec = reconcileByCode(state, 'bt', ['AE.62210', 'XX.1', 'ae.62210']);
ok(rec.length === 2 && rec[0].matchedRow === 1 && rec[1].matchedRow === null, 'reconcileByCode: có→row, mới→null, dedupe');
console.log(`\n${n - failed}/${n} offline asserts pass`);

// ===== LIVE =====
let key = process.env.GEMINI_API_KEY;
const envPath = path.join(root, '.env');
if (!key && existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
  if (m) key = m[1].trim().replace(/^["']|["']$/g, '');
}
if (!key) { console.log('\n(no GEMINI_API_KEY — skip live runToolLoop)'); process.exit(failed ? 1 : 0); }
process.env.GEMINI_API_KEY = key;

const { AiService } = D('ai/ai.service.js');
const ai = new AiService({ get: (k) => process.env[k] });

console.log('\n== LIVE runToolLoop (Gemini function-calling) ==');
const calls = [];
const executor = (name, args) => { calls.push({ name, args }); return executeAgentTool(state, name, args); };
const prompt = [{ text:
  `QS chuẩn bị sửa dự toán: cập nhật khối lượng công tác mã AK.21110. ` +
  `Dùng tool để xác định ĐÚNG sheet bóc tách và dòng của mã đó: locate_sheet('takeoff'), rồi find_row(sheetId, 'AK.21110'). ` +
  `Trả GỌN: sheetId đích + row của mã.` }];

const out = await ai.runToolLoop(prompt, AGENT_TOOL_DECLARATIONS, executor, { maxSteps: 4 });
console.log(`  tool calls model đã gọi: ${JSON.stringify(calls.map((c) => c.name))}`);
console.log(`  grounding text: ${out ? out.replace(/\s+/g, ' ').slice(0, 240) : 'NULL (fail-safe → fallback luồng cũ)'}`);
const usedTools = calls.length > 0;
const mentionsRow = !!out && /row\s*2|AK\.?21110/i.test(out);
console.log(usedTools
  ? `  ✅ Gemini ĂN function-calling (${calls.length} call)${mentionsRow ? ', grounding đúng dòng' : ''}`
  : `  ⚠ Gemini KHÔNG gọi tool (out=${out ? 'text' : 'null'}) → key/model không ăn function-calling; luồng đã fail-safe về deterministic.`);
process.exit(failed ? 1 : 0);
