// Хранилище файлов: S3 (Timeweb) или локальная папка для разработки.
// Без внешних библиотек: подпись запросов AWS SigV4 написана вручную.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const env = process.env;
const S3 = {
  endpoint: (env.S3_ENDPOINT || 'https://s3.twcstorage.ru').replace(/\/+$/, ''),
  region: env.S3_REGION || 'ru-1',
  key: env.S3_ACCESS_KEY || '',
  secret: env.S3_SECRET_KEY || '',
  mediaBucket: env.S3_BUCKET || '',
  dataBucket: env.S3_DATA_BUCKET || '',
  publicBase: (env.S3_PUBLIC_URL || '').replace(/\/+$/, ''),
};
const LOCAL_DIR = path.resolve(env.LOCAL_STORAGE_DIR || path.join(__dirname, '..', '.local-storage'));
const useS3 = () => !!(S3.key && S3.secret && S3.mediaBucket && S3.dataBucket);

const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = p => p.split('/').map(enc).join('/');

function sign(method, bucket, key, { headers = {}, body = '', query = '' } = {}) {
  const url = new URL(S3.endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const hash = sha256(body);
  const uri = '/' + encPath(bucket) + (key ? '/' + encPath(key) : '');
  const h = Object.assign({}, headers, { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': hash });
  const names = Object.keys(h).map(n => n.toLowerCase()).sort();
  const lower = {}; Object.keys(h).forEach(n => { lower[n.toLowerCase()] = String(h[n]).trim(); });
  const canonHeaders = names.map(n => n + ':' + lower[n] + '\n').join('');
  const signed = names.join(';');
  const canon = [method, uri, query, canonHeaders, signed, hash].join('\n');
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canon)].join('\n');
  let k = hmac('AWS4' + S3.secret, day);
  k = hmac(k, S3.region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  lower.authorization = `AWS4-HMAC-SHA256 Credential=${S3.key}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  delete lower.host;
  return { url: S3.endpoint + uri + (query ? '?' + query : ''), headers: lower };
}

async function s3req(method, bucket, key, opts = {}) {
  const s = sign(method, bucket, key, opts);
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(s.url, { method, headers: s.headers, body: opts.body && opts.body.length ? opts.body : undefined, signal: AbortSignal.timeout(60000) });
      if (r.status >= 500) { last = new Error('s3 ' + r.status + ' ' + (await r.text()).slice(0, 200)); continue; }
      return r;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 400 * (a + 1)));
  }
  throw last;
}

// ---- публичные файлы (фото, видео) ----
async function putMedia(key, buf, type) {
  if (!useS3()) {
    const f = path.join(LOCAL_DIR, 'media', key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
    return mediaUrl(key);
  }
  const r = await s3req('PUT', S3.mediaBucket, key, {
    body: buf,
    headers: { 'content-type': type || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'x-amz-acl': 'public-read' },
  });
  if (!r.ok) throw new Error('s3 put ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return mediaUrl(key);
}
function mediaUrl(key) {
  if (!useS3()) return '/media/' + key;
  return (S3.publicBase || `${S3.endpoint}/${S3.mediaBucket}`) + '/' + encPath(key);
}
function localMediaPath(key) {
  const f = path.resolve(LOCAL_DIR, 'media', key);
  if (!f.startsWith(path.join(LOCAL_DIR, 'media'))) return null;
  return f;
}

// ---- закрытые данные (товары, заказы) ----
async function getData(key) {
  if (!useS3()) {
    const f = path.join(LOCAL_DIR, 'data', key);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  }
  const r = await s3req('GET', S3.dataBucket, key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('s3 get ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.text();
}
async function putData(key, text) {
  if (!useS3()) {
    const f = path.join(LOCAL_DIR, 'data', key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f);
    return;
  }
  const r = await s3req('PUT', S3.dataBucket, key, { body: Buffer.from(text), headers: { 'content-type': 'application/json; charset=utf-8' } });
  if (!r.ok) throw new Error('s3 put ' + r.status + ' ' + (await r.text()).slice(0, 300));
}

async function check() {
  if (!useS3()) return { mode: 'local', dir: LOCAL_DIR };
  const probe = 'healthcheck.txt';
  await putData(probe, new Date().toISOString());
  const back = await getData(probe);
  return { mode: 's3', ok: !!back };
}

module.exports = { putMedia, mediaUrl, getData, putData, check, useS3, localMediaPath, _sign: sign, _S3: S3 };
