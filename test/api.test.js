'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Service } = require('../src/service');
const { createApi } = require('../src/api');

async function setup(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-api-'));
  const store = new Store(dir);
  const service = new Service(store);
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

    r = await t.call('GET', '/api/salary?period=2026-11');
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
    r = await t.call('GET', '/api/salary');
    assert.strictEqual(r.body.rows.find((x) => x.name === 'Товкес').salary, 14.93); // 199 × 7,5 %

    r = await t.call('GET', '/api/data');
    const backup = r.body;
    assert.strictEqual(backup.orders.length, 2);
    backup.orders.push({ employeeId: backup.employees[0].id, number: 'Z', amount: 10, status: 'ok', date: '2026-10-01' });
    r = await t.call('PUT', '/api/data', backup);
    assert.deepStrictEqual(r.body, { employees: 6, orders: 3 });
    r = await t.call('PUT', '/api/data', { foo: 1 });
    assert.strictEqual(r.status, 400);
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
