// Разбор постов из канала и переводы.
// ИИ подключается через любой OpenAI-совместимый API (ИИ-сервисы Timeweb, YandexGPT, DeepSeek и др.).
// Без ключа работает разбор по правилам: цена, размеры и название по шаблону постов магазина.
'use strict';

const env = process.env;
const AI = {
  url: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
  key: env.AI_API_KEY || '',
  model: env.AI_MODEL || '',
};
const LANGS = ['en', 'uk', 'tr', 'zh'];
const aiReady = () => !!(AI.url && AI.key && AI.model);

async function chat(system, user) {
  const body = { model: AI.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const call = async extra => {
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(AI.url + '/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AI.key },
        body: JSON.stringify(Object.assign({}, body, extra)),
      });
      const text = await r.text();
      if (!r.ok) throw new Error('ai ' + r.status + ' ' + text.slice(0, 300));
      const j = JSON.parse(text);
      return j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
    } finally { clearTimeout(tm); }
  };
  let out;
  try { out = await call({ response_format: { type: 'json_object' } }); }
  catch (e) { if (/response_format|json_object|400/.test(e.message)) out = await call({}); else throw e; }
  const m = String(out).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ai: no json');
  return JSON.parse(m[0]);
}

// ---------- разбор по правилам ----------
const SIZE_RE = /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|one\s*size|хс|ххс|с|м|л|хл|ххл|\d{2}(?:[.,]5)?)(?=[\s:,.\-–—)]|$)[\s:,.\-–—]*(.*)$/i;
const CYR_SIZE = { 'ХХС': 'XXS', 'ХС': 'XS', 'С': 'S', 'М': 'M', 'Л': 'L', 'ХЛ': 'XL', 'ХХЛ': 'XXL' };
const PRICE_RE = /(?:цена|стоимость|price|прайс)\D{0,12}(\d[\d\s.,]*\d|\d)\s*(?:р\b|р\.|руб|₽|rub|т\.р|тыс)?/i;
const PRICE_RE2 = /(\d{1,3}(?:[\s.,]\d{3})+|\d{3,7})\s*(?:р\b|р\.|руб|₽|rub)/i;
const SERVICE_RE = /(доставк[а-яё]* по всему миру|для заказа|скидк[а-яё]* (делаем )?за отметк|пишите в (лс|директ|личк)|@\w{4,}|t\.me\/|^#)/i;
const SOLD_RE = /#продан[оа]?|#sold\s*out|#soldout|(^|\n)[^\S\n]*(продано|sold\s*out)[^\S\n!.]*[!.]*[^\S\n]*(\n|$)/i;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;

const CATEGORY_RULES = [
  [/костюм|комплект|двойк|тройк/i, 'Костюмы'],
  [/ботин|ботфорт|сапог|кроссов|кед|туфл|лофер|обув|босоножк|сандал/i, 'Обувь'],
  [/\bтоп\b|топ[ыа-]|футболк|майк|лонгслив|блуз|рубашк|корсет/i, 'Топы'],
  [/пуховик|шуб|дублёнк|дубленк|зимн/i, 'Зима'],
  [/куртк|бомбер|косух|пиджак|жакет|пальто|тренч|ветровк/i, 'Осень'],
  [/юбк|шорт|платье|сарафан|купальник/i, 'Лето'],
];
function guessCategory(text) { for (const [re, c] of CATEGORY_RULES) if (re.test(text)) return c; return 'Новинки'; }

function parsePrice(text) {
  const m = text.match(PRICE_RE) || text.match(PRICE_RE2);
  if (!m) return 0;
  let s = m[1].replace(/\s/g, '');
  // «23.000» и «23,000» — разделители тысяч
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else s = s.replace(',', '.');
  let v = Number(s);
  if (/т\.р|тыс/i.test(m[0]) && v < 1000) v *= 1000;
  return v > 0 && v < 10000000 ? Math.round(v) : 0;
}

function ruleParse(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map(l => l.trim());
  const price = parsePrice(raw);
  const sizes = [], measurements = {};
  let firstSpecIdx = -1;
  lines.forEach((l, i) => {
    const clean = l.replace(EMOJI_RE, '').trim();
    const m = clean.match(SIZE_RE);
    if (m && clean.length < 80 && !/цена|price/i.test(clean) && (!m[2] || /\d/.test(m[2]))) {
      let size = m[1].replace(/\s+/g, ' ').toUpperCase(); size = CYR_SIZE[size] || size;
      if (!sizes.includes(size)) sizes.push(size);
      if (m[2]) measurements[size] = m[2].replace(/[.;]+$/, '').trim();
      if (firstSpecIdx < 0) firstSpecIdx = i;
    } else if ((PRICE_RE.test(clean) || PRICE_RE2.test(clean)) && firstSpecIdx < 0) firstSpecIdx = i;
    // строка «Размеры: S M L»
    const ms = clean.match(/^размер[а-яё]*\s*[:\-–]?\s*([a-zа-я0-9 ,/]+)$/i);
    if (ms && firstSpecIdx < 0) firstSpecIdx = i;
    if (ms) ms[1].split(/[\s,/]+/).filter(Boolean).forEach(s => { s = s.toUpperCase(); if (!sizes.includes(s) && /^(X*S|M|X*L|\d{2})$/.test(s)) sizes.push(s); });
  });
  // Название: строка прямо перед размерами/ценой, без эмодзи-восклицаний; иначе первая содержательная строка
  const isNameLike = l => { const c = l.replace(EMOJI_RE, '').trim(); return c.length >= 4 && c.length <= 70 && /[а-яa-z]{3}/i.test(c) && !SERVICE_RE.test(c) && !/^размер/i.test(c) && !PRICE_RE.test(c) && !(SIZE_RE.test(c) && /\d/.test(c)) && !/[!?]{1}$/.test(c); };
  const upto = firstSpecIdx > 0 ? firstSpecIdx : lines.length;
  const cands = lines.slice(0, upto).filter(isNameLike).reverse();
  const isItem = l => CATEGORY_RULES.some(([re]) => re.test(l)) || /кожан|джинс|трикотаж|брюк|штан|жилет|худи|свитер|кардиган|сумк/i.test(l);
  let name = cands.find(isItem) || cands[0] || lines.find(isNameLike) || '';
  name = name.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim().replace(/[.,:;]+$/, '');
  name = name.charAt(0).toUpperCase() + name.slice(1);
  // Описание: текст без служебных строк, цены и размеров
  const desc = lines.filter(l => {
    const c = l.replace(EMOJI_RE, '').trim();
    if (!c) return l === '';
    if (SERVICE_RE.test(c) || PRICE_RE.test(c) || PRICE_RE2.test(c) || SOLD_RE.test(c) || /^размер[а-яё]*\s*[:\-–]/i.test(c)) return false;
    const sm = c.match(SIZE_RE); if (sm && c.length < 80 && (!sm[2] || /\d/.test(sm[2]))) return false;
    if (c === name || l.replace(EMOJI_RE, '').trim() === name) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    is_product: !!(price && name), name, price, sizes, measurements,
    category: guessCategory(name + ' ' + raw), description: desc, translations: {},
  };
}

// ---------- ИИ ----------
const PARSE_PROMPT = `Ты разбираешь посты Telegram-канала магазина женской одежды Protest Style.
Верни строго JSON:
{"is_product": bool, "name": "короткое название товара на русском, без эмодзи, с заглавной буквы",
 "price": число в рублях или 0, "sizes": ["S","M",...], "measurements": {"S":"талия 64, бёдра 98"},
 "category": одно из [Осень, Зима, Лето, Обувь, Топы, Костюмы, Новинки],
 "description": "текст поста для карточки товара на русском: без служебных строк (доставка по миру, для заказа @..., скидки за отметку), без цены и строк с размерами; эмоции и детали о вещи сохрани; эмодзи можно оставить",
 "translations": {"en":{"name":"...","description":"..."},"uk":{...},"tr":{...},"zh":{...}}}
is_product = true только если в посте продаётся конкретная вещь с ценой. Анонсы, отзывы, розыгрыши — false.
Размеры пиши заглавными латинскими (XS, S, M, L, XL) или числами для обуви. Если размеров нет — пустой массив.`;

async function parsePost(text) {
  const base = ruleParse(text);
  if (!aiReady()) return base;
  try {
    const j = await chat(PARSE_PROMPT, String(text).slice(0, 4000));
    const price = Number(j.price) > 0 ? Math.round(Number(j.price)) : base.price;
    const sizes = Array.isArray(j.sizes) ? j.sizes.map(s => String(s).trim().toUpperCase()).filter(Boolean) : base.sizes;
    return {
      is_product: !!j.is_product && price > 0,
      name: String(j.name || base.name).trim(),
      price, sizes,
      measurements: j.measurements && typeof j.measurements === 'object' ? j.measurements : base.measurements,
      category: String(j.category || base.category).trim(),
      description: String(j.description ?? base.description).trim(),
      translations: cleanTranslations(j.translations),
    };
  } catch (e) {
    console.error('[ai] parse failed, using rules:', e.message);
    return base;
  }
}

function cleanTranslations(t) {
  const out = {};
  if (!t || typeof t !== 'object') return out;
  LANGS.forEach(l => { if (t[l] && typeof t[l] === 'object') out[l] = { name: String(t[l].name || '').trim(), description: String(t[l].description || '').trim() }; });
  return out;
}

// Перевод названия и описания на en/uk/tr/zh. Без ИИ возвращает пустой объект
async function translate(name, description) {
  if (!aiReady() || !(name || description)) return {};
  try {
    const j = await chat(
      'Переведи название и описание товара магазина женской одежды с русского. Верни строго JSON: {"en":{"name":"","description":""},"uk":{...},"tr":{...},"zh":{...}}. Названия коротко и естественно, без кавычек. Эмодзи сохрани.',
      JSON.stringify({ name, description }));
    return cleanTranslations(j);
  } catch (e) { console.error('[ai] translate failed:', e.message); return {}; }
}

module.exports = { parsePost, ruleParse, translate, aiReady, SOLD_RE, guessCategory };
