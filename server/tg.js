// Telegram-бот: переносит посты канала на сайт, присылает заказы, открывает магазин
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const store = require('./store');
const storage = require('./storage');
const products = require('./products');
const orders = require('./orders');
const ai = require('./ai');
const video = require('./video');

const env = process.env;
const TOKEN = env.TG_BOT_TOKEN || '';
const SITE = (env.SITE_URL || '').replace(/\/+$/, '');
const CHANNEL = (env.TG_CHANNEL || '').trim(); // необязательно: @username или -100… id канала
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const API = 'https://api.telegram.org';
const enabled = () => !!TOKEN;
const secret = () => crypto.createHash('sha256').update('tg:' + TOKEN).digest('hex').slice(0, 32);
const hookPath = () => '/tg/' + secret();

async function call(method, params) {
  const r = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`tg ${method}: ${j.description || r.status}`);
  return j.result;
}

async function download(fileId) {
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`${API}/file/bot${TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error('tg download ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function setup() {
  if (!enabled()) return { ok: false, reason: 'no token' };
  if (!/^https:\/\//.test(SITE)) return { ok: false, reason: 'SITE_URL must be https' };
  await call('setWebhook', {
    url: SITE + hookPath(), secret_token: secret(), drop_pending_updates: false,
    allowed_updates: ['message', 'channel_post', 'edited_channel_post', 'callback_query'],
  });
  try { await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: SITE } } }); } catch (e) {}
  try {
    await call('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть магазин' },
      { command: 'admin', description: 'Уведомления о заказах (нужен пароль)' },
      { command: 'stop', description: 'Отключить уведомления' },
    ] });
  } catch (e) {}
  const me = await call('getMe');
  return { ok: true, bot: me.username };
}

// ---------- уведомления ----------
async function notifyAdmins(text, extra) {
  if (!enabled()) return;
  const { db } = await store.read();
  for (const chat of db.notifyChats || []) {
    try { await call('sendMessage', Object.assign({ chat_id: chat, text, disable_web_page_preview: true }, extra || {})); }
    catch (e) { console.error('[tg] notify', chat, e.message); }
  }
}
const statusKeyboard = number => ({ inline_keyboard: [
  [{ text: '✅ Подтверждён', callback_data: `st:${number}:подтверждён` }, { text: '💳 Оплачен', callback_data: `st:${number}:оплачен` }],
  [{ text: '📦 Отправлен', callback_data: `st:${number}:отправлен` }, { text: '✖️ Отменён', callback_data: `st:${number}:отменён` }],
] });
async function notifyOrder(o) {
  await notifyAdmins('🛍 Новый ' + orders.text(o) + `\n\nСтатус: ${o.status}`, { reply_markup: statusKeyboard(o.number) });
}

// ---------- посты канала ----------
const groups = new Map(); // media_group_id → { posts: [], timer }
function channelAllowed(chat) {
  if (!CHANNEL) return true;
  return String(chat.id) === CHANNEL || ('@' + (chat.username || '')).toLowerCase() === CHANNEL.toLowerCase();
}
function mediaOf(m) {
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; return { kind: 'photo', id: p.file_id, fid: p.file_unique_id, size: p.file_size || 0 }; }
  if (m.video) return { kind: 'video', id: m.video.file_id, fid: m.video.file_unique_id, size: m.video.file_size || 0 };
  if (m.document && /^image\//.test(m.document.mime_type || '')) return { kind: 'photo', id: m.document.file_id, fid: m.document.file_unique_id, size: m.document.file_size || 0, doc: true };
  if (m.document && /^video\//.test(m.document.mime_type || '')) return { kind: 'video', id: m.document.file_id, fid: m.document.file_unique_id, size: m.document.file_size || 0 };
  return null;
}
const postText = m => m.caption || m.text || '';
const postLink = (chat, msg) => chat.username ? `https://t.me/${chat.username}/${msg}` : '';

async function storeMedia(md) {
  if (md.size > 20 * 1024 * 1024) throw new Error('file over 20 MB');
  const buf = await download(md.id);
  if (md.kind === 'photo') return storage.putMedia(products.mediaKey('.jpg'), buf, 'image/jpeg');
  const file = video.tmp('.mp4');
  fs.writeFileSync(file, buf);
  try { return await video.processVideo(file, products.mediaKey('').replace(/\.$/, '')); }
  finally { try { fs.unlinkSync(file); } catch (e) {} }
}

function onChannelPost(m) {
  if (!channelAllowed(m.chat)) return;
  if (m.media_group_id) {
    const k = m.chat.id + ':' + m.media_group_id;
    const g = groups.get(k) || { posts: [] };
    g.posts.push(m); clearTimeout(g.timer);
    g.timer = setTimeout(() => { groups.delete(k); importPost(g.posts).catch(e => console.error('[tg] import', e)); }, 4500);
    groups.set(k, g);
    return;
  }
  importPost([m]).catch(e => console.error('[tg] import', e));
}

async function importPost(posts) {
  posts.sort((a, b) => a.message_id - b.message_id);
  const chat = posts[0].chat;
  const text = posts.map(postText).filter(Boolean).join('\n');
  const msgIds = posts.map(p => p.message_id);
  const { db } = await store.read();
  if (ai.SOLD_RE.test(text)) {
    const ex = products.findBySource(db, chat.id, msgIds);
    if (ex) { await products.patch(ex.id, p => { p.hidden = true; }); await notifyAdmins(`Снял с сайта «${ex.name.ru}»: в посте отметка «продано».`); }
    return;
  }
  if (!text.trim()) return;
  const parsed = await ai.parsePost(text);
  if (!parsed.is_product) { console.log('[tg] skip post without product', msgIds); return; }
  const items = [], failed = [];
  for (const p of posts) {
    const md = mediaOf(p); if (!md) continue;
    try { items.push({ msg: p.message_id, fid: md.fid, entry: await storeMedia(md) }); }
    catch (e) { failed.push(md.kind === 'video' ? 'видео' : 'фото'); console.error('[tg] media', e.message); }
  }
  const existing = products.findBySource(db, chat.id, msgIds) || products.findByName(db, parsed.name);
  const name = { ru: parsed.name }, description = { ru: parsed.description };
  Object.keys(parsed.translations || {}).forEach(l => {
    if (parsed.translations[l].name) name[l] = parsed.translations[l].name;
    if (parsed.translations[l].description) description[l] = parsed.translations[l].description;
  });
  const input = {
    id: existing ? existing.id : '',
    category: existing ? existing.category : parsed.category,
    name, description, price: parsed.price,
    sizes: parsed.sizes.length ? parsed.sizes : (existing ? existing.sizes : []),
    soldOut: existing ? existing.soldOut : [],
    measurements: Object.keys(parsed.measurements || {}).length ? parsed.measurements : (existing ? existing.measurements : {}),
    photos: items.length ? items.map(i => i.entry) : (existing ? existing.photos : []),
    badge: existing ? existing.badge : 'NEW',
    hidden: false,
    source: { chat: chat.id, items: items.map(({ msg, fid }) => ({ msg, fid })), link: postLink(chat, msgIds[0]) },
  };
  if (!input.source.items.length) input.source.items = msgIds.map(msg => ({ msg, fid: '' }));
  const saved = await products.save(input);
  const url = SITE ? `${SITE}/p/${saved.id}` : '';
  let note = `${existing ? 'Обновил' : 'Добавил'} на сайт: «${saved.name.ru}», ${saved.price.toLocaleString('ru-RU')} ₽`;
  note += saved.sizes.length ? `, размеры ${saved.sizes.join(' ')}` : ', без размеров';
  note += `, раздел «${saved.category}».`;
  if (failed.length) note += `\nНе получилось загрузить: ${failed.join(', ')} (файл больше 20 МБ или ошибка). Можно добавить через админку на сайте.`;
  if (url) note += `\n${url}`;
  await notifyAdmins(note);
}

async function onChannelEdit(m) {
  if (!channelAllowed(m.chat)) return;
  const { db } = await store.read();
  const ex = products.findBySource(db, m.chat.id, [m.message_id]);
  if (!ex) {
    // пост раньше не был товаром (например, цену дописали позже): пробуем импортировать как новый
    if (!m.media_group_id && postText(m)) return importPost([m]);
    return;
  }
  const text = postText(m);
  if (text && ai.SOLD_RE.test(text)) {
    await products.patch(ex.id, p => { p.hidden = true; });
    return notifyAdmins(`Снял с сайта «${ex.name.ru}»: в посте отметка «продано».`);
  }
  // замена фото или видео в посте
  const md = mediaOf(m), item = (ex.source.items || []).find(i => i.msg === m.message_id);
  if (md && item && item.fid && md.fid !== item.fid) {
    try {
      const entry = await storeMedia(md);
      const idx = ex.source.items.indexOf(item);
      await products.patch(ex.id, p => { if (p.photos[idx] !== undefined) p.photos[idx] = entry; else p.photos.push(entry); p.source.items[idx].fid = md.fid; });
    } catch (e) { console.error('[tg] edit media', e.message); }
  }
  if (!text) return;
  const parsed = await ai.parsePost(text);
  if (!parsed.is_product) return;
  const fresh = (await store.read()).db.products.find(p => p.id === ex.id);
  const name = Object.assign({}, fresh.name, { ru: parsed.name }), description = Object.assign({}, fresh.description, { ru: parsed.description });
  if (parsed.translations) Object.keys(parsed.translations).forEach(l => { name[l] = parsed.translations[l].name || name[l]; description[l] = parsed.translations[l].description || description[l]; });
  const sizes = parsed.sizes.length ? parsed.sizes : fresh.sizes;
  await products.save(Object.assign({}, fresh, {
    name, description, price: parsed.price, sizes,
    soldOut: fresh.soldOut.filter(s => sizes.includes(s)),
    measurements: Object.keys(parsed.measurements || {}).length ? parsed.measurements : fresh.measurements,
    hidden: false,
  }));
  await notifyAdmins(`Обновил по правке поста: «${parsed.name}», ${parsed.price.toLocaleString('ru-RU')} ₽.`);
}

// ---------- личные сообщения боту ----------
async function onMessage(m) {
  if (m.chat.type !== 'private') return;
  const text = (m.text || '').trim();
  const shop = SITE ? { reply_markup: { inline_keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: SITE } }]] } } : {};
  if (/^\/start\b/.test(text)) {
    const arg = text.split(/\s+/)[1] || '';
    if (/^p\d+$/.test(arg) && SITE) return call('sendMessage', { chat_id: m.chat.id, text: 'Открываю товар 👇', reply_markup: { inline_keyboard: [[{ text: 'Смотреть', web_app: { url: `${SITE}/p/${arg.slice(1)}` } }]] } });
    return call('sendMessage', Object.assign({ chat_id: m.chat.id, text: 'Привет! Это магазин Protest Style: каталог, цены в любой валюте и заказ за минуту.' }, shop));
  }
  if (/^\/admin\b/.test(text)) {
    const pw = text.replace(/^\/admin(@\w+)?/, '').trim();
    try { await call('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }); } catch (e) {}
    if (!ADMIN_PASSWORD || !pw || !safeEq(pw, ADMIN_PASSWORD)) return call('sendMessage', { chat_id: m.chat.id, text: 'Пароль не подходит. Напишите /admin и пароль админки через пробел.' });
    await store.mutate(db => { db.notifyChats = [...new Set([...(db.notifyChats || []), m.chat.id])]; });
    return call('sendMessage', { chat_id: m.chat.id, text: 'Готово: сюда будут приходить новые заказы и отчёты о постах из канала. Сообщение с паролем я удалил.\nОтключить: /stop' });
  }
  if (/^\/stop\b/.test(text)) {
    await store.mutate(db => { db.notifyChats = (db.notifyChats || []).filter(c => c !== m.chat.id); });
    return call('sendMessage', { chat_id: m.chat.id, text: 'Уведомления отключены.' });
  }
  return call('sendMessage', Object.assign({ chat_id: m.chat.id, text: 'Чтобы посмотреть каталог и оформить заказ, откройте магазин 👇' }, shop));
}
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

async function onCallback(q) {
  const m = /^st:(PS-\d+):(.+)$/.exec(q.data || '');
  const { db } = await store.read();
  if (!m || !(db.notifyChats || []).includes(q.message && q.message.chat.id)) return call('answerCallbackQuery', { callback_query_id: q.id });
  try {
    const o = await orders.setStatus(m[1], m[2]);
    await call('answerCallbackQuery', { callback_query_id: q.id, text: `${o.number}: ${o.status}` });
    await call('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: q.message.text.replace(/\n\nСтатус: .*$/s, '') + `\n\nСтатус: ${o.status}`, reply_markup: statusKeyboard(o.number), disable_web_page_preview: true });
  } catch (e) { call('answerCallbackQuery', { callback_query_id: q.id, text: 'Не получилось: ' + e.message }).catch(() => {}); }
}

async function handleUpdate(u) {
  try {
    if (u.channel_post) return onChannelPost(u.channel_post);
    if (u.edited_channel_post) return await onChannelEdit(u.edited_channel_post);
    if (u.message) return await onMessage(u.message);
    if (u.callback_query) return await onCallback(u.callback_query);
  } catch (e) { console.error('[tg] update', e); }
}

module.exports = { enabled, setup, hookPath, secret, handleUpdate, notifyOrder, notifyAdmins, importPost, call };
