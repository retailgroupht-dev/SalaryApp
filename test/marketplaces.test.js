'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mp = require('../src/marketplaces');
const { combine } = require('../src/lookup');

// Підроблені маркетплейси: Prom (2 сторінки), Rozetka (пошук за ТТН і сторінки), Епіцентр, Rozetka Delivery.
function fakeFetch(log) {
  const promOrders = [
    { id: 437983108, date_created: '2026-11-04T17:18:58+00:00', status: 'received', status_name: 'Принят', price: '790 грн', delivery_provider_data: { declaration_number: '20451579375457' }, products: [{ name: 'Мультитул' }] },
    { id: 437000001, date_created: '2026-10-20T10:00:00+00:00', status: 'canceled', status_name: 'Отменен', price: '300 грн', delivery_provider_data: { declaration_number: '20451570000001' }, products: [] },
  ];
  const promOld = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, date_created: '2026-05-01T10:00:00+00:00', status: 'delivered', price: '1 грн', delivery_provider_data: {} }));
  const rz = { id: 910828670, created: '2026-11-05 15:49:55', status: 61, status_data: { name_uk: 'Заплановано передачу перевізникові' }, amount: '698.00', ttn: '20451579802951', purchases: [{ item_name: 'Трусики' }] };
  const ep = { id: 'uuid-1', number: '58740405', createdAt: '2026-11-05T09:59:26+00:00', statusCode: 'canceled', cancel: { initiatorCode: 'customer', reasonCode: 'order_not_actual' }, subtotal: 805, address: { shipment: { number: '20451579111111' } }, items: [{ title: 'Підсумок' }] };
  return async (url, init) => {
    log.push(url);
    const json = (body, status = 200) => ({ status, ok: status === 200, text: async () => JSON.stringify(body), json: async () => body });
    if (url.startsWith('https://my.prom.ua')) {
      const u = new URL(url);
      if (u.searchParams.get('last_id')) return json({ orders: [] });
      // перша сторінка: 2 свіжі + 98 старих = 100 → є наступна сторінка
      return json({ orders: [...promOrders, ...promOld.slice(0, 98)] });
    }
    if (url.startsWith('https://api-seller.rozetka.com.ua')) {
      const u = new URL(url);
      const ttn = u.searchParams.get('ttn');
      if (ttn) return json({ success: true, content: { orders: ttn === rz.ttn ? [rz] : [], _meta: { pageCount: 1 } } });
      return json({ success: true, content: { orders: [rz], _meta: { pageCount: 1, perPage: 100 } } });
    }
    if (url.startsWith('https://merchant-api.epicentrm.com.ua')) return json({ items: [ep], next: null });
    if (url.startsWith('https://rz-delivery.rozetka.ua')) {
      if (url.endsWith('PRM-700000001')) return json({ data: { last_status: 60040, last_status_name: 'Відмова від одержання', last_status_date: '2026-08-17 14:19:43' } });
      if (url.endsWith('RMP-700000003')) { log.push('rd3'); return log.filter((x) => x === 'rd3').length < 3 ? json({}, 429) : json({ data: { last_status: 60030, last_status_name: 'Видано', last_status_date: '2026-08-18 10:00:00' } }); }
      if (url.endsWith('RMP-700000004')) return json({}, 429);
      return json({}, 404);
    }
    throw new Error('невідома адреса ' + url);
  };
}

const ACCOUNTS = [
  { kind: 'rozetka', name: 'Rozetka', token: 'r' },
  { kind: 'prom', name: 'Пром 1', token: 'p1' },
  { kind: 'epicentr', name: 'Епіцентр', token: 'e' },
];

test('маркетплейси: ключі, дати, гроші, проблеми за текстом', () => {
  assert.deepStrictEqual(mp.lookupKeys('PRM 123456'), ['PRM-123456', 'PRM123456', '123456']);
  assert.strictEqual(mp.rozetkaDeliveryId('prm-700000001'), 'PRM-700000001');
  // Rozetka через Meest: у клітинці «RMP-243919525 723-4442154», у Rozetka ttn = RMP-243919525
  assert.deepStrictEqual(mp.parcelCodes('RMP-243919525 723-4442154'), ['RMP-243919525']);
  assert.ok(mp.lookupKeys('RMP-243919525 723-4442154').includes('RMP-243919525'));
  assert.deepStrictEqual(mp.searchCandidates('RMP-243919525 723-4442154'), ['RMP-243919525 723-4442154', 'RMP-243919525']);
  assert.deepStrictEqual(mp.searchCandidates('20451579802951'), ['20451579802951']);
  assert.strictEqual(mp.rozetkaDeliveryId('RMP-243919525 723-4442154'), 'RMP-243919525');
  assert.strictEqual(mp.rozetkaDeliveryId('20451579802951'), '');
  assert.strictEqual(mp.parseMoney('790 грн'), 790);
  assert.strictEqual(mp.parseMoney('1 234,50'), 1234.5);
  assert.strictEqual(mp.dateOf('2026-11-05 15:49:55'), '2026-11-05');
  assert.strictEqual(mp.dateOf('2026-11-04T22:30:00+00:00'), '2026-11-05'); // київський час
  assert.strictEqual(mp.problemByText('Відмова від одержання'), 'ОТКАЗ');
  assert.strictEqual(mp.problemByText('Відправлення повертається до відправника'), 'ВОЗВРАТ');
  assert.strictEqual(mp.problemByText('Скасовано'), 'ОТМЕНА');
  assert.strictEqual(mp.problemByText('Не прийшов за замовленням'), 'ОТКАЗ');
  assert.strictEqual(mp.problemByText('Клієнт передумав'), 'ОТМЕНА');
  assert.strictEqual(mp.problemByText("Не вдалося зв'язатися"), 'ОТМЕНА');
  assert.strictEqual(mp.problemByText('Заплановано передачу перевізникові'), '');
  assert.strictEqual(mp.problemByText('Прибув на відділення'), '');
  assert.strictEqual(mp.shiftDays('2026-03-01', -14), '2026-02-15');
});

test('маркетплейси: пошук за номерами в Rozetka → Prom → Епіцентр, зупинка за датою', async () => {
  const log = [];
  const r = await mp.findOrders([
    { number: '20451579802951', date: '2026-11-05' }, { number: '20451579375457', date: '2026-11-04' },
    { number: '20451579111111', date: '' }, { number: '20459999999999', date: '' }, { number: '437000001', date: '' },
  ], ACCOUNTS, { fetch: fakeFetch(log) });
  assert.deepStrictEqual(r.errors, []);
  const rz = r.found.get('20451579802951');
  assert.deepStrictEqual({ channel: rz.channel, amount: rz.amount, date: rz.date, product: rz.product, problem: rz.problem }, { channel: 'Rozetka', amount: 698, date: '2026-11-05', product: 'Трусики', problem: '' });
  const pr = r.found.get('20451579375457');
  assert.deepStrictEqual({ channel: pr.channel, amount: pr.amount, date: pr.date, status: pr.status }, { channel: 'Пром 1', amount: 790, date: '2026-11-04', status: 'Принят' });
  assert.deepStrictEqual({ problem: r.found.get('437000001').problem, status: r.found.get('437000001').status }, { problem: 'ОТМЕНА', status: 'Отменен' }); // за id замовлення Prom
  const ep = r.found.get('20451579111111');
  assert.deepStrictEqual({ channel: ep.channel, amount: ep.amount, problem: ep.problem, status: ep.status }, { channel: 'Епіцентр', amount: 805, problem: 'ОТМЕНА', status: 'Скасовано (покупець: замовлення неактуальне)' });
  assert.strictEqual(r.found.has('20459999999999'), false);
  // Rozetka — прямий пошук за кожним номером (їх ≤ 25); Prom — перша сторінка повна (100) → друга порожня
  assert.strictEqual(log.filter((u) => u.includes('rozetka.com.ua') && u.includes('ttn=')).length, 5);
  assert.strictEqual(log.filter((u) => u.includes('my.prom.ua')).length, 2);
  assert.ok(log.find((u) => u.includes('my.prom.ua')).includes('date_from=2026-10-21')); // 2026-11-04 − 14 днів
});

test('маркетплейси: помилка кабінету не зупиняє решту', async () => {
  const r = await mp.findOrders([{ number: '20451579375457', date: '' }], [{ kind: 'rozetka', name: 'Rozetka', token: 'bad' }, ...ACCOUNTS.slice(1)], {
    fetch: async (url, init) => {
      if (url.includes('rozetka.com.ua')) return { status: 401, ok: false, text: async () => '' };
      return fakeFetch([])(url, init);
    },
  });
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /Rozetka: .*401/);
  assert.strictEqual(r.found.get('20451579375457').channel, 'Пром 1');
});

test('Rozetka Delivery і перевірка кабінету', async () => {
  const log = [];
  const waits = [];
  const rd = await mp.rozetkaDelivery(['PRM-700000001', 'PRM-700000002', 'RMP-700000003', 'RMP-700000004'], { fetch: fakeFetch(log), sleep: async (ms) => { waits.push(ms); } });
  assert.deepStrictEqual({ found: rd.get('PRM-700000001').found, problem: rd.get('PRM-700000001').problem, date: rd.get('PRM-700000001').date }, { found: true, problem: 'ОТКАЗ', date: '2026-08-17' });
  assert.strictEqual(rd.get('PRM-700000002').found, false);
  // 429 двічі, потім відповідь — повтори з паузами; суцільні 429 — HTTP 429 після трьох повторів
  assert.deepStrictEqual({ found: rd.get('RMP-700000003').found, status: rd.get('RMP-700000003').status }, { found: true, status: 'Видано' });
  assert.deepStrictEqual({ found: rd.get('RMP-700000004').found, status: rd.get('RMP-700000004').status }, { found: false, status: 'HTTP 429' });
  assert.deepStrictEqual(waits, [250, 250, 2000, 5000, 250, 2000, 5000, 10000]);
  const t = await mp.testAccount(ACCOUNTS[0], { fetch: fakeFetch(log) });
  assert.strictEqual(t.ok, true);
  assert.match(t.message, /910828670/);
});

test('маркетплейси: замовлення за період з кабінетів (listOrders)', async () => {
  const log = [];
  const r = await mp.listOrders(ACCOUNTS.map((a) => Object.assign({ employeeId: 5 }, a)), { from: '2026-11-01', to: '2026-11-30', fetch: fakeFetch(log) });
  assert.deepStrictEqual(r.errors, []);
  const byChannel = {};
  for (const it of r.items) byChannel[it.channel] = (byChannel[it.channel] || 0) + 1;
  assert.deepStrictEqual(byChannel, { Rozetka: 1, 'Пром 1': 1, 'Епіцентр': 1 }); // старі жовтневі/травневі Prom не входять
  const pr = r.items.find((x) => x.channel === 'Пром 1');
  assert.deepStrictEqual({ ttn: pr.ttn, done: pr.done, employeeId: pr.employeeId, date: pr.date }, { ttn: '20451579375457', done: false, employeeId: 5, date: '2026-11-04' });
  assert.strictEqual(r.items.find((x) => x.channel === 'Rozetka').ttn, '20451579802951');
  assert.strictEqual(r.items.find((x) => x.channel === 'Епіцентр').problem, 'ОТМЕНА');
  assert.ok(log.find((u) => u.includes('my.prom.ua')).includes('date_from=2026-11-01'));
  assert.ok(log.find((u) => u.includes('rozetka.com.ua')).includes('created_from=2026-11-01'));
});

test('ключі з Apps Script', () => {
  const script = `
// оставьте пустой массив: const ROZETKA_ACCOUNTS = []; )
const NOVA_POSHTA_ACCOUNTS = [
  { name: 'НП 1', key: 'npkey1' },
  { name: 'НП 2', key: 'ВСТАВЬТЕ_КЛЮЧ' }
];
const PROM_ACCOUNTS = [
  { name: 'Пром 1', token: 'tok1' },
  { name: 'Пром 2', token: 'ВСТАВЬТЕ_ТОКЕН_PROM_2' }
];
const EPICENTER_ACCOUNTS = [
  {
    name: 'Епіцентр',
    token: 'eptok'
  }
];
const ROZETKA_ACCOUNTS = [
  { name: 'Rozetka', token: 'rztok' }
];`;
  assert.deepStrictEqual(mp.parseScriptAccounts(script), [
    { kind: 'np', name: 'НП 1', token: 'npkey1' }, { kind: 'prom', name: 'Пром 1', token: 'tok1' },
    { kind: 'epicentr', name: 'Епіцентр', token: 'eptok' }, { kind: 'rozetka', name: 'Rozetka', token: 'rztok' },
  ]);
  assert.deepStrictEqual(mp.parseScriptAccounts('nothing'), []);
});

test('зведення: пріоритети суми й статусу', () => {
  const npOk = { found: true, received: true, problem: '', npStatus: 'Відправлення отримано', npCode: '9', reason: '', amount: null, dateCreated: '2026-09-01', dateReceived: '2026-09-03', product: '' };
  const npTransit = Object.assign({}, npOk, { received: false, npStatus: 'Прибув на відділення', npCode: '7', amount: 278 });
  const npRefused = Object.assign({}, npOk, { received: false, problem: 'ОТКАЗ', npStatus: 'Відмова від отримання', npCode: '102' });
  const mpRz = { kind: 'rozetka', channel: 'Rozetka', orderId: '1', status: 'Виконано', problem: '', amount: 698, date: '2026-08-30', product: 'Трусики' };

  let c = combine('n', npOk, mpRz, null);
  assert.deepStrictEqual({ status: c.status, amount: c.amount, date: c.date, channel: c.channel, product: c.product }, { status: 'ok', amount: 698, date: '2026-08-30', channel: 'Rozetka', product: 'Трусики' });
  // у дорозі → перевіряється, хоч маркетплейс і знає суму
  c = combine('n', npTransit, mpRz, null);
  assert.deepStrictEqual({ status: c.status, amount: c.amount }, { status: 'checking', amount: 698 });
  // відмова перевізника перебиває «ОК» маркетплейсу
  c = combine('n', npRefused, mpRz, null);
  assert.deepStrictEqual({ status: c.status, problem: c.problem, problemLabel: c.problemLabel }, { status: 'refused', problem: 'ОТКАЗ', problemLabel: 'Нова Пошта' });
  // лише НП із сумою
  c = combine('n', npTransit, null, null);
  assert.deepStrictEqual({ status: c.status, amount: c.amount, amountSource: c.amountSource, date: c.date }, { status: 'checking', amount: 278, amountSource: 'Нова Пошта', date: '2026-09-01' });
  // скасовано на маркетплейсі, НП не знайдено
  c = combine('n', { found: false }, Object.assign({}, mpRz, { problem: 'ОТМЕНА', status: 'Скасовано' }), null);
  assert.deepStrictEqual({ status: c.status, found: c.found }, { status: 'cancelled', found: true });
  // ОТКАЗ важливіший за ОТМЕНА
  c = combine('n', npRefused, Object.assign({}, mpRz, { problem: 'ОТМЕНА' }), null);
  assert.strictEqual(c.problem, 'ОТКАЗ');
  // ніде немає
  c = combine('n', { found: false }, null, null);
  assert.deepStrictEqual({ status: c.status, found: c.found, amount: c.amount }, { status: 'nodata', found: false, amount: null });
  // PRM: лише Rozetka Delivery
  c = combine('PRM-1', null, null, { found: true, status: 'Відмова від одержання', problem: 'ОТКАЗ' });
  assert.deepStrictEqual({ status: c.status, found: c.found }, { status: 'refused', found: true });
  c = combine('PRM-1', null, mpRz, { found: true, status: 'Доставлено', problem: '' });
  assert.strictEqual(c.status, 'ok');
  // перевізник ще везе → перевіряється; без перевізника — за статусом маркетплейсу
  c = combine('PRM-1', null, mpRz, { found: true, status: 'Прямує до відділення', problem: '' });
  assert.strictEqual(c.status, 'checking');
  c = combine('RMP-1', null, mpRz, { found: true, status: 'Видано', code: 60030, problem: '' });
  assert.strictEqual(c.status, 'ok');
  c = combine('n', null, Object.assign({}, mpRz, { done: false }), null);
  assert.strictEqual(c.status, 'checking');
  c = combine('n', null, Object.assign({}, mpRz, { done: true }), null);
  assert.strictEqual(c.status, 'ok');
});
