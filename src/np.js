'use strict';
// Трекінг Нової Пошти: за номером ТТН підтягує статус, дати й (з ключем відправника) суму
// післяплати. Метод TrackingDocument/getStatusDocuments працює і без ключа, але тоді
// Нова Пошта віддає лише статус і дати — без суми й опису відправлення.
// Ключів може бути кілька (різні кабінети): кожен опитується, береться найінформативніша
// відповідь — ключ-власник накладної бачить суми й контрагентів, чужий — лише статус або
// «Номер не знайдено» (як у скрипті таблиць).

const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';
const BATCH = 100; // ліміт номерів в одному запиті

// Коди статусів Нової Пошти → статус замовлення в застосунку (решта → checking).
// 9/10/11 — отримано; 102/103 — відмова; 105 — припинено зберігання (їде назад);
// 106 — одержано і створено ЄН зворотної доставки; 108 — заявка на повернення; 2 — видалено; 3 — не знайдено.
const STATUS_BY_CODE = {
  9: 'ok', 10: 'ok', 11: 'ok',
  102: 'refused', 103: 'refused', 105: 'refused', 106: 'refused', 108: 'refused',
  2: 'cancelled',
  3: 'nodata',
};
// Слово-проблема за кодом (як у скрипті: ОТКАЗ / ВОЗВРАТ / ОТМЕНА).
const PROBLEM_BY_CODE = { 2: 'ОТМЕНА', 102: 'ОТКАЗ', 103: 'ОТКАЗ', 105: 'ВОЗВРАТ', 106: 'ВОЗВРАТ', 108: 'ВОЗВРАТ' };
const RECEIVED_CODES = new Set(['9', '10', '11']);

const isTtn = (s) => /^\d{14}$/.test(String(s || '').trim());

// «26-09-2026 10:32:10», «30.09.2026 14:47:40» або «2026-09-30 14:48:10» → «2026-09-26».
function parseNpDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{2})[-.](\d{2})[-.](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function mapStatus(code) {
  return STATUS_BY_CODE[Number(code)] || 'checking';
}

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

// Гроші за товар, що повертаються продавцю (НЕ DocumentCost — це тариф доставки).
function npAmount(d) {
  for (const v of [d.RedeliverySum, d.BackwardDeliveryMoneyCost, d.AfterpaymentOnGoodsCost, d.CostOnSite]) {
    const a = num(v);
    if (a != null) return a;
  }
  return null;
}

// Наскільки відповідь інформативна (щоб вибрати кабінет-власника накладної).
function score(d) {
  const code = String(d.StatusCode == null ? '' : d.StatusCode).trim();
  if (code === '3' || code === '') return 0;
  let s = 2;
  if (npAmount(d) != null) s += 2;
  if (num(d.DocumentCost) != null) s += 1;
  if ([d.SenderFullNameEW, d.PhoneSender, d.RecipientFullName, d.SenderAddress].some((v) => String(v || '').trim())) s += 1;
  return s;
}

// Один документ з відповіді НП → зрозумілий об’єкт.
function mapDocument(d, account) {
  const code = String(d.StatusCode == null ? '' : d.StatusCode).trim();
  return {
    number: String(d.Number || d.DocumentNumber || ''),
    found: code !== '3' && code !== '',
    status: mapStatus(code),
    received: RECEIVED_CODES.has(code),
    problem: PROBLEM_BY_CODE[Number(code)] || '',
    npStatus: String(d.Status || ''),
    npCode: code,
    reason: String(d.UndeliveryReasonsSubtypeDescription || ''),
    amount: npAmount(d), // null = Нова Пошта суму не віддала (без ключа або передплата)
    dateCreated: parseNpDate(d.DateCreated),
    dateReceived: parseNpDate(d.RecipientDateTime),
    product: String(d.CargoDescriptionString || '').trim(),
    cityRecipient: String(d.CityRecipient || ''),
    account: account || '',
  };
}

async function fetchChunk(fetchFn, apiKey, chunk) {
  const body = {
    apiKey: apiKey || '',
    modelName: 'TrackingDocument',
    calledMethod: 'getStatusDocuments',
    methodProperties: { Documents: chunk.map((n) => ({ DocumentNumber: n, Phone: '' })) },
  };
  let res;
  try {
    res = await fetchFn(NP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Нова Пошта недоступна: ${e.message || e}`);
  }
  if (!res.ok) throw new Error(`Нова Пошта відповіла HTTP ${res.status}`);
  const json = await res.json();
  if (!json || json.success === false) throw new Error(`Нова Пошта: ${(json && json.errors || []).join('; ') || 'помилка запиту'}`);
  return json.data || [];
}

// numbers → {found: Map(номер → mapDocument), errors: [..]}. Невалідні номери (не 14 цифр) пропускаються.
// opts: {accounts: [{name, token}], apiKey, fetch}. Без ключів — один запит без ключа.
async function track(numbers, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const list = [...new Set((numbers || []).map((n) => String(n || '').trim()).filter(isTtn))];
  const out = new Map();
  const errors = [];
  if (!list.length) return { found: out, errors };
  let accounts = (opts.accounts || []).filter((a) => a && a.token);
  if (!accounts.length) accounts = [{ name: '', token: opts.apiKey || '' }];
  const best = new Map(); // номер → {doc, score}
  for (const account of accounts) {
    let failed = false;
    for (let i = 0; i < list.length && !failed; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      let docs;
      try { docs = await fetchChunk(fetchFn, account.token, chunk); }
      catch (e) { errors.push(`${account.name || 'Нова Пошта'}: ${e.message || e}`); failed = true; break; }
      for (const d of docs) {
        const number = String(d.Number || d.DocumentNumber || '').trim();
        if (!number) continue;
        const s = score(d);
        const prev = best.get(number);
        if (!prev || s > prev.score) best.set(number, { doc: d, score: s, account: account.name, employeeId: account.employeeId == null || account.employeeId === '' ? null : Number(account.employeeId) });
      }
    }
  }
  if (errors.length === accounts.length) throw new Error(errors.join('; '));
  for (const n of list) {
    const b = best.get(n);
    // employeeId — чий ключ дав найінформативнішу відповідь (ключ відправника з сумою), null = спільний або без ключа
    out.set(n, b ? Object.assign(mapDocument(b.doc, b.account), { employeeId: b.employeeId }) : Object.assign(mapDocument({ Number: n, StatusCode: '3', Status: 'Номер не знайдено' }), { employeeId: null }));
  }
  return { found: out, errors };
}

// Назва відправника кабінету (Counterparty/getCounterparties): «МАЛАЙ АНАСТАСІЯ АНДРІЇВНА ФОП» → «Малай».
async function senderName(apiKey, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  try {
    const res = await fetchFn(NP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey, modelName: 'Counterparty', calledMethod: 'getCounterparties', methodProperties: { CounterpartyProperty: 'Sender', Page: '1' } }) });
    const json = await res.json();
    const d = json && json.success && json.data && json.data[0];
    const full = String((d && d.Description) || '').replace(/\b(ФОП|ТОВ|ПП)\b/gi, '').trim();
    const first = full.split(/\s+/)[0] || '';
    return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
  } catch (e) { return ''; }
}

module.exports = { track, senderName, mapDocument, mapStatus, parseNpDate, isTtn, STATUS_BY_CODE, PROBLEM_BY_CODE, NP_URL };
