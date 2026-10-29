// Данные магазина: товары, настройки, заказы. Хранятся JSON-файлами в закрытом бакете S3.
// Все изменения идут по очереди (mutex), перед записью свежая версия перечитывается из хранилища.
'use strict';
const storage = require('./storage');

const DB_KEY = 'db.json', ORDERS_KEY = 'orders.json';
let db = null, orders = null, lastLoad = 0;
let chain = Promise.resolve();

const empty = () => ({ version: 1, nextId: 1, nextOrder: 1, products: [], settings: {}, notifyChats: [] });

async function load(force) {
  if (!force && db && Date.now() - lastLoad < 60e3) return;
  const [a, b] = await Promise.all([storage.getData(DB_KEY), storage.getData(ORDERS_KEY)]);
  db = a ? Object.assign(empty(), JSON.parse(a)) : (db || empty());
  orders = b ? JSON.parse(b) : (orders || []);
  lastLoad = Date.now();
}

// Выполнить изменение: fn получает свежие db и orders, может их менять; результат fn возвращается
function mutate(fn, { saveOrders = false } = {}) {
  const run = chain.then(async () => {
    await load(true);
    const res = await fn(db, orders);
    db.updated = new Date().toISOString();
    await storage.putData(DB_KEY, JSON.stringify(db));
    if (saveOrders) await storage.putData(ORDERS_KEY, JSON.stringify(orders));
    return res;
  });
  chain = run.catch(() => {});
  return run;
}

async function read() { await load(false); return { db, orders }; }

module.exports = { load, read, mutate };
