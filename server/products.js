// Товары: нормализация, сохранение, поиск, переводы
'use strict';
const crypto = require('crypto');
const store = require('./store');
const ai = require('./ai');

const LANGS = ['ru', 'en', 'uk', 'tr', 'zh'];
const str = (v, max = 4000) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
const normName = s => str(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
const mediaKey = (ext, prefix = 'p') => {
  const d = new Date();
  return `${prefix}/${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomBytes(9).toString('base64url')}${ext}`;
};

function langObj(v, fallbackRu) {
  const o = {};
  if (v && typeof v === 'object') LANGS.forEach(l => { const x = str(v[l]); if (x) o[l] = x; });
  else if (v) o.ru = str(v);
  if (!o.ru && fallbackRu) o.ru = str(fallbackRu);
  return o;
}
const sizeList = v => (Array.isArray(v) ? v : String(v || '').split(/[,;/\s]+/)).map(s => str(s, 20).toUpperCase()).filter(Boolean).slice(0, 30);
const mediaList = v => (Array.isArray(v) ? v : []).map(x => str(x, 2000)).filter(x => /^(video:)?(https?:\/\/|\/media\/)/.test(x)).slice(0, 20);

function clean(p, prev) {
  const sizes = sizeList(p.sizes);
  const m = {};
  if (p.measurements && typeof p.measurements === 'object') Object.keys(p.measurements).slice(0, 30).forEach(k => {
    const key = str(k, 20).toUpperCase(), val = str(p.measurements[k], 200);
    if (key && val) m[key] = val;
  });
  return {
    id: prev ? prev.id : undefined,
    category: str(p.category, 60) || 'Новинки',
    name: langObj(p.name),
    description: langObj(p.description),
    price: Math.max(0, Math.round(Number(p.price) || 0)),
    sizes,
    soldOut: sizeList(p.soldOut).filter(s => sizes.includes(s)),
    measurements: m,
    photos: mediaList(p.photos),
    badge: str(p.badge, 24),
    hidden: !!p.hidden,
    source: p.source || (prev && prev.source) || null,
    created: prev ? prev.created : new Date().toISOString(),
    updated: new Date().toISOString(),
  };
}

// Перевести недостающие языки, если русский текст поменялся или переводов нет
async function fillTranslations(next, prev) {
  const changed = !prev || (prev.name.ru || '') !== (next.name.ru || '') || (prev.description.ru || '') !== (next.description.ru || '');
  const missing = ['en', 'uk', 'tr', 'zh'].some(l => !next.name[l] || (next.description.ru && !next.description[l]));
  if (!changed && !missing) return next;
  if (changed && prev) {
    // русский поменяли: старые автопереводы больше не подходят, кроме тех, что тоже поменяли руками
    ['en', 'uk', 'tr', 'zh'].forEach(l => {
      if ((prev.name.ru || '') !== (next.name.ru || '') && next.name[l] === prev.name[l]) delete next.name[l];
      if ((prev.description.ru || '') !== (next.description.ru || '') && next.description[l] === prev.description[l]) delete next.description[l];
    });
  }
  const tr = await ai.translate(next.name.ru || '', next.description.ru || '');
  Object.keys(tr).forEach(l => {
    if (!next.name[l] && tr[l].name) next.name[l] = tr[l].name;
    if (next.description.ru && !next.description[l] && tr[l].description) next.description[l] = tr[l].description;
  });
  return next;
}

async function save(input) {
  const id = input.id ? String(input.id) : '';
  const { db } = await store.read();
  const prev = id ? db.products.find(p => p.id === id) : null;
  if (id && !prev) throw new Error('not found');
  let next = clean(input, prev);
  if (!next.name.ru) throw new Error('name required');
  if (!(next.price > 0)) throw new Error('price required');
  next = await fillTranslations(next, prev);
  return store.mutate(d => {
    if (prev) {
      const i = d.products.findIndex(p => p.id === id);
      if (i < 0) throw new Error('not found');
      next.id = id; d.products[i] = next;
    } else {
      next.id = String(d.nextId++); d.products.unshift(next);
    }
    return next;
  });
}

async function remove(id) {
  return store.mutate(d => {
    const before = d.products.length;
    d.products = d.products.filter(p => p.id !== String(id));
    if (d.products.length === before) throw new Error('not found');
    return true;
  });
}

async function patch(id, fn) {
  return store.mutate(d => {
    const p = d.products.find(x => x.id === String(id));
    if (!p) throw new Error('not found');
    fn(p); p.updated = new Date().toISOString();
    return p;
  });
}

function findByName(db, name) {
  const n = normName(name);
  return n ? db.products.find(p => normName(p.name.ru) === n) : null;
}
function findBySource(db, chat, msgIds) {
  return db.products.find(p => p.source && String(p.source.chat) === String(chat) && (p.source.items || []).some(it => msgIds.includes(it.msg)));
}

module.exports = { save, remove, patch, clean, findByName, findBySource, fillTranslations, mediaKey, str, LANGS };
