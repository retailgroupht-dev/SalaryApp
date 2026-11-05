'use strict';
// Зведення за номером: Нова Пошта + маркетплейси + Rozetka Delivery → статус, сума, дата, канал.
// Правила з Apps Script таблиць («Сверка D/E/T»):
//  - сума — еталон з маркетплейсів (Rozetka → Prom → Епіцентр), Нова Пошта лише якщо ніде не знайдено;
//  - відмова/повернення/скасування з будь-якого джерела робить рядок проблемним; пріоритет
//    ОТКАЗ > ВОЗВРАТ > ОТМЕНА; фізичне повернення посилки (перевізник) перебиває «ОК» маркетплейсу;
//  - ніде не знайдено → «немає даних».
// Відмінність від таблиці: там рядок стає «ОК», щойно знайдено суму. Тут, якщо Нова Пошта ще не
// віддала посилку (у дорозі, у відділенні), статус «Перевіряється» — до наступної перевірки.

const np = require('./np');
const mp = require('./marketplaces');

const STATUS_BY_PROBLEM = { 'ОТКАЗ': 'refused', 'ВОЗВРАТ': 'refused', 'ОТМЕНА': 'cancelled' };

// Що треба запитати для набору номерів. Дати для звуження гортання беруться лише з Нової Пошти
// (дата імпортованого замовлення = день імпорту, на неї покладатися не можна).
function plan(numbers) {
  const ttn = [], rd = [], pending = [];
  for (const n of numbers) {
    const number = String(n || '').trim();
    if (!number) continue;
    if (np.isTtn(number)) ttn.push(number);
    const rdId = mp.rozetkaDeliveryId(number);
    if (rdId) rd.push(rdId);
    pending.push({ number, date: '' });
  }
  return { ttn, rd, pending };
}

// numbers: масив номерів (ТТН 14 цифр, PRM-…, номери замовлень).
// accounts: [{kind, name, token}]. Повертає {results: Map(number → зведення), errors: [..]}.
async function lookup(numbers, accounts, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const { ttn, rd, pending } = plan(numbers);
  const errors = [];

  let npFound = new Map();
  if (ttn.length) {
    try {
      const r = await np.track(ttn, { accounts: accounts.filter((a) => a.kind === 'np'), fetch: fetchFn });
      npFound = r.found; errors.push(...r.errors);
    } catch (e) { errors.push(e.message || String(e)); }
  }
  // Дата накладної звужує гортання маркетплейсів.
  for (const p of pending) { const t = npFound.get(p.number); if (t && t.dateCreated) p.date = t.dateCreated; }

  let mpFound = new Map();
  if (accounts.some((a) => a.kind !== 'np' && a.token)) {
    const r = await mp.findOrders(pending, accounts, { fetch: fetchFn });
    mpFound = r.found; errors.push(...r.errors);
  }
  const rdFound = rd.length ? await mp.rozetkaDelivery(rd, { fetch: fetchFn }) : new Map();

  const results = new Map();
  for (const p of pending) results.set(p.number, combine(p.number, npFound.get(p.number), mpFound.get(p.number), rdFound.get(mp.rozetkaDeliveryId(p.number))));
  return { results, errors };
}

function combine(number, npR, mpR, rdR) {
  const npOk = npR && npR.found;
  const rdOk = rdR && rdR.found;
  const problems = [];
  if (mpR && mpR.problem) problems.push({ word: mpR.problem, label: mpR.channel });
  if (npOk && npR.problem) problems.push({ word: npR.problem, label: 'Нова Пошта' });
  if (rdOk && rdR.problem) problems.push({ word: rdR.problem, label: 'Rozetka Delivery' });
  let problem = '', problemLabel = '';
  for (const w of mp.PROBLEM_PRIORITY) {
    const hits = problems.filter((p) => p.word === w);
    if (hits.length) { problem = w; problemLabel = hits.map((h) => h.label).join(', '); break; }
  }
  const found = !!(mpR || npOk || rdOk);
  let status;
  if (problem) status = STATUS_BY_PROBLEM[problem];
  else if (!found) status = 'nodata';
  else if (npOk && !npR.received) status = 'checking';
  else status = 'ok';

  const amount = mpR && mpR.amount > 0 ? mpR.amount : (npOk && npR.amount != null ? npR.amount : null);
  const amountSource = mpR && mpR.amount > 0 ? mpR.channel : (npOk && npR.amount != null ? 'Нова Пошта' : '');
  const date = (mpR && mpR.date) || (npOk && npR.dateCreated) || '';
  const notes = [];
  if (mpR) notes.push(`${mpR.channel}: ${mpR.status}${mpR.orderId ? ` (№${mpR.orderId})` : ''}`);
  if (npOk) notes.push(`Нова Пошта: ${npR.npStatus}${npR.reason ? ` (${npR.reason})` : ''}${npR.dateReceived ? `, отримано ${npR.dateReceived}` : ''}`);
  else if (npR) notes.push('Нова Пошта: номер не знайдено');
  if (rdR) notes.push(`Rozetka Delivery: ${rdR.status}`);
  return {
    number, found, status, problem, problemLabel, amount, amountSource, date,
    channel: mpR ? mpR.channel : '',
    product: (mpR && mpR.product) || (npOk && npR.product) || '',
    dateReceived: npOk ? npR.dateReceived : '',
    note: (problem ? `${problem} (${problemLabel}); ` : '') + notes.join('; '),
    np: npR ? { status: npR.npStatus, code: npR.npCode, reason: npR.reason, received: npR.dateReceived } : null,
    mp: mpR ? { kind: mpR.kind, channel: mpR.channel, orderId: mpR.orderId, status: mpR.status } : null,
    rd: rdR ? { status: rdR.status } : null,
  };
}

module.exports = { lookup, combine, plan };
