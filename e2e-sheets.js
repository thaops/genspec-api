const BASE = 'http://localhost:4000';
let token = '';
const R = [];
const rec = (n, ok, i) => { R.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  — ' + i : ''}`); };
async function call(method, path, { body, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : undefined; } catch { j = t; }
  return { status: res.status, json: j };
}
(async () => {
  const email = `sheet${Date.now()}@genspec.dev`;
  token = (await (await fetch(BASE+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Sheet Tester',email,password:'secret123'})})).json()).accessToken;
  rec('register', !!token);

  const est = (await call('POST', '/estimates', { body: { name: 'Khu nhà 2 công trình' } })).json;
  rec('create estimate (1 default sheet)', est.sheets?.length === 1, `${est.sheets?.length} sheet`);

  // copilot: multi-building → should create multiple sheets
  const form = new FormData();
  form.append('message', 'Dự án gồm 2 công trình: Nhà chính 3 tầng 5x20 và Nhà phụ 1 tầng 4x6. Hãy lập dự toán, MỖI công trình một sheet riêng.');
  const cp = await call('POST', `/estimates/${est.id}/copilot`, { form });
  const e1 = cp.json?.estimate;
  rec('copilot creates multiple sheets', cp.status === 201 && e1?.sheets?.length >= 2,
    `${e1?.sheets?.length} sheets: ${e1?.sheets?.map(s=>s.name).join(' | ')}`);
  e1?.sheets?.forEach(s => console.log(`   • ${s.name}: ${s.workItems.length} item, ${s.costs.total.toLocaleString('vi-VN')}đ`));
  console.log('   GRAND:', e1?.costs?.total?.toLocaleString('vi-VN'), 'đ');

  // summary present
  rec('summary computed', !!e1?.summary?.costSummary?.rows?.length && Array.isArray(e1?.summary?.materialSummary),
    `costRows ${e1?.summary?.costSummary?.rows?.length}, matRows ${e1?.summary?.materialSummary?.length}`);
  // grand = sum of sheet totals
  const sumSheets = (e1?.sheets||[]).reduce((n,s)=>n+s.costs.total,0);
  rec('grand total = Σ sheets', e1?.costs?.total === sumSheets, `${e1?.costs?.total} vs ${sumSheets}`);

  // add a sheet manually
  const add = await call('POST', `/estimates/${est.id}/sheets`, { body: { name: 'Hạ tầng' } });
  rec('POST /sheets', add.json?.sheets?.some(s=>s.name==='Hạ tầng'), `${add.json?.sheets?.length} sheets`);
  const htSheet = add.json.sheets.find(s=>s.name==='Hạ tầng');

  // add category + work item to that sheet
  const ac = await call('POST', `/estimates/${est.id}/categories`, { body: { sheetId: htSheet.id, name: 'Sân đường' } });
  const cat = ac.json.sheets.find(s=>s.id===htSheet.id).categories.find(c=>c.name==='Sân đường');
  const awi = await call('POST', `/estimates/${est.id}/work-items`, { body: { sheetId: htSheet.id, categoryId: cat.id, code:'X.1', name:'Đổ bê tông sân', unit:'m3', quantity:10, material:1200000, labor:200000, machine:50000 } });
  const targetSheet = awi.json.sheets.find(s=>s.id===htSheet.id);
  const item = targetSheet.workItems.find(w=>w.code==='X.1');
  rec('add category+item to specific sheet', !!item && item.total === 1450000*10 && targetSheet.workItems.length===1,
    `item total ${item?.total?.toLocaleString('vi-VN')}`);

  // rename + delete sheet
  const rn = await call('PATCH', `/estimates/${est.id}/sheets/${htSheet.id}`, { body: { name: 'Hạ tầng kỹ thuật' } });
  rec('rename sheet', rn.json.sheets.find(s=>s.id===htSheet.id)?.name === 'Hạ tầng kỹ thuật');
  const del = await call('DELETE', `/estimates/${est.id}/sheets/${htSheet.id}`);
  rec('delete sheet', !del.json.sheets.some(s=>s.id===htSheet.id), `${del.json.sheets.length} sheets left`);

  // export multi-sheet xlsx
  const res = await fetch(`${BASE}/estimates/${est.id}/export-f1`, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  rec('export-f1 multi-sheet xlsx', res.status===200 && buf.slice(0,2).toString()==='PK', `${buf.length} bytes`);

  const p = R.filter(Boolean).length;
  console.log(`\n==== ${p}/${R.length} passed ====`);
  process.exit(p === R.length ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
