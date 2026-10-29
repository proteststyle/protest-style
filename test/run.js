// Быстрая проверка API на локальном сервере: node test/run.js http://localhost:3100 пароль
const fs = require('fs');
const BASE = process.argv[2] || 'http://localhost:3100', PW = process.argv[3] || 'test-pass-123';
const IMG = process.argv[4] || '/tmp/claude-0/t.jpg', VID = process.argv[5] || '/tmp/claude-0/t.mov';
let token = '';
const j = async (path, opt = {}) => {
  const r = await fetch(BASE + path, Object.assign({}, opt, { headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, opt.headers || {}) }));
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { raw: t, status: r.status }; }
};
const post = (p, b) => j(p, { method: 'POST', body: JSON.stringify(b) });
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
async function upload(file, kind) {
  const buf = fs.readFileSync(file);
  const st = await post('/api/admin/upload/start', { kind, mime: kind === 'video' ? 'video/quicktime' : 'image/jpeg', size: buf.length });
  for (let off = 0; off < buf.length; off += 300000) {
    const r = await j(`/api/admin/upload/chunk?id=${st.id}&offset=${off}`, { method: 'PUT', body: buf.subarray(off, off + 300000), headers: { 'content-type': 'application/octet-stream' } });
    if (!r.ok) throw new Error(JSON.stringify(r));
  }
  const fin = await post('/api/admin/upload/finish', { id: st.id });
  if (fin.entry) return fin.entry;
  for (;;) { await new Promise(r => setTimeout(r, 700)); const s = await j('/api/admin/job?id=' + fin.job); if (s.done) { if (s.error) throw new Error(s.error); return s.entry; } }
}
(async () => {
  assert((await post('/api/admin/login', { password: 'nope' })).ok === false, 'wrong password rejected');
  const l = await post('/api/admin/login', { password: PW }); token = l.token; assert(!!token, 'login');
  assert((await j('/api/admin/check')).ok, 'token check');
  const img = await upload(IMG, 'image'); assert(/^\/media\/|^https/.test(img), 'image upload ' + img);
  const vid = await upload(VID, 'video'); assert(/^video:.* poster=/.test(vid), 'video upload+transcode ' + vid);
  const s1 = await post('/api/admin/save', { product: { category: 'Костюмы', name: { ru: 'Кожаный костюм мото стиль' }, description: { ru: 'Тест' }, price: 23000, sizes: ['S', 'M'], soldOut: ['M'], measurements: { S: 'талия 64, бедра 98' }, photos: [vid, img], badge: 'NEW' } });
  assert(s1.ok && s1.id, 'save product ' + s1.id);
  const s2 = await post('/api/admin/save', { product: { category: 'Топы', name: { ru: 'Скрытый топ' }, price: 3900, sizes: 'XS S', photos: [img], hidden: true } });
  token = ''; let cat = await j('/api/catalog'); token = l.token;
  assert(cat.products.length === 1 && cat.products[0].soldOut[0] === 'M', 'public catalog hides hidden');
  cat = await j('/api/catalog'); assert(cat.products.length === 2, 'admin catalog shows hidden');
  assert((await post('/api/admin/setting', { key: 'hero', value: vid })).ok, 'hero setting');
  token = '';
  const o = await post('/api/order', { delivery: 'world', form: { name: 'Аня', contact: '@anya', country: 'Казахстан, Алматы', address: 'ул. Тест 1' }, items: [{ id: s1.id, size: 'S', qty: 2 }, { id: s2.id, size: 'XS', qty: 1 }], clientTotal: '≈ 230 000 ₸', lang: 'Русский' });
  assert(o.ok && o.number === 'PS-0001', 'order ' + JSON.stringify(o));
  assert((await post('/api/order', { form: { name: '' }, items: [] })).ok === false, 'bad order rejected');
  token = l.token;
  const ol = await j('/api/admin/orders'); assert(ol.orders[0].total === 46000 && ol.orders[0].items.length === 1, 'order total from catalog, hidden item dropped');
  assert((await post('/api/admin/order-status', { number: 'PS-0001', status: 'оплачен' })).ok, 'status change');
  const csv = await fetch(BASE + '/api/admin/orders.csv', { headers: { authorization: 'Bearer ' + token } }).then(r => r.text());
  assert(csv.includes('PS-0001') && csv.includes('оплачен'), 'csv export');
  const page = await fetch(BASE + '/p/' + s1.id).then(r => r.text());
  assert(page.includes('Кожаный костюм мото стиль — 23') && page.includes('application/ld+json') && page.includes('__BOOT__'), 'product page SSR');
  assert((await fetch(BASE + '/p/999')).status === 404, 'missing product 404');
  assert((await fetch(BASE + '/sitemap.xml').then(r => r.text())).includes('/p/' + s1.id), 'sitemap');
  assert((await post('/api/admin/delete', { id: s2.id })).ok, 'delete');
  token = '';
  assert((await post('/api/admin/save', { product: {} })).ok === false, 'admin without token rejected');
  console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL OK');
})().catch(e => { console.error(e); process.exit(1); });
