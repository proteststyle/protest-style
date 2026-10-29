// Protest Style: сервер сайта и Telegram мини-приложения. Без внешних зависимостей, Node.js 20+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const store = require('./store');
const products = require('./products');
const orders = require('./orders');
const tg = require('./tg');
const video = require('./video');
const ai = require('./ai');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const SITE = (env.SITE_URL || '').replace(/\/+$/, '');
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const APP_SECRET = env.APP_SECRET || crypto.createHash('sha256').update('ps:' + ADMIN_PASSWORD + ':' + (env.S3_SECRET_KEY || '')).digest('hex');
const BASE_CURRENCY = env.BASE_CURRENCY || 'RUB';
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_JSON = 1024 * 1024, MAX_CHUNK = 9 * 1024 * 1024, MAX_VIDEO = 300 * 1024 * 1024, MAX_IMAGE = 15 * 1024 * 1024;

// ---------- помощники ----------
const send = (res, code, body, headers) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ 'content-length': buf.length }, typeof body === 'string' || Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
  res.end(buf);
};
const ok = (res, data) => send(res, 200, Object.assign({ ok: true }, data || {}));
const fail = (res, code, error) => send(res, code, { ok: false, error });
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req, MAX_JSON);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch (e) { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

// ---------- вход админа: подписанный токен на 90 дней ----------
const tokenSig = exp => crypto.createHmac('sha256', APP_SECRET).update('adm.' + exp).digest('base64url');
const makeToken = () => { const exp = Date.now() + 90 * 864e5; return exp + '.' + tokenSig(exp); };
function isAdmin(req) {
  const m = /^Bearer (\d+)\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (!m || !ADMIN_PASSWORD || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(m[2]), b = Buffer.from(tokenSig(m[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const loginTries = new Map();
function loginAllowed(ip) {
  const now = Date.now(), list = (loginTries.get(ip) || []).filter(t => now - t < 15 * 60e3);
  loginTries.set(ip, list);
  return list.length < 10;
}

// ---------- курсы валют ----------
let rates = null;
async function getRates() {
  if (rates && Date.now() - rates.t < 12 * 3600e3) return rates;
  try {
    const j = await (await fetch('https://open.er-api.com/v6/latest/' + BASE_CURRENCY)).json();
    if (j.result === 'success' && j.rates) { rates = { t: Date.now(), base: BASE_CURRENCY, rates: j.rates }; return rates; }
  } catch (e) { console.error('[rates] er-api', e.message); }
  if (BASE_CURRENCY === 'RUB') {
    try {
      const j = await (await fetch('https://www.cbr-xml-daily.ru/latest.js')).json();
      if (j.rates) { rates = { t: Date.now(), base: 'RUB', rates: Object.assign({ RUB: 1 }, j.rates) }; return rates; }
    } catch (e) { console.error('[rates] cbr', e.message); }
  }
  return rates || { t: 0, base: BASE_CURRENCY, rates: null };
}

// ---------- каталог для витрины ----------
function publicProduct(p) {
  const { source, ...rest } = p;
  return Object.assign(rest, { post: source && source.link || '' });
}
async function catalog(admin) {
  const { db } = await store.read();
  return {
    products: db.products.filter(p => admin || !p.hidden).map(publicProduct),
    settings: db.settings || {},
  };
}

// ---------- загрузка файлов частями ----------
const uploads = new Map(), jobs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads) if (now - u.created > 3600e3) { try { fs.unlinkSync(u.file); } catch (e) {} uploads.delete(id); }
  for (const [id, j] of jobs) if (now - j.created > 3600e3) jobs.delete(id);
}, 600e3).unref();
const newId = () => crypto.randomBytes(12).toString('base64url');
function startJob(fn) {
  const id = newId(), job = { created: Date.now(), done: false, entry: '', error: '', progress: '' };
  jobs.set(id, job);
  Promise.resolve().then(() => fn(job)).then(r => { job.done = true; job.result = r; if (typeof r === 'string') job.entry = r; })
    .catch(e => { job.done = true; job.error = e.message || String(e); console.error('[job]', e); });
  return id;
}

// ---------- импорт из старой Google Таблицы ----------
async function importFromSheet(url, job) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now());
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.rows)) throw new Error('таблица ответила без товаров');
  const head = j.rows[0].map(h => String(h).trim().toLowerCase());
  const get = (row, n) => { const i = head.indexOf(n); return i >= 0 ? String(row[i] || '').trim() : ''; };
  const multi = (row, base) => { const o = { ru: get(row, base) }; ['en', 'uk', 'tr', 'zh'].forEach(l => { const v = get(row, base + '_' + l); if (v) o[l] = v; }); return o; };
  const copy = async entry => {
    const s = String(entry || '').trim(); if (!s) return '';
    const fetchBuf = async u => { const x = await fetch(u); if (!x.ok) throw new Error('download ' + x.status + ' ' + u.slice(0, 80)); return Buffer.from(await x.arrayBuffer()); };
    if (/^video:/i.test(s)) {
      const [src, poster] = s.slice(6).split(' poster=').map(x => (x || '').trim());
      const file = video.tmp('.mp4'); fs.writeFileSync(file, await fetchBuf(src));
      try { return await video.processVideo(file, products.mediaKey('')); } finally { try { fs.unlinkSync(file); } catch (e) {} }
    }
    return storage.putMedia(products.mediaKey('.jpg'), await fetchBuf(s), 'image/jpeg');
  };
  const rows = j.rows.slice(1).filter(row => get(row, 'name') && Number(get(row, 'price').replace(/[^\d.]/g, '')) > 0);
  let n = 0; const errors = [];
  for (const row of rows) {
    job.progress = `${n + 1} из ${rows.length}`;
    const photos = [];
    for (const e of get(row, 'photos').split('|').filter(Boolean)) {
      try { photos.push(await copy(e)); } catch (err) { errors.push(`${get(row, 'name')}: ${err.message}`); }
    }
    const { db } = await store.read();
    const ex = products.findByName(db, get(row, 'name'));
    await products.save({
      id: ex ? ex.id : '', category: get(row, 'category'), name: multi(row, 'name'), description: multi(row, 'description'),
      price: Number(get(row, 'price').replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '')),
      sizes: get(row, 'sizes'), soldOut: get(row, 'sold_out'), photos, badge: get(row, 'badge'),
      hidden: /^(нет|no|0|скрыть|hide)$/i.test(get(row, 'show')),
    });
    n++;
  }
  if (j.settings && j.settings.hero) {
    try { const hero = await copy(j.settings.hero); await store.mutate(d => { d.settings.hero = hero; }); } catch (e) { errors.push('обложка: ' + e.message); }
  }
  return { imported: n, errors };
}

// ---------- страницы: index.html с мета-тегами для поиска и превью ссылок ----------
let indexTpl = null;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstImage = p => { for (const e of p.photos || []) { if (/^video:/.test(e)) { const m = / poster=(\S+)/.exec(e); if (m) return m[1]; } else return e; } return ''; };
const abs = u => !u ? '' : /^https?:/.test(u) ? u : (SITE + u);
async function renderPage(req, res, productId) {
  if (!indexTpl || env.NODE_ENV !== 'production') indexTpl = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const data = await catalog(false);
  const base = SITE || ('https://' + (req.headers.host || ''));
  let title = 'Protest Style — женская одежда с доставкой по всему миру';
  let desc = 'Магазин женской одежды Protest Style: новые поступления каждую неделю, курьер день в день, доставка по всему миру, цены в любой валюте.';
  let image = abs(firstImage({ photos: [data.settings.hero || ''] })), url = base + '/', ld = null, status = 200;
  if (productId) {
    const p = data.products.find(x => x.id === productId);
    if (!p) status = 404;
    else {
      title = `${p.name.ru} — ${p.price.toLocaleString('ru-RU')} ₽ | Protest Style`;
      desc = (p.description.ru || p.name.ru).replace(/\s+/g, ' ').slice(0, 180);
      image = abs(firstImage(p)) || image; url = `${base}/p/${p.id}`;
      ld = { '@context': 'https://schema.org', '@type': 'Product', name: p.name.ru, description: p.description.ru || '', image: (p.photos || []).map(e => abs(/^video:/.test(e) ? ((/ poster=(\S+)/.exec(e) || [])[1] || '') : e)).filter(Boolean),
        brand: { '@type': 'Brand', name: 'Protest Style' }, category: p.category,
        offers: { '@type': 'Offer', price: p.price, priceCurrency: BASE_CURRENCY, url, availability: p.sizes.length && p.sizes.every(s => p.soldOut.includes(s)) ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock' } };
    }
  }
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="${productId ? 'product' : 'website'}">`,
    `<meta property="og:site_name" content="Protest Style">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
    ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : '',
  ].filter(Boolean).join('\n');
  const boot = `<script>window.__BOOT__=${JSON.stringify(Object.assign({ currency: BASE_CURRENCY }, data)).replace(/</g, '\\u003c')}</script>`;
  const seo = `<noscript><h1>Protest Style</h1><ul>${data.products.map(p => `<li><a href="/p/${esc(p.id)}">${esc(p.name.ru)}</a> — ${p.price} ${BASE_CURRENCY}</li>`).join('')}</ul></noscript>`;
  const html = indexTpl.replace(/<title>[\s\S]*?<\/title>/, '').replace('<!--SSR_HEAD-->', head).replace('<!--SSR_BOOT-->', boot).replace('<!--SSR_SEO-->', seo);
  send(res, status, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': cache || 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- маршруты ----------
async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, M = req.method;

  if (p === '/api/health') return ok(res, { storage: await storage.check().catch(e => ({ error: e.message })), bot: tg.enabled(), ai: ai.aiReady() });

  // Telegram
  if (M === 'POST' && p === tg.hookPath()) {
    if (req.headers['x-telegram-bot-api-secret-token'] !== tg.secret()) return fail(res, 403, 'forbidden');
    const upd = await readJSON(req);
    ok(res); // отвечаем сразу, обработка идёт в фоне
    tg.handleUpdate(upd);
    return;
  }

  // Витрина
  if (M === 'GET' && p === '/api/catalog') return ok(res, Object.assign({ currency: BASE_CURRENCY }, await catalog(isAdmin(req))));
  if (M === 'GET' && p === '/api/rates') { const r = await getRates(); return send(res, 200, { ok: !!r.rates, base: r.base, rates: r.rates }, { 'cache-control': 'public, max-age=3600' }); }
  if (M === 'POST' && p === '/api/order') {
    const b = await readJSON(req);
    const o = await orders.create(b, ipOf(req));
    tg.notifyOrder(o).catch(e => console.error('[tg] order notify', e.message));
    return ok(res, { number: o.number });
  }

  // Админка
  if (M === 'POST' && p === '/api/admin/login') {
    const ip = ipOf(req);
    if (!loginAllowed(ip)) return fail(res, 429, 'too many attempts');
    const b = await readJSON(req);
    const pw = String(b.password || '');
    const good = ADMIN_PASSWORD && Buffer.byteLength(pw) === Buffer.byteLength(ADMIN_PASSWORD) && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
    if (!good) { loginTries.get(ip).push(Date.now()); await new Promise(r => setTimeout(r, 800)); return fail(res, 401, 'wrong password'); }
    return ok(res, { token: makeToken() });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return fail(res, 401, 'wrong password');
    const a = p.slice('/api/admin/'.length);
    if (M === 'GET' && a === 'check') return ok(res);
    if (M === 'POST' && a === 'save') { const b = await readJSON(req); const r = await products.save(b.product || {}); return ok(res, { id: r.id }); }
    if (M === 'POST' && a === 'delete') { const b = await readJSON(req); await products.remove(b.id); return ok(res); }
    if (M === 'POST' && a === 'setting') {
      const b = await readJSON(req); const key = String(b.key || '');
      if (!/^(hero)$/.test(key)) return fail(res, 400, 'unknown setting');
      await store.mutate(d => { d.settings[key] = products.str(b.value, 2000); });
      return ok(res);
    }
    if (M === 'POST' && a === 'upload/start') {
      const b = await readJSON(req);
      const kind = b.kind === 'video' ? 'video' : 'image', size = Number(b.size) || 0;
      if (!(size > 0) || size > (kind === 'video' ? MAX_VIDEO : MAX_IMAGE)) return fail(res, 413, 'too big');
      const id = newId(), file = video.tmp(kind === 'video' ? '.bin' : '.jpg');
      fs.writeFileSync(file, '');
      uploads.set(id, { file, size, received: 0, kind, mime: String(b.mime || ''), created: Date.now() });
      return ok(res, { id, chunk: 4 * 1024 * 1024 });
    }
    if (M === 'PUT' && a === 'upload/chunk') {
      const up = uploads.get(u.searchParams.get('id') || '');
      if (!up) return fail(res, 404, 'expired');
      const offset = Number(u.searchParams.get('offset'));
      const buf = await readBody(req, MAX_CHUNK);
      if (offset !== up.received) return ok(res, { received: up.received, resync: true });
      fs.appendFileSync(up.file, buf); up.received += buf.length;
      if (up.received > up.size) return fail(res, 400, 'size mismatch');
      return ok(res, { received: up.received });
    }
    if (M === 'POST' && a === 'upload/finish') {
      const b = await readJSON(req); const up = uploads.get(String(b.id || ''));
      if (!up) return fail(res, 404, 'expired');
      if (up.received !== up.size) return fail(res, 400, 'incomplete');
      uploads.delete(String(b.id));
      if (up.kind === 'image') {
        const buf = fs.readFileSync(up.file); try { fs.unlinkSync(up.file); } catch (e) {}
        const type = /^image\/(png|webp|gif)$/.test(up.mime) ? up.mime : 'image/jpeg';
        const url = await storage.putMedia(products.mediaKey('.' + type.split('/')[1].replace('jpeg', 'jpg')), buf, type);
        return ok(res, { entry: url });
      }
      const job = startJob(async () => { try { return await video.processVideo(up.file, products.mediaKey('')); } finally { try { fs.unlinkSync(up.file); } catch (e) {} } });
      return ok(res, { job });
    }
    if (M === 'GET' && a === 'job') {
      const j = jobs.get(u.searchParams.get('id') || '');
      if (!j) return fail(res, 404, 'expired');
      return ok(res, { done: j.done, entry: j.entry, error: j.error, progress: j.progress, result: j.result && typeof j.result === 'object' ? j.result : undefined });
    }
    if (M === 'GET' && a === 'orders') { const { orders: list } = await store.read(); return ok(res, { orders: list.slice(0, 500), statuses: orders.STATUSES }); }
    if (M === 'GET' && a === 'orders.csv') {
      const { orders: list } = await store.read();
      return send(res, 200, orders.csv(list), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="protest-style-orders-${new Date().toISOString().slice(0, 10)}.csv"` });
    }
    if (M === 'POST' && a === 'order-status') { const b = await readJSON(req); const o = await orders.setStatus(String(b.number || ''), String(b.status || '')); return ok(res, { status: o.status }); }
    if (M === 'POST' && a === 'import') {
      const b = await readJSON(req); const url = String(b.url || '');
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return fail(res, 400, 'нужна ссылка на скрипт Google вида https://script.google.com/macros/s/…/exec');
      return ok(res, { job: startJob(job => importFromSheet(url, job)) });
    }
    if (M === 'POST' && a === 'bot-setup') return ok(res, await tg.setup());
    return fail(res, 404, 'unknown action');
  }

  // Страницы и файлы
  if (M !== 'GET' && M !== 'HEAD') return fail(res, 405, 'method');
  if (p === '/' || p === '/index.html') return renderPage(req, res, '');
  const pm = /^\/p\/(\d+)\/?$/.exec(p); if (pm) return renderPage(req, res, pm[1]);
  if (p === '/robots.txt') return send(res, 200, `User-agent: *\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`, { 'content-type': 'text/plain; charset=utf-8' });
  if (p === '/sitemap.xml') {
    const { products: list } = await catalog(false);
    const urls = [`<url><loc>${SITE}/</loc></url>`, ...list.map(x => `<url><loc>${SITE}/p/${x.id}</loc><lastmod>${(x.updated || '').slice(0, 10)}</lastmod></url>`)];
    return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`, { 'content-type': 'application/xml; charset=utf-8' });
  }
  if (p.startsWith('/media/') && !storage.useS3()) { const f = storage.localMediaPath(decodeURIComponent(p.slice(7))); return f ? serveFile(req, res, f, 'public, max-age=31536000') : fail(res, 404, 'nf'); }
  const f = path.resolve(PUBLIC, '.' + decodeURIComponent(p));
  if (!f.startsWith(PUBLIC + path.sep)) return fail(res, 404, 'nf');
  return serveFile(req, res, f);
}

const server = http.createServer((req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  route(req, res).catch(e => {
    if (!res.headersSent) fail(res, e.status || 500, e.message || 'error');
    if (!e.status || e.status >= 500) console.error('[http]', req.method, req.url, e);
  });
});

async function start() {
  if (!ADMIN_PASSWORD) console.warn('[!] ADMIN_PASSWORD не задан: вход в админку отключён');
  console.log('[storage]', storage.useS3() ? 'S3' : 'локальная папка (только для разработки)');
  await store.load(true);
  server.listen(PORT, () => console.log(`Protest Style: http://localhost:${PORT}`));
  if (tg.enabled()) tg.setup().then(r => console.log('[tg]', JSON.stringify(r))).catch(e => console.error('[tg] setup', e.message));
}
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });
module.exports = { server, start };
