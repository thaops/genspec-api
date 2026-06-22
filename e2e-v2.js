const BASE = 'http://localhost:4000';
let token = '';
const R = [];
const rec = (n, ok, i) => { R.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? '  — ' + i : ''}`); };

async function call(method, path, { body, form, auth = true } = {}) {
  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const t = await res.text(); let j; try { j = t ? JSON.parse(t) : undefined; } catch { j = t; }
  return { status: res.status, json: j, text: t };
}

(async () => {
  const email = `est${Date.now()}@genspec.dev`;
  token = (await call('POST', '/auth/register', { auth: false, body: { name: 'Estimator', email, password: 'secret123' } })).json.accessToken;
  rec('register', !!token);

  // catalog
  const cat = await call('GET', '/catalog?q=bê tông');
  rec('GET /catalog?q', cat.status === 200 && cat.json.length > 0, `${cat.json?.length} hits, e.g. ${cat.json?.[0]?.code}`);

  // create estimate
  const est = (await call('POST', '/estimates', { body: { name: 'Nhà phố 3 tầng' } })).json;
  rec('POST /estimates', !!est.id, est.id);

  // copilot: build draft from prompt
  const form = new FormData();
  form.append('message', 'Tôi muốn xây nhà phố 3 tầng 5x20 tại Bình Dương, móng băng, BTCT, mái BTCT. Hãy tạo dự toán sơ bộ đầy đủ móng, thân, hoàn thiện.');
  const cp = await call('POST', `/estimates/${est.id}/copilot`, { form });
  const e1 = cp.json?.estimate;
  rec('POST copilot (create draft)', cp.status === 201 && e1?.workItems?.length > 0,
    `${e1?.categories?.length} cat, ${e1?.workItems?.length} items, actions ${cp.json?.actions?.length}`);
  console.log('   AI:', (cp.json?.message || '').split('\n')[0].slice(0, 80));
  console.log('   Tổng:', e1?.costs?.total?.toLocaleString('vi-VN'), 'đ');

  if (!e1?.workItems?.length) { return finish(); }

  // manual edit: change quantity of first item
  const item = e1.workItems[0];
  const ed = await call('PATCH', `/estimates/${est.id}/work-items/${item.id}`, { body: { quantity: item.quantity + 10 } });
  const updated = ed.json?.workItems?.find((w) => w.id === item.id);
  rec('PATCH work-item (recompute)', ed.status === 200 && updated?.total === Math.round(updated.unitPrice * updated.quantity),
    `qty ${item.quantity}→${updated?.quantity}, total ${updated?.total?.toLocaleString('vi-VN')}`);

  // copilot iterate: change foundation
  const form2 = new FormData();
  form2.append('message', 'Đổi sang móng cọc ép.');
  const cp2 = await call('POST', `/estimates/${est.id}/copilot`, { form2: undefined, form: form2 });
  rec('POST copilot (iterate)', cp2.status === 201 && Array.isArray(cp2.json?.actions),
    `actions ${cp2.json?.actions?.length}, items now ${cp2.json?.estimate?.workItems?.length}`);
  console.log('   AI:', (cp2.json?.message || '').split('\n')[0].slice(0, 80));

  // add category + work item manually
  const ac = await call('POST', `/estimates/${est.id}/categories`, { body: { name: 'Sân vườn' } });
  const newCat = ac.json.categories.find((c) => c.name === 'Sân vườn');
  rec('POST category', !!newCat, newCat?.id);
  const awi = await call('POST', `/estimates/${est.id}/work-items`, { body: { categoryId: newCat.id, code: 'X.1', name: 'Lát sân', unit: 'm2', quantity: 30, material: 150000, labor: 50000, machine: 0 } });
  const added = awi.json.workItems.find((w) => w.code === 'X.1');
  rec('POST work-item', !!added && added.total === 200000 * 30, `total ${added?.total?.toLocaleString('vi-VN')}`);

  // export F1
  const res = await fetch(`${BASE}/estimates/${est.id}/export-f1`, { headers: { Authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  const isXlsx = buf.slice(0, 2).toString() === 'PK';
  rec('GET export-f1 (xlsx)', res.status === 200 && isXlsx, `${buf.length} bytes, PK=${isXlsx}`);

  finish();
})().catch((e) => { console.error('ERR', e.message); finish(); });

function finish() {
  const p = R.filter(Boolean).length;
  console.log(`\n==== ${p}/${R.length} passed ====`);
  process.exit(p === R.length ? 0 : 1);
}
