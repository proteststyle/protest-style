// Заказы: проверка, сохранение, текст для менеджера
'use strict';
const store = require('./store');
const { str } = require('./products');

const STATUSES = ['новый', 'подтверждён', 'оплачен', 'отправлен', 'выполнен', 'отменён'];
const DELIVERY = { courier: 'Курьер день в день', showroom: 'Примерка в шоуруме', world: 'Доставка по миру' };
const rub = v => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: process.env.BASE_CURRENCY || 'RUB', maximumFractionDigits: 0 }).format(v);

// простая защита от спама: не больше 5 заказов с одного адреса за 10 минут и 60 в час всего
const hits = new Map(); let hourly = [];
function allow(ip) {
  const now = Date.now();
  hourly = hourly.filter(t => now - t < 3600e3);
  const mine = (hits.get(ip) || []).filter(t => now - t < 600e3);
  if (mine.length >= 5 || hourly.length >= 60) return false;
  mine.push(now); hits.set(ip, mine); hourly.push(now);
  if (hits.size > 5000) hits.clear();
  return true;
}

async function create(body, ip) {
  if (!allow(ip)) { const e = new Error('too many orders'); e.status = 429; throw e; }
  const form = body.form || {};
  const delivery = DELIVERY[body.delivery] ? body.delivery : 'courier';
  const f = {
    name: str(form.name, 120), contact: str(form.contact, 160), country: str(form.country, 160),
    address: str(form.address, 400), when: str(form.when, 160), comment: str(form.comment, 1000),
  };
  if (!f.name || !f.contact) { const e = new Error('name and contact required'); e.status = 400; throw e; }
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  return store.mutate((db, orders) => {
    // цены берём из каталога, а не из браузера
    const lines = items.map(it => {
      const p = db.products.find(x => x.id === String(it.id) && !x.hidden);
      const qty = Math.min(20, Math.max(1, Math.round(Number(it.qty) || 1)));
      return p ? { id: p.id, name: p.name.ru, size: str(it.size, 20), qty, price: p.price, sum: p.price * qty } : null;
    }).filter(Boolean);
    if (!lines.length) { const e = new Error('empty order'); e.status = 400; throw e; }
    const number = 'PS-' + String(db.nextOrder++).padStart(4, '0');
    const order = {
      number, date: new Date().toISOString(), status: 'новый', items: lines,
      total: lines.reduce((s, l) => s + l.sum, 0), clientTotal: str(body.clientTotal, 60),
      delivery, form: f, tg: str(body.tg, 64), lang: str(body.lang, 30), payment: null,
    };
    orders.unshift(order);
    return order;
  }, { saveOrders: true });
}

function text(o) {
  let s = `Заказ ${o.number}, Protest Style\n\n`;
  o.items.forEach((l, i) => { s += `${i + 1}. ${l.name}, размер ${l.size || '—'} × ${l.qty} = ${rub(l.sum)}\n`; });
  s += `\nИтого: ${rub(o.total)}`;
  if (o.clientTotal) s += ` (у клиента ≈ ${o.clientTotal})`;
  s += `\n\nПолучение: ${DELIVERY[o.delivery]}\nИмя: ${o.form.name}\nКонтакт: ${o.form.contact}`;
  if (o.tg) s += ` (Telegram: ${o.tg})`;
  if (o.delivery === 'world') s += `\nСтрана, город: ${o.form.country}`;
  if (o.delivery !== 'showroom' && o.form.address) s += `\nАдрес: ${o.form.address}`;
  if (o.delivery === 'showroom' && o.form.when) s += `\nКогда придёт: ${o.form.when}`;
  if (o.form.comment) s += `\nКомментарий: ${o.form.comment}`;
  if (o.lang && o.lang !== 'Русский') s += `\nЯзык клиента: ${o.lang}`;
  return s;
}

async function setStatus(number, status) {
  if (!STATUSES.includes(status)) throw new Error('bad status');
  return store.mutate((db, orders) => {
    const o = orders.find(x => x.number === number);
    if (!o) throw new Error('not found');
    o.status = status; o.updatedAt = new Date().toISOString();
    return o;
  }, { saveOrders: true });
}

function csv(orders) {
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Номер', 'Дата', 'Статус', 'Товары', 'Сумма', 'Сумма у клиента', 'Получение', 'Имя', 'Контакт', 'Telegram', 'Страна/город', 'Адрес', 'Когда придёт', 'Комментарий', 'Язык'];
  const rows = orders.map(o => [o.number, new Date(o.date).toLocaleString('ru-RU', { timeZone: process.env.TZ_SHOP || 'Europe/Moscow' }), o.status,
    o.items.map(l => `${l.name} (${l.size || '—'}) × ${l.qty}`).join('; '), o.total, o.clientTotal, DELIVERY[o.delivery],
    o.form.name, o.form.contact, o.tg, o.form.country, o.form.address, o.form.when, o.form.comment, o.lang]);
  return '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
}

module.exports = { create, text, setStatus, csv, STATUSES, DELIVERY };
