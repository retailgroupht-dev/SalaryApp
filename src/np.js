'use strict';
// Трекінг Нової Пошти: за номером ТТН підтягує статус, дати й (з ключем відправника) суму
// післяплати. Метод TrackingDocument/getStatusDocuments працює і без ключа, але тоді
// Нова Пошта віддає лише статус і дати — без суми й опису відправлення.

const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';
const BATCH = 100; // ліміт номерів в одному запиті

// Коди статусів Нової Пошти → статус замовлення в застосунку.
// 9/10/11 — отримано; 106 — одержано і створено ЄН зворотної доставки (гроші);
// 102/103 — відмова; 105 — припинено зберігання (повертається); 2 — видалено; 3 — не знайдено.
const STATUS_BY_CODE = {
  9: 'ok', 10: 'ok', 11: 'ok', 106: 'ok',
  102: 'refused', 103: 'refused', 105: 'refused',
  2: 'cancelled',
  3: 'nodata',
};

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

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

// Один документ з відповіді НП → зрозумілий об’єкт.
function mapDocument(d) {
  const code = String(d.StatusCode || '');
  const amount = num(d.RedeliverySum) || num(d.AfterpaymentOnGoodsCost);
  return {
    number: String(d.Number || ''),
    found: code !== '3' && code !== '',
    status: mapStatus(code),
    npStatus: String(d.Status || ''),
    npCode: code,
    reason: String(d.UndeliveryReasonsSubtypeDescription || ''),
    amount, // null = Нова Пошта суму не віддала (без ключа або передплата)
    dateCreated: parseNpDate(d.DateCreated),
    dateReceived: parseNpDate(d.RecipientDateTime),
    product: String(d.CargoDescriptionString || '').trim(),
    cityRecipient: String(d.CityRecipient || ''),
  };
}

// numbers → Map(номер → mapDocument). Невалідні номери (не 14 цифр) пропускаються.
// opts: {apiKey, fetch} (fetch підміняється в тестах).
async function track(numbers, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const list = [...new Set((numbers || []).map((n) => String(n || '').trim()).filter(isTtn))];
  const out = new Map();
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const body = {
      apiKey: opts.apiKey || '',
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
    for (const d of json.data || []) {
      const m = mapDocument(d);
      if (m.number) out.set(m.number, m);
    }
    for (const n of chunk) if (!out.has(n)) out.set(n, Object.assign(mapDocument({ Number: n, StatusCode: '3', Status: 'Номер не знайдено' }), { found: false }));
  }
  return out;
}

module.exports = { track, mapDocument, mapStatus, parseNpDate, isTtn, STATUS_BY_CODE, NP_URL };
