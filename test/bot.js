// Проверка бота без Telegram: подменяем api.telegram.org
process.env.TG_BOT_TOKEN = 'TEST:TOKEN'; process.env.SITE_URL = 'https://shop.test'; process.env.ADMIN_PASSWORD = 'test-pass-123';
process.env.LOCAL_STORAGE_DIR = '/tmp/claude-0/bot-storage';
require('fs').rmSync('/tmp/claude-0/bot-storage', { recursive: true, force: true });
const fs = require('fs');
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opt) => {
  url = String(url);
  if (url.includes('api.telegram.org/file/')) return new Response(fs.readFileSync(url.endsWith('.mp4') ? '/tmp/claude-0/t.mov' : '/tmp/claude-0/t.jpg'));
  if (url.includes('api.telegram.org/bot')) {
    const method = url.split('/').pop(), body = opt && opt.body ? JSON.parse(opt.body) : {};
    sent.push({ method, body });
    const result = method === 'getFile' ? { file_path: body.file_id.startsWith('v') ? 'videos/a.mp4' : 'photos/a.jpg' } : method === 'getMe' ? { username: 'test_bot' } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }
  return realFetch(url, opt);
};
const tg = require('../server/tg'), store = require('../server/store');
const chat = { id: -1001, type: 'channel', username: 'protest_style' };
const caption = `Девчооонкиии а красный то 💥❤️‍🔥❤️‍🔥\n❤️‍🔥❤️‍🔥\nВ красном прям секс😮‍💨😍\nКожаный костюм мото стиль\ns талия 64, бедра 98\nм талия 72, бедра 104\nЦена 23.000 р\n\nДоставка по всему миру ✈️\nДля заказа @protest34\nСкидки делаем за отметку\n\nКостюмов мало, дроп лимитирован`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
(async () => {
  await store.load(true);
  await tg.handleUpdate({ message: { message_id: 5, chat: { id: 777, type: 'private' }, text: '/admin test-pass-123' } });
  assert((await store.read()).db.notifyChats.includes(777), '/admin registers notifications');
  assert(sent.some(s => s.method === 'deleteMessage'), 'password message deleted');
  const vid = { file_id: 'v1', file_unique_id: 'uv1', file_size: 70000 };
  await tg.handleUpdate({ channel_post: { message_id: 10, chat, media_group_id: 'g1', video: vid, caption } });
  await tg.handleUpdate({ channel_post: { message_id: 11, chat, media_group_id: 'g1', video: { file_id: 'v2', file_unique_id: 'uv2', file_size: 70000 } } });
  await tg.handleUpdate({ channel_post: { message_id: 12, chat, media_group_id: 'g1', photo: [{ file_id: 'p0', file_unique_id: 'u0' }, { file_id: 'p1', file_unique_id: 'up1', file_size: 70000 }] } });
  await tg.handleUpdate({ channel_post: { message_id: 13, chat, media_group_id: 'g1', photo: [{ file_id: 'p2', file_unique_id: 'up2', file_size: 70000 }] } });
  await wait(9000);
  let { db } = await store.read(); await store.load(true); db = (await store.read()).db;
  const p = db.products[0];
  assert(p && p.name.ru === 'Кожаный костюм мото стиль' && p.price === 23000, 'album imported: ' + (p && p.name.ru));
  assert(p && p.sizes.join() === 'S,M' && p.measurements.M === 'талия 72, бедра 104', 'sizes and measurements');
  assert(p && p.photos.length === 4 && /^video:/.test(p.photos[0]) && /^video:/.test(p.photos[1]), 'media order kept (2 video + 2 photo)');
  assert(p && p.source.link === 'https://t.me/protest_style/10', 'post link');
  assert(sent.some(s => s.method === 'sendMessage' && s.body.chat_id === 777 && /Добавил на сайт/.test(s.body.text)), 'admin notified about import');
  // правка цены
  await tg.handleUpdate({ edited_channel_post: { message_id: 10, chat, media_group_id: 'g1', video: vid, caption: caption.replace('23.000', '21.500') } });
  await store.load(true); db = (await store.read()).db;
  assert(db.products[0].price === 21500 && db.products.length === 1, 'edit updates price, no duplicate');
  // продано
  await tg.handleUpdate({ edited_channel_post: { message_id: 10, chat, media_group_id: 'g1', video: vid, caption: caption + '\n#продано' } });
  await store.load(true); db = (await store.read()).db;
  assert(db.products[0].hidden === true, '#продано hides product');
  // пост без цены игнорируется
  await tg.handleUpdate({ channel_post: { message_id: 20, chat, text: 'Завтра дроп! 🔥' } });
  await wait(500); await store.load(true); db = (await store.read()).db;
  assert(db.products.length === 1, 'non-product post ignored');
  // уведомление о заказе с кнопками
  const orders = require('../server/orders');
  await require('../server/products').patch(db.products[0].id, x => { x.hidden = false; });
  const o = await orders.create({ form: { name: 'Аня', contact: '+7' }, items: [{ id: db.products[0].id, size: 'S', qty: 1 }] }, '1.1.1.1');
  await tg.notifyOrder(o);
  const msg = sent.filter(s => s.method === 'sendMessage').pop();
  assert(/Новый Заказ PS-0001/.test(msg.body.text) && msg.body.reply_markup.inline_keyboard.length === 2, 'order notification with buttons');
  await tg.handleUpdate({ callback_query: { id: 'q', data: 'st:PS-0001:оплачен', message: { chat: { id: 777 }, message_id: 99, text: msg.body.text } } });
  assert((await store.read()).orders[0].status === 'оплачен', 'status button works');
  console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL OK');
  process.exit();
})().catch(e => { console.error(e); process.exit(1); });
