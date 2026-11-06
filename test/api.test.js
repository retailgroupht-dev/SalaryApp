'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Service } = require('../src/service');
const { createApi } = require('../src/api');

// Підроблена Нова Пошта: словник номер → документ; усе інше — «Номер не знайдено».
const NP_DOCS = {
  20451520852070: { StatusCode: '9', Status: 'Відправлення отримано', DateCreated: '01-09-2026 10:54:36', RecipientDateTime: '03.09.2026 11:40:39', RedeliverySum: '278', CargoDescriptionString: 'щітка' },
  20451535524936: { StatusCode: '102', Status: 'Відмова від отримання', DateCreated: '14-09-2026 14:36:11', UndeliveryReasonsSubtypeDescription: 'Одержувач не з\'явився до відділення' },
  20451521500117: { StatusCode: '7', Status: 'Прибув на відділення', DateCreated: '01-11-2026 11:12:06' },
};
async function fakeNpFetch(url, init) {
  if (!url.includes('novaposhta')) {
    // маркетплейси: лише Prom з одним замовленням на ТТН 20451520852070
    const j = (b) => ({ status: 200, ok: true, text: async () => JSON.stringify(b), json: async () => b });
    if (url.includes('my.prom.ua')) return j({ orders: new URL(url).searchParams.get('last_id') ? [] : [{ id: 777, date_created: '2026-08-30T10:00:00+00:00', status: 'delivered', status_name: 'Виконано', price: '300 грн', delivery_provider_data: { declaration_number: '20451520852070' }, products: [{ name: 'щітка з Prom' }] }] });
    return j({ success: true, content: { orders: [], _meta: { pageCount: 1 } }, items: [] });
  }
  const body = JSON.parse(init.body);
  const data = body.methodProperties.Documents.map((d) => Object.assign({ Number: d.DocumentNumber, StatusCode: '3', Status: 'Номер не знайдено' }, NP_DOCS[d.DocumentNumber] || {}));
  return { ok: true, json: async () => ({ success: true, data, errors: [] }) };
}

async function setup(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-api-'));
  const store = new Store(dir);
  const service = new Service(store, { fetch: fakeNpFetch });
  store.data.settings.api.token = token || '';
  const api = createApi(service, { version: '0.0.0-test' });
  const st = await api.apply({ enabled: true, host: '127.0.0.1', port: 0 });
  assert.ok(st.running, st.error);
  const base = st.url;
  const call = async (method, p, body, headers) => {
    const res = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body == null ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  return { api, service, store, base, call, cleanup: async () => { await api.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('API: health, працівники, замовлення, зарплата, експорт', async () => {
  const t = await setup();
  try {
    let r = await t.call('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.employees, 6);

    r = await t.call('POST', '/api/employees', { name: 'Тест', ratePercent: 10 });
    assert.strictEqual(r.status, 201);
    const testId = r.body.id;

    r = await t.call('POST', '/api/orders', [
      { employee: 'Настя', number: 'A1', amount: 1000, status: 'ok', date: '2026-11-03', channel: 'Rozetka' },
      { employee: 'настя', number: 'A2', amount: 500, status: 'refused', date: '2026-11-04' },
      { employeeId: testId, number: 'B1', amount: 200, status: 'ok', date: '2026-11-05' },
    ]);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ added: r.body.added, updated: r.body.updated }, { added: 3, updated: 0 });

    // повторний пакет із тим самим номером оновлює статус, а не дублює
    r = await t.call('POST', '/api/orders', { employee: 'Настя', number: 'A2', amount: 500, status: 'ok' });
    assert.deepStrictEqual({ added: r.body.added, updated: r.body.updated }, { added: 0, updated: 1 });

    r = await t.call('GET', '/api/orders?employee=Настя&period=2026-11');
    assert.strictEqual(r.body.length, 2);
    r = await t.call('GET', '/api/orders?status=ok&q=b1');
    assert.strictEqual(r.body.length, 1);
    // кирилиця в адресі, закодована (fetch кодує сам; у curl — -G --data-urlencode)
    r = await t.call('GET', '/api/orders?employee=' + encodeURIComponent('настя') + '&period=2026-11');
    assert.strictEqual(r.body.length, 2);

    r = await t.call('GET', '/api/salary?period=2026-11'); // типовий набір — auto, а записи з API потрапляють у manual
    assert.deepStrictEqual({ source: r.body.source, salary: r.body.totals.salary }, { source: 'auto', salary: 0 });
    r = await t.call('GET', '/api/salary?period=2026-11&source=manual');
    const nastya = r.body.rows.find((x) => x.name === 'Настя');
    assert.strictEqual(nastya.salary, 75); // (1000 + 500) × 5 %
    assert.strictEqual(r.body.rows.find((x) => x.name === 'Тест').salary, 20); // 200 × 10 %
    assert.strictEqual(r.body.totals.salary, 95);
    r = await t.call('GET', '/api/salary?period=11-2026');
    assert.strictEqual(r.status, 400);

    r = await t.call('GET', '/api/export?format=xlsx&period=2026-11');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.readUInt32LE(0), 0x04034b50);
    assert.ok(r.headers.get('content-disposition').includes('attachment'));
    r = await t.call('GET', '/api/export?format=csv');
    assert.ok(r.body.toString('utf8').includes('Настя'));

    r = await t.call('DELETE', `/api/orders/${t.service.data.orders[0].id}`);
    assert.strictEqual(r.body.deleted, 1);
    r = await t.call('DELETE', `/api/employees/${testId}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(t.service.data.orders.some((o) => o.employeeId === testId), false);

    r = await t.call('GET', '/api/docs');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('content-type').includes('text/markdown'));
    assert.ok(r.body.toString('utf8').includes('## Маршрути'));
    assert.ok(r.body.toString('utf8').includes(t.base)); // адреса з запиту підставляється у приклади
    r = await t.call('GET', '/api/docs?download=1');
    assert.ok(r.headers.get('content-disposition').includes('attachment'));

    r = await t.call('POST', '/api/orders', { employee: 'Невідомий', number: 'X', amount: 1 });
    assert.strictEqual(r.status, 400);
    r = await t.call('GET', '/api/nope');
    assert.strictEqual(r.status, 404);
  } finally { await t.cleanup(); }
});

test('API: імпорт CSV, резервна копія, ставка', async () => {
  const t = await setup();
  try {
    const csv = ',чохол,20451522420002,199,,,,Замовлення виконано,199,Заказ Prom.ua не найден,0,Заказ Епіцентр не найден,0,,,,Rozetka,,,ОК\n,компас,20451522420003,ОТКАЗ,,,,,,Выполнен,300,,,,,,,Пром 1,,ОТКАЗ (Новая почта)\n';
    let r = await t.call('POST', '/api/import', { employee: 'Товкес', csv, date: '2026-11-05' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ parsed: r.body.parsed, added: r.body.added }, { parsed: 2, added: 2 });
    r = await t.call('POST', '/api/import', { employee: 'Товкес' });
    assert.strictEqual(r.status, 400);

    r = await t.call('PUT', '/api/settings', { ratePercent: 7.5 });
    assert.strictEqual(r.body.ratePercent, 7.5);
    r = await t.call('PUT', '/api/settings', { salarySource: 'manual' });
    assert.strictEqual(r.body.salarySource, 'manual');
    r = await t.call('GET', '/api/salary');
    assert.strictEqual(r.body.rows.find((x) => x.name === 'Товкес').salary, 14.93); // 199 × 7,5 %

    r = await t.call('GET', '/api/data');
    const backup = r.body;
    assert.strictEqual(backup.orders.length, 2);
    backup.orders.push({ employeeId: backup.employees[0].id, number: 'Z', amount: 10, status: 'ok', date: '2026-10-01' });
    backup.settings.accounts = [{ kind: 'prom', name: 'Пром 1', token: 'p' }, { kind: 'bad', token: 'x' }];
    backup.settings.api = { port: 1 }; // налаштування API з копії не переносяться
    r = await t.call('PUT', '/api/data', backup);
    assert.deepStrictEqual(r.body, { employees: 6, orders: 3 });
    assert.deepStrictEqual(t.service.data.settings.accounts, [{ kind: 'prom', name: 'Пром 1', token: 'p', employeeId: null }]);
    assert.strictEqual(t.service.data.settings.api.port, 8765);
    r = await t.call('PUT', '/api/data', { foo: 1 });
    assert.strictEqual(r.status, 400);
  } finally { await t.cleanup(); }
});

test('API: Нова Пошта — додати за ТТН, оновити, подивитися', async () => {
  const t = await setup();
  try {
    // без кабінетів — лише Нова Пошта без ключа
    let r = await t.call('GET', '/api/track?numbers=20451520852070,PRM-1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ status: r.body.results[0].status, amount: r.body.results[0].amount, date: r.body.results[0].date }, { status: 'ok', amount: 278, date: '2026-09-01' });
    assert.deepStrictEqual({ number: r.body.results[1].number, found: r.body.results[1].found, status: r.body.results[1].status }, { number: 'PRM-1', found: false, status: 'nodata' });

    // з кабінетом Prom — сума, дата, канал і товар з маркетплейсу (пріоритет над НП)
    r = await t.call('PUT', '/api/settings', { accounts: [{ kind: 'prom', name: 'Пром 1', token: 'p' }, { kind: 'prom', name: 'Пром 1', token: 'p2' }, { kind: 'bad', name: 'x', token: 'y' }] });
    assert.deepStrictEqual(r.body.accounts.map((a) => a.name), ['Пром 1', 'Пром 1 (2)']);
    r = await t.call('POST', '/api/track', { employee: 'Настя', numbers: '20451520852070 20451535524936, 20451521500117 20459999999999' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ added: r.body.added, updated: r.body.updated, notFound: r.body.notFound, noAmount: r.body.noAmount, errors: r.body.errors },
      { added: 3, updated: 0, notFound: ['20459999999999'], noAmount: ['20451535524936', '20451521500117'], errors: [] });
    const o = t.service.data.orders.find((x) => x.number === '20451520852070');
    assert.deepStrictEqual({ status: o.status, amount: o.amount, date: o.date, product: o.product, channel: o.channel, np: o.track.np.status, mp: o.track.mp.channel },
      { status: 'ok', amount: 300, date: '2026-08-30', product: 'щітка з Prom', channel: 'Пром 1', np: 'Відправлення отримано', mp: 'Пром 1' });
    assert.strictEqual(t.service.data.orders.find((x) => x.number === '20451535524936').status, 'refused');
    r = await t.call('GET', '/api/salary?period=2026-08&source=manual');
    assert.strictEqual(r.body.rows.find((x) => x.name === 'Настя').salary, 15); // 300 × 5 %

    // повторне додавання не дублює
    r = await t.call('POST', '/api/track', { employee: 'Настя', numbers: ['20451520852070'] });
    assert.deepStrictEqual({ added: r.body.added, updated: r.body.updated }, { added: 0, updated: 0 });
    assert.strictEqual(t.service.data.orders.length, 3);

    // замовлення «в дорозі» отримали → refresh змінює статус; дата змінюється лише з withDate
    const inTransit = t.service.data.orders.find((x) => x.number === '20451521500117');
    inTransit.date = '2026-11-05';
    NP_DOCS[20451521500117].StatusCode = '9';
    r = await t.call('POST', '/api/track/refresh', { status: 'checking' });
    assert.deepStrictEqual({ checked: r.body.checked, updated: r.body.updated }, { checked: 1, updated: 1 });
    assert.strictEqual(r.body.changes[0].to.status, 'ok');
    assert.strictEqual(inTransit.date, '2026-11-05');
    r = await t.call('POST', '/api/track/refresh', { ids: [inTransit.id], withDate: true });
    assert.strictEqual(inTransit.date, '2026-11-01');

    // ручна правка через форму (upsert) зберігає блок track
    r = await t.call('POST', '/api/orders', [Object.assign({}, o, { amount: 350 })]);
    assert.strictEqual(t.service.data.orders.find((x) => x.id === o.id).track.np.code, '9');

    // імпорт ключів зі скрипта й перевірка кабінетів
    r = await t.call('POST', '/api/settings/accounts/import', { script: "const ROZETKA_ACCOUNTS = [\n  { name: 'Rozetka', token: 'rz' }\n];" });
    assert.deepStrictEqual({ parsed: r.body.parsed, added: r.body.added }, { parsed: 1, added: 1 });
    r = await t.call('POST', '/api/settings/accounts/import', { script: 'nothing' });
    assert.strictEqual(r.status, 400);
    r = await t.call('GET', '/api/settings/accounts/test');
    assert.strictEqual(r.body.length, 3);
    assert.ok(r.body.every((x) => x.ok), JSON.stringify(r.body));
    r = await t.call('POST', '/api/track', { employee: 'Хтось', numbers: ['20451520852070'] });
    assert.strictEqual(r.status, 400);
  } finally { await t.cleanup(); }
});

test('API: вставка з таблиці, відправлення з кабінетів, кабінети працівника', async () => {
  const t = await setup();
  try {
    // кабінет Prom належить Насті; у Товкеса кабінетів немає → його номери шукаються лише в НП
    let r = await t.call('PUT', '/api/settings', { accounts: [{ kind: 'prom', name: 'Пром Насті', token: 'p', employeeId: t.service.resolveEmployee('Настя').id }] });
    assert.strictEqual(r.body.accounts[0].employeeId, t.service.resolveEmployee('Настя').id);

    r = await t.call('POST', '/api/import/paste', { text: 'щітка\t20451520852070\tНастя\nкомпас\t20451520852070\tТовкес\nбез номера\t\tНастя\nщось\t20451535524936\tНевідомий\n' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual({ parsed: r.body.parsed, added: r.body.added, unknownReasons: r.body.unknown.map((u) => u.reason) }, { parsed: 2, added: 2, unknownReasons: ['немає номера ТТН', 'не впізнано працівника (виберіть працівника для рядків без імені)'] });
    const nastya = t.service.data.orders.find((o) => o.employeeId === t.service.resolveEmployee('Настя').id);
    const tovkes = t.service.data.orders.find((o) => o.employeeId === t.service.resolveEmployee('Товкес').id);
    assert.deepStrictEqual({ product: nastya.product, amount: nastya.amount, channel: nastya.channel, date: nastya.date }, { product: 'щітка', amount: 300, channel: 'Пром Насті', date: '2026-08-30' });
    assert.deepStrictEqual({ product: tovkes.product, amount: tovkes.amount, channel: tovkes.channel, date: tovkes.date }, { product: 'компас', amount: 278, channel: '', date: '2026-09-01' }); // лише НП
    // порядок колонок неважливий
    r = await t.call('POST', '/api/import/paste', { text: 'Настя\t20451521500117\tпончо' });
    assert.strictEqual(r.body.added, 1);
    // лише дві колонки (товар і ТТН) — працівник з параметра; ім’я в рядку має перевагу
    r = await t.call('POST', '/api/import/paste', { text: 'шпалери\t20451521500117\nщітка\t20451520852070\tТовкес', employee: 'Настя' });
    assert.deepStrictEqual({ parsed: r.body.parsed, updated: r.body.updated, unknown: r.body.unknown.length }, { parsed: 2, updated: 0, unknown: 0 });

    // вставлені рядки — набір manual; відправлення з кабінетів — набір auto, набори не змішуються
    assert.strictEqual(nastya.source, 'manual');
    nastya.number = '20451520852070 723-1'; // номер із доважком, як у таблиці
    r = await t.call('GET', '/api/shipments?employee=Настя&period=2026-08');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 1);
    const it = r.body.items[0];
    assert.deepStrictEqual({ number: it.number, channel: it.channel, amount: it.amount, status: it.status, inBase: it.inBase }, { number: '20451520852070', channel: 'Пром Насті', amount: 300, status: 'ok', inBase: null });
    r = await t.call('GET', '/api/shipments?employee=Товкес&period=2026-08');
    assert.strictEqual(r.body.items.length, 0);
    r = await t.call('GET', '/api/shipments?period=2026-13');
    assert.strictEqual(r.status, 400);
    r = await t.call('POST', '/api/shipments/add', { employee: 'Настя', period: '2026-08' });
    assert.deepStrictEqual({ collected: r.body.collected, added: r.body.added, updated: r.body.updated }, { collected: 1, added: 1, updated: 0 });
    const autoOne = t.service.data.orders.find((o) => o.source === 'auto');
    assert.deepStrictEqual({ number: autoOne.number, orderId: autoOne.orderId, kind: autoOne.kind, separate: autoOne.id !== nastya.id && nastya.source === 'manual' }, { number: '20451520852070', orderId: '777', kind: 'prom', separate: true });
    r = await t.call('GET', '/api/orders?source=auto');
    assert.strictEqual(r.body.length, 1);
    // список набору файлом
    r = await t.call('GET', '/api/orders?source=manual&format=csv');
    assert.ok(r.headers.get('content-disposition').includes('attachment') && r.body.toString('utf8').includes('Дата,Працівник,Товар,ТТН,№ замовлення'));
    r = await t.call('GET', '/api/orders?source=auto&format=xlsx');
    assert.strictEqual(r.body.readUInt32LE(0), 0x04034b50);
    // імпорт аркуша в manual: новий рядок бере дату з авто-набору, якщо програма знає цей ТТН
    r = await t.call('POST', '/api/import', { employee: 'Настя', csv: ',ліхтар,20451520852070,500,,,,Замовлення виконано,500,,,,,,,,Rozetka,,,ОК\n', date: '2026-11-05' });
    assert.strictEqual(r.body.added, 1);
    const imported = t.service.data.orders.find((o) => o.source === 'manual' && o.employeeId === nastya.employeeId && o.number === '20451520852070');
    assert.strictEqual(imported.date, '2026-08-30');

    // замовлення без ТТН: номер порожній, є лише № замовлення; коли ТТН з'явиться — те саме замовлення, не дубль
    let a = t.service.addShipments([{ employeeId: nastya.employeeId, number: '', orderId: '555', kind: 'rozetka', channel: 'Rozetka', product: 'ліхтар', amount: 100, date: '2026-08-02', status: 'checking' }]);
    assert.deepStrictEqual(a, { added: 1, updated: 0 });
    const noTtn = t.service.data.orders.find((o) => o.orderId === '555');
    assert.deepStrictEqual({ number: noTtn.number, kind: noTtn.kind, status: noTtn.status }, { number: '', kind: 'rozetka', status: 'checking' });
    a = t.service.addShipments([{ employeeId: nastya.employeeId, number: '20451521500999', orderId: '555', kind: 'rozetka', channel: 'Rozetka', product: 'ліхтар', amount: 100, date: '2026-08-02', status: 'ok' }]);
    assert.deepStrictEqual(a, { added: 0, updated: 1 });
    assert.deepStrictEqual({ number: noTtn.number, status: noTtn.status, count: t.service.data.orders.filter((o) => o.orderId === '555').length }, { number: '20451521500999', status: 'ok', count: 1 });
    r = await t.call('GET', '/api/orders?q=555');
    assert.strictEqual(r.body.length, 1); // пошук і за № замовлення
    // стара база: «prom-123» → порожній ТТН + № замовлення; запис без ТТН, що дублює запис із ТТН, прибирається
    t.service.data.orders.push({ id: 9001, employeeId: nastya.employeeId, number: 'prom-123', amount: 1, status: 'cancelled', date: '2026-08-03', channel: '' },
      { id: 9002, employeeId: nastya.employeeId, number: 'rozetka-555', amount: 1, status: 'checking', date: '2026-08-03', channel: '' });
    assert.strictEqual(t.service.migrateNumbers(), 1);
    const old = t.service.data.orders.find((o) => o.id === 9001);
    assert.deepStrictEqual({ number: old.number, orderId: old.orderId, kind: old.kind, dup: t.service.data.orders.some((o) => o.id === 9002) }, { number: '', orderId: '123', kind: 'prom', dup: false });

    // автоматичне оновлення: поточний і попередній місяць (у підробці Prom замовлення серпневе → нічого нового), статус у налаштуваннях
    r = await t.call('PUT', '/api/settings', { auto: { enabled: false, hours: 5 } });
    assert.deepStrictEqual({ enabled: r.body.auto.enabled, hours: r.body.auto.hours }, { enabled: false, hours: 6 });
    r = await t.call('POST', '/api/sync');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.months.length, 2);
    assert.deepStrictEqual({ added: r.body.added, errors: r.body.errors }, { added: 0, errors: [] });
    assert.match(t.service.data.settings.auto.lastResult, /зібрано 0/);

    // імпорт ключів зі скрипта для працівника; той самий ключ у другого → спільний
    r = await t.call('POST', '/api/settings/accounts/import', { script: "const ROZETKA_ACCOUNTS = [\n  { name: 'Rozetka', token: 'rz' }\n];\nconst PROM_ACCOUNTS = [\n  { name: 'Пром 1', token: 'pa' },\n  { name: 'Пром 2', token: 'pb' }\n];", employee: 'Настя' });
    assert.strictEqual(r.body.accounts.find((a) => a.kind === 'rozetka').employeeId, t.service.resolveEmployee('Настя').id);
    assert.deepStrictEqual(r.body.accounts.filter((a) => a.employeeId).map((a) => a.name), ['Пром Насті', 'Prom.ua Настя 1', 'Prom.ua Настя 2', 'Rozetka Настя']);
    // перейменування кабінету перейменовує канал у замовленнях
    const accs = r.body.accounts.map((a) => (a.name === 'Пром Насті' ? Object.assign({}, a, { name: 'Пром Анастасія' }) : a));
    r = await t.call('PUT', '/api/settings', { accounts: accs });
    assert.strictEqual(t.service.data.orders.find((o) => o.id === nastya.id).channel, 'Пром Анастасія');
    r = await t.call('POST', '/api/settings/accounts/import', { script: "const ROZETKA_ACCOUNTS = [\n  { name: 'Rozetka', token: 'rz' }\n];", employee: 'Товкес' });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.accounts.find((a) => a.kind === 'rozetka').employeeId, null);
  } finally { await t.cleanup(); }
});

test('API: ключ доступу', async () => {
  const t = await setup('secret-1');
  try {
    let r = await t.call('GET', '/api/health');
    assert.strictEqual(r.status, 401);
    r = await t.call('GET', '/api/health', null, { Authorization: 'Bearer secret-1' });
    assert.strictEqual(r.status, 200);
    r = await t.call('GET', '/api/health', null, { 'X-Api-Key': 'secret-1' });
    assert.strictEqual(r.status, 200);
    r = await t.call('GET', '/api/health?key=secret-1');
    assert.strictEqual(r.status, 200);
    r = await t.call('GET', '/api/health?key=wrong');
    assert.strictEqual(r.status, 401);
  } finally { await t.cleanup(); }
});

test('API: зайнятий порт дає зрозумілу помилку, apply вимикає', async () => {
  const t = await setup();
  try {
    const t2 = await (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-api2-'));
      const api = createApi(new Service(new Store(dir)), { version: 'x' });
      const st = await api.apply({ enabled: true, host: '127.0.0.1', port: Number(t.base.split(':').pop()) });
      return { st, api, dir };
    })();
    assert.strictEqual(t2.st.running, false);
    assert.match(t2.st.error, /зайнятий/);
    const off = await t.api.apply({ enabled: false });
    assert.strictEqual(off.running, false);
    fs.rmSync(t2.dir, { recursive: true, force: true });
  } finally { await t.cleanup(); }
});
