'use strict';
// Маркетплейси (Prom, Rozetka, Епіцентр) і трекінг Rozetka Delivery — перенесено з Apps Script
// «Проверка заказов» таблиць Настя/Товкес. За номером ТТН чи замовлення знаходить замовлення
// в кабінетах, бере суму, дату створення, статус, канал (назву кабінету) і товар.
//
// Перевірено на живих API (05.11.2026): Prom — orders/list (date_created, price «790 грн»,
// delivery_provider_data.declaration_number); Rozetka — orders/search (created, amount, ttn,
// пошук ?ttn=, pageSize=100); Епіцентр — v4/oms/orders (createdAt, subtotal, address.shipment.number).

const PROM_URL = 'https://my.prom.ua/api/v1';
const ROZETKA_URL = 'https://api-seller.rozetka.com.ua';
const EPICENTER_URL = 'https://merchant-api.epicentrm.com.ua';
const RD_URL = 'https://rz-delivery.rozetka.ua/api/track/public/';

const KINDS = { np: 'Нова Пошта', rozetka: 'Rozetka', prom: 'Prom.ua', epicentr: 'Епіцентр' };
// Порядок = пріоритет джерела суми й статусу (як у скрипті: Rozetka → Prom → Епіцентр).
const MP_ORDER = ['rozetka', 'prom', 'epicentr'];
const PROBLEM_PRIORITY = ['ОТКАЗ', 'ВОЗВРАТ', 'ОТМЕНА'];
const MAX_PAGES = 120;      // захист від нескінченного гортання (на кабінет)
const LOOKBACK_DAYS = 14;   // замовлення на маркетплейсі створюється раніше за накладну
const DEFAULT_LOOKBACK_DAYS = 180; // коли дат узагалі немає

// ---------- спільне ----------
function parseMoney(value) {
  if (value == null || value === '') return null;
  const s = String(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function normalizeKey(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, '').replace(/^PRM(?=\d)/, 'PRM-');
}

function addKey(set, value) {
  const k = normalizeKey(value);
  if (!k) return;
  set.add(k);
  set.add(k.replace(/-/g, ''));
}

// Коди посилок у клітинці: PRM-123456 (Rozetka Delivery), RMP-123456 (Rozetka через Meest) тощо.
function parcelCodes(text) {
  return (String(text || '').toUpperCase().match(/\b[A-Z]{2,4}[-\s]?\d{6,}\b/g) || []).map((v) => v.replace(/^([A-Z]+)[-\s]?/, '$1-'));
}

// Усі правдоподібні ключі з номера у клітинці: рядок цілком, коди PRM-/RMP-, числа 6–20 цифр.
function lookupKeys(text) {
  const src = String(text || '').trim();
  const keys = new Set();
  if (!src) return [];
  addKey(keys, src);
  for (const v of parcelCodes(src)) addKey(keys, v);
  for (const v of src.match(/\d{6,20}/g) || []) addKey(keys, v);
  return [...keys];
}

// Що пробувати в прямому пошуку Rozetka (?ttn=): рядок цілком, потім коди посилок і 14-значні ТТН.
function searchCandidates(text) {
  const src = String(text || '').trim();
  const out = new Set([src]);
  for (const v of parcelCodes(src)) out.add(v);
  for (const v of src.match(/\b\d{14}\b/g) || []) out.add(v);
  return [...out].filter(Boolean);
}

function rozetkaDeliveryId(text) {
  const s = String(text || '').toUpperCase();
  const prm = /PRM[-\s]?(\d{6,})/.exec(s);
  if (prm) return 'PRM-' + prm[1];
  const other = /\b([A-Z]{2,4})[-\s](\d{6,})\b/.exec(s);
  return other ? other[1] + '-' + other[2] : '';
}

// Скасування / повернення / відмова за текстом статусу (укр/рос/англ) — як у скрипті.
function problemByText(statusText) {
  const t = String(statusText || '').toLowerCase();
  if (!t) return '';
  if (/скасов|відмін|отмен|видален|cancel/.test(t)) return 'ОТМЕНА';
  if (/поверн|поверт|зворотн|припинено збер|возврат|возвращ|вернул|return/.test(t)) return 'ВОЗВРАТ';
  if (/відмов|отказ|reject|refus|не прийшов за замовлен/.test(t)) return 'ОТКАЗ';
  // Статуси Rozetka без відправлення: клієнт передумав, не вдалося зв'язатися, немає в наявності.
  if (/передумав|не вдалося зв.язатися|немає в наявності|нет в наличии/.test(t)) return 'ОТМЕНА';
  return '';
}

// «2026-11-04T17:18:58+00:00» / «2026-11-05 15:49:55» → «YYYY-MM-DD» за київським часом.
function dateOf(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}( |$)/.test(s)) return s.slice(0, 10); // уже місцевий час без зони
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); }
  catch (e) { return d.toISOString().slice(0, 10); }
}

function shiftDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayStr() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); }

async function getJson(fetchFn, url, token, label) {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'follow' });
  } catch (e) {
    throw new Error(`${label}: немає з’єднання (${e.message || e})`);
  }
  const text = await res.text();
  if (res.status === 401) throw new Error(`${label}: HTTP 401 — токен недійсний або прострочений`);
  if (res.status === 403) throw new Error(`${label}: HTTP 403 — у токена немає доступу до замовлень`);
  if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { throw new Error(`${label}: відповідь не JSON`); }
}

// ---------- Prom.ua ----------
const PROM_STATUS = { pending: 'Новий', received: 'Прийнято', delivered: 'Виконано', canceled: 'Скасовано', draft: 'Чернетка', paid: 'Оплачено', returned: 'Повернено' };
const prom = {
  kind: 'prom',
  async fetchPage(account, cursor, { fetch: fetchFn, cutoff }) {
    const params = ['limit=100'];
    if (cutoff) params.push('date_from=' + encodeURIComponent(cutoff + 'T00:00:00'));
    if (cursor) params.push('last_id=' + encodeURIComponent(cursor));
    const json = await getJson(fetchFn, `${PROM_URL}/orders/list?${params.join('&')}`, account.token, 'Prom.ua');
    if (json.errors) throw new Error('Prom.ua: ' + (typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors)));
    const items = Array.isArray(json.orders) ? json.orders : [];
    const last = items.length ? items[items.length - 1] : null;
    return { items, next: items.length === 100 && last && last.id != null ? last.id : null };
  },
  keys(o) {
    const s = new Set();
    for (const v of [o.id, o.external_id, o.order_number, o.ttn]) addKey(s, v);
    if (o.delivery_option) for (const v of [o.delivery_option.declaration_id, o.delivery_option.tracking_id, o.delivery_option.number]) addKey(s, v);
    if (o.delivery_provider_data) for (const v of [o.delivery_provider_data.declaration_number, o.delivery_provider_data.ttn]) addKey(s, v);
    return [...s];
  },
  status(o) { return String(o.status_name || PROM_STATUS[o.status] || o.status || 'Статус не отримано'); },
  problem(o) {
    const code = String(o.status || '').toLowerCase();
    if (code === 'canceled' || code === 'cancelled') return 'ОТМЕНА';
    if (code === 'returned') return 'ВОЗВРАТ';
    return problemByText(o.status_name);
  },
  amount(o) { for (const v of [o.full_price, o.price, o.total_price, o.amount]) { const a = parseMoney(v); if (a != null) return a; } return 0; },
  date(o) { return dateOf(o.date_created); },
  product(o) { return (Array.isArray(o.products) ? o.products : []).map((p) => p.name).filter(Boolean).join('; '); },
  orderId(o) { return String(o.id || ''); },
  ttn(o) { const d = o.delivery_provider_data || {}, opt = o.delivery_option || {}; return String(d.declaration_number || d.ttn || opt.declaration_id || opt.tracking_id || o.ttn || '').trim(); },
  done(o) { return String(o.status || '').toLowerCase() === 'delivered' || /виконан|доставлен|получен/i.test(o.status_name || ''); },
  // Замовлення за період створення: date_from/date_to + гортання за last_id.
  async list(account, { from, to, fetch: fetchFn }) {
    const out = [];
    let cursor = null, pages = 0;
    while (pages < MAX_PAGES) {
      const params = ['limit=100', 'date_from=' + encodeURIComponent(from + 'T00:00:00'), 'date_to=' + encodeURIComponent(shiftDays(to, 1) + 'T00:00:00')];
      if (cursor) params.push('last_id=' + encodeURIComponent(cursor));
      const json = await getJson(fetchFn, `${PROM_URL}/orders/list?${params.join('&')}`, account.token, 'Prom.ua');
      if (json.errors) throw new Error('Prom.ua: ' + (typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors)));
      const items = Array.isArray(json.orders) ? json.orders : [];
      out.push(...items);
      pages++;
      const last = items.length ? items[items.length - 1] : null;
      if (items.length < 100 || !last || last.id == null) break;
      cursor = last.id;
    }
    return out;
  },
};

// ---------- Rozetka ----------
const rozetka = {
  kind: 'rozetka',
  async fetchPage(account, cursor, { fetch: fetchFn, cutoff }) {
    const page = Number(cursor) || 1;
    const params = [`page=${page}`, 'types=1', 'sort=-id', 'pageSize=100', 'expand=' + encodeURIComponent('status_data,delivery,purchases')];
    if (cutoff) params.push('created_from=' + cutoff);
    const json = await getJson(fetchFn, `${ROZETKA_URL}/orders/search?${params.join('&')}`, account.token, 'Rozetka');
    if (!json.success) throw new Error('Rozetka: ' + rozetkaError(json));
    const content = json.content || {};
    const items = Array.isArray(content.orders) ? content.orders : [];
    const meta = content._meta || json._meta || {};
    const pageCount = Math.max(1, parseInt(meta.pageCount, 10) || 1);
    return { items, next: page + 1 <= pageCount ? page + 1 : null };
  },
  // Прямий пошук за ТТН — один запит на номер (коли номерів мало).
  async searchTtn(account, number, { fetch: fetchFn }) {
    const json = await getJson(fetchFn, `${ROZETKA_URL}/orders/search?types=1&ttn=${encodeURIComponent(number)}&expand=${encodeURIComponent('status_data,delivery,purchases')}`, account.token, 'Rozetka');
    if (!json.success) throw new Error('Rozetka: ' + rozetkaError(json));
    return Array.isArray((json.content || {}).orders) ? json.content.orders : [];
  },
  keys(o) {
    const s = new Set();
    for (const v of [o.id, o.order_id, o.number, o.ttn]) addKey(s, v);
    if (o.delivery) for (const v of [o.delivery.ttn, o.delivery.number, o.delivery.document_number, o.delivery.tracking_number, o.delivery.delivery_number]) addKey(s, v);
    return [...s];
  },
  status(o) {
    const sd = o.status_data || {};
    return String(sd.name_uk || sd.name_ru || sd.name || sd.title_uk || sd.title || o.status_name || (o.status != null ? 'Статус Rozetka №' + o.status : 'Статус не отримано'));
  },
  problem(o) { return problemByText(rozetka.status(o)); },
  amount(o) { for (const v of [o.cost_with_discount, o.amount_with_discount, o.cost, o.amount, o.total]) { const a = parseMoney(v); if (a != null) return a; } return 0; },
  date(o) { return dateOf(o.created); },
  product(o) { return (Array.isArray(o.purchases) ? o.purchases : []).map((p) => p.item_name).filter(Boolean).join('; '); },
  orderId(o) { return String(o.id || ''); },
  ttn(o) { const d = o.delivery || {}; return String(o.ttn || d.ttn || d.document_number || d.tracking_number || '').trim(); },
  done(o) { return /виконано|доставлено|отримано|выполнен|доставлен|получен/i.test(rozetka.status(o)); },
  async list(account, { from, to, fetch: fetchFn }) {
    const out = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const params = [`page=${page}`, 'types=1', 'sort=-id', 'pageSize=100', 'created_from=' + from, 'created_to=' + to, 'expand=' + encodeURIComponent('status_data,delivery,purchases')];
      const json = await getJson(fetchFn, `${ROZETKA_URL}/orders/search?${params.join('&')}`, account.token, 'Rozetka');
      if (!json.success) throw new Error('Rozetka: ' + rozetkaError(json));
      const content = json.content || {};
      const items = Array.isArray(content.orders) ? content.orders : [];
      out.push(...items);
      const meta = content._meta || json._meta || {};
      const pageCount = Math.max(1, parseInt(meta.pageCount, 10) || 1);
      if (page >= pageCount || !items.length) break;
      page++;
    }
    return out;
  },
};
function rozetkaError(json) {
  const e = json && json.errors;
  if (!e) return (json && json.message) || 'невідома помилка API';
  if (typeof e === 'string') return e;
  if (Array.isArray(e)) return e.map((x) => (typeof x === 'string' ? x : x.message || x.description || JSON.stringify(x))).join('; ');
  return e.message || e.description || JSON.stringify(e);
}

// ---------- Епіцентр ----------
const EPIC_STATUS = {
  new: 'Новий', confirmed_by_merchant: 'Підтверджено продавцем', confirmed: 'Підтверджено', sent: 'Відправлено', received: 'Отримано',
  delivered: 'Готово до видачі', completed: 'Завершено', closed: 'Закрито', canceled: 'Скасовано', returned: 'Повернено',
  return_requested: 'Запит на повернення', canceled_by_merchant: 'Скасовано продавцем', completed_merchant_rejection: 'Завершено (відмова продавця)', closed_merchant_rejection: 'Закрито (відмова продавця)',
};
const EPIC_PROBLEM = { canceled: 'ОТМЕНА', canceled_by_merchant: 'ОТМЕНА', returned: 'ВОЗВРАТ', return_requested: 'ВОЗВРАТ', completed_merchant_rejection: 'ОТКАЗ', closed_merchant_rejection: 'ОТКАЗ' };
const EPIC_WHO = { call_center: 'кол-центр', customer: 'покупець', merchant: 'продавець' };
const EPIC_WHY = { order_not_actual: 'замовлення неактуальне', product_not_available: 'немає в наявності', price_differs: 'ціна не відповідає', delivery_not_available: 'не возимо в цей регіон' };
const epicentr = {
  kind: 'epicentr',
  async fetchPage(account, cursor, { fetch: fetchFn, seen }) {
    const params = ['limit=100', 'sort%5B%5D=-createdAt'];
    if (cursor) params.push('cursor=' + encodeURIComponent(cursor));
    const json = await getJson(fetchFn, `${EPICENTER_URL}/v4/oms/orders?${params.join('&')}`, account.token, 'Епіцентр');
    const items = Array.isArray(json.items) ? json.items : [];
    let next = json.next ? String(json.next) : null;
    if (next && (next === String(json.current || '') || (seen && seen.has(next)))) next = null;
    if (next && seen) seen.add(next);
    if (items.length < 100) next = null;
    return { items, next };
  },
  keys(o) {
    const s = new Set();
    for (const v of [o.id, o.number, o.externalId]) addKey(s, v);
    if (o.address && o.address.shipment) addKey(s, o.address.shipment.number);
    return [...s];
  },
  status(o) {
    const code = String(o.statusCode || o.status || '').trim();
    if (!code) return 'Статус не отримано';
    let text = EPIC_STATUS[code] || code;
    const c = o.cancel;
    if (c && (c.initiatorCode || c.reasonCode)) {
      const parts = [EPIC_WHO[c.initiatorCode] || c.initiatorCode || '', EPIC_WHY[c.reasonCode] || c.reasonCode || ''].filter(Boolean);
      if (parts.length) text += ` (${parts.join(': ')})`;
    }
    return text;
  },
  problem(o) { return EPIC_PROBLEM[String(o.statusCode || '').trim()] || ''; },
  amount(o) { const a = parseMoney(o.subtotal); return a == null ? 0 : a; },
  date(o) { return dateOf(o.createdAt); },
  product(o) { return (Array.isArray(o.items) ? o.items : []).map((i) => i.title || i.name).filter(Boolean).join('; '); },
  orderId(o) { return String(o.number || o.id || ''); },
  ttn(o) { return String((o.address && o.address.shipment && o.address.shipment.number) || '').trim(); },
  done(o) { return ['received', 'completed', 'closed'].includes(String(o.statusCode || '').trim()); },
  // Курсорне гортання від нових до старих, доки не стали старіші за from.
  async list(account, { from, to, fetch: fetchFn }) {
    const out = [];
    let cursor = null, pages = 0;
    const seen = new Set();
    while (pages < MAX_PAGES) {
      const page = await epicentr.fetchPage(account, cursor, { fetch: fetchFn, seen });
      pages++;
      for (const o of page.items) { const d = epicentr.date(o); if (d && d >= from && d <= to) out.push(o); }
      const ds = page.items.map((o) => epicentr.date(o)).filter(Boolean);
      if (!page.next || (ds.length && ds.every((d) => d < from))) break;
      cursor = page.next;
    }
    return out;
  },
};

const CHANNELS = { prom, rozetka, epicentr };

// employeeId — чий кабінет знайшов замовлення (null = спільний кабінет).
function describe(ch, o, account) {
  return {
    kind: ch.kind, channel: account.name, orderId: ch.orderId(o), status: ch.status(o), problem: ch.problem(o),
    amount: ch.amount(o), date: ch.date(o), product: ch.product(o), ttn: ch.ttn(o), done: ch.done(o),
    employeeId: account.employeeId == null || account.employeeId === '' ? null : Number(account.employeeId),
  };
}

// Усі замовлення кабінетів за період [from, to] (дата створення замовлення).
// Повертає {items: [describe + employeeId], errors}. Дублікати (один TTN у двох кабінетах) не зливаються.
async function listOrders(accounts, { from, to, fetch: fetchFn } = {}) {
  fetchFn = fetchFn || globalThis.fetch;
  const items = [], errors = [];
  for (const account of accounts) {
    const ch = CHANNELS[account.kind];
    if (!ch || !account.token) continue;
    try {
      for (const o of await ch.list(account, { from, to, fetch: fetchFn })) {
        const d = ch.date(o);
        if (d && (d < from || d > to)) continue;
        items.push(describe(ch, o, account));
      }
    } catch (e) { errors.push(`${account.name}: ${e.message || e}`); }
  }
  return { items, errors };
}

// pending: [{number, date?}] — date (якщо відома) звужує період гортання.
// accounts: [{kind, name, token}]. Повертає {found: Map(number → describe), errors: [..]}.
// Канали в порядку пріоритету; знайдене в Rozetka далі в Prom не шукається (як еталон у скрипті).
async function findOrders(pending, accounts, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const found = new Map();
  const errors = [];
  const remaining = new Map(); // number → keys
  for (const p of pending) if (p.number && !remaining.has(p.number)) remaining.set(p.number, lookupKeys(p.number));
  if (!remaining.size) return { found, errors };
  const dates = pending.map((p) => p.date).filter(Boolean).sort();
  const cutoff = dates.length ? shiftDays(dates[0], -LOOKBACK_DAYS) : shiftDays(todayStr(), -DEFAULT_LOOKBACK_DAYS);

  const matchItems = (ch, account, items) => {
    for (const o of items) {
      if (!o || typeof o !== 'object') continue;
      const keys = ch.keys(o);
      for (const [number, nkeys] of remaining) {
        if (keys.some((k) => nkeys.includes(k))) { found.set(number, describe(ch, o, account)); remaining.delete(number); }
      }
    }
  };

  for (const kind of MP_ORDER) {
    const ch = CHANNELS[kind];
    for (const account of accounts.filter((a) => a.kind === kind && a.token)) {
      if (!remaining.size) return { found, errors };
      try {
        if (kind === 'rozetka' && remaining.size <= 25) {
          for (const number of [...remaining.keys()]) {
            for (const cand of searchCandidates(number)) {
              matchItems(ch, account, await ch.searchTtn(account, cand, { fetch: fetchFn }));
              if (!remaining.has(number)) break;
            }
          }
          continue;
        }
        let cursor = null, pages = 0;
        const seen = new Set();
        while (remaining.size && pages < MAX_PAGES) {
          const page = await ch.fetchPage(account, cursor, { fetch: fetchFn, cutoff, seen });
          pages++;
          matchItems(ch, account, page.items);
          // Сторінки відсортовано від нових до старих: якщо вся сторінка старіша за cutoff — далі нема сенсу.
          const ds = page.items.map((o) => ch.date(o)).filter(Boolean);
          if (ds.length && ds.every((d) => d < cutoff)) break;
          if (!page.next) break;
          cursor = page.next;
        }
      } catch (e) {
        errors.push(`${account.name}: ${e.message || e}`);
      }
    }
  }
  return { found, errors };
}

// Rozetka Delivery (PRM-…): публічний трекінг без ключа, лише статус.
// Публічний трекінг обмежує частоту запитів (HTTP 429): між запитами пауза, на 429 — до трьох повторів із
// зростанням очікування; opts.sleep підміняється в тестах.
const RD_PAUSE_MS = 250, RD_RETRY_MS = [2000, 5000, 10000];
async function rozetkaDelivery(ids, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = new Map();
  let first = true;
  for (const id of [...new Set(ids.filter(Boolean))]) {
    try {
      if (!first) await sleep(RD_PAUSE_MS);
      first = false;
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await fetchFn(RD_URL + encodeURIComponent(id), { headers: { Accept: 'application/json' }, redirect: 'follow' });
        if (res.status !== 429 || attempt >= RD_RETRY_MS.length) break;
        await sleep(RD_RETRY_MS[attempt]);
      }
      if (res.status === 404) { out.set(id, { found: false, status: 'посилку не знайдено' }); continue; }
      if (res.status !== 200) { out.set(id, { found: false, status: `HTTP ${res.status}` }); continue; }
      const json = await res.json();
      const data = json.data || {};
      const status = String(data.last_status_name || '').trim();
      out.set(id, { found: !!status, status: status || 'статус не прийшов', code: data.last_status, date: dateOf(data.last_status_date), problem: problemByText(status) });
    } catch (e) {
      out.set(id, { found: false, status: 'немає з’єднання' });
    }
  }
  return out;
}

// Перевірка одного кабінету: перша сторінка замовлень.
async function testAccount(account, opts = {}) {
  const ch = CHANNELS[account.kind];
  if (!ch) return { ok: false, message: 'невідомий канал' };
  try {
    const page = await ch.fetchPage(account, null, { fetch: opts.fetch || globalThis.fetch, seen: new Set() });
    const o = page.items[0];
    return { ok: true, message: o ? `працює, останнє замовлення ${ch.orderId(o)} від ${ch.date(o)}` : 'працює, замовлень немає' };
  } catch (e) { return { ok: false, message: e.message || String(e) }; }
}

// Ключі з тексту Apps Script таблиць: NOVA_POSHTA_ACCOUNTS / PROM_ACCOUNTS / EPICENTER_ACCOUNTS / ROZETKA_ACCOUNTS.
function parseScriptAccounts(text) {
  const src = String(text || '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const out = [];
  const names = { NOVA_POSHTA_ACCOUNTS: 'np', PROM_ACCOUNTS: 'prom', EPICENTER_ACCOUNTS: 'epicentr', ROZETKA_ACCOUNTS: 'rozetka' };
  for (const [constName, kind] of Object.entries(names)) {
    const re = new RegExp('const\\s+' + constName + '\\s*=\\s*\\[([\\s\\S]*?)\\];', 'g');
    let m, body = null;
    while ((m = re.exec(src))) body = m[1];
    if (!body) continue;
    const re2 = /\{[^{}]*?name\s*:\s*['"]([^'"]*)['"][^{}]*?(?:token|key)\s*:\s*['"]([^'"]*)['"][^{}]*\}/g;
    let x;
    while ((x = re2.exec(body))) {
      const token = x[2].trim();
      if (!token || /ВСТАВЬТЕ|ВСТАВТЕ/i.test(token)) continue;
      out.push({ kind, name: x[1].trim() || KINDS[kind], token });
    }
  }
  return out;
}

module.exports = {
  KINDS, MP_ORDER, PROBLEM_PRIORITY, CHANNELS, findOrders, listOrders, rozetkaDelivery, testAccount, parseScriptAccounts,
  lookupKeys, searchCandidates, parcelCodes, rozetkaDeliveryId, problemByText, parseMoney, normalizeKey, dateOf, shiftDays,
};
