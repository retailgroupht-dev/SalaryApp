'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const lib = require('../src/lib');

test('mergeOrders: дублікати за номером оновлюються, нові додаються', () => {
  let id = 1;
  const existing = [{ id: 1, employeeId: 1, number: 'A', amount: 100, status: 'checking', channel: '', date: '2026-10-01' }];
  const incoming = [
    { employeeId: 1, number: 'A', amount: 100, status: 'ok', channel: 'Пром 1', date: '2026-11-05' },
    { employeeId: 1, number: 'B', amount: 50, status: 'ok', channel: '', date: '2026-11-05' },
  ];
  const r = lib.mergeOrders(existing, incoming, () => ++id);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(r.orders.length, 2);
  assert.strictEqual(r.orders[0].status, 'ok');
  assert.strictEqual(r.orders[0].date, '2026-10-01');
});

test('calcSalary: 5% від виконаних, період по місяцю, індивідуальна ставка', () => {
  const data = {
    settings: { ratePercent: 5 },
    employees: [{ id: 1, name: 'Настя', ratePercent: null }, { id: 2, name: 'Товкес', ratePercent: 7 }],
    orders: [
      { id: 1, employeeId: 1, amount: 1000, status: 'ok', date: '2026-11-01' },
      { id: 2, employeeId: 1, amount: 500, status: 'refused', date: '2026-11-02' },
      { id: 3, employeeId: 1, amount: 200, status: 'ok', date: '2026-10-30' },
      { id: 4, employeeId: 2, amount: 100.5, status: 'ok', date: '2026-11-03' },
    ],
  };
  const rows = lib.calcSalary(data, '2026-11');
  assert.strictEqual(rows[0].sumDone, 1000);
  assert.strictEqual(rows[0].salary, 50);
  assert.strictEqual(rows[0].refused, 1);
  assert.strictEqual(rows[0].total, 2);
  assert.strictEqual(rows[1].salary, 7.04);
  const all = lib.calcSalary(data, '');
  assert.strictEqual(all[0].sumDone, 1200);
});

test('statusDetail: перевізник важливіший за кабінет, помилки трекінгу не затуляють статус кабінету', () => {
  assert.strictEqual(lib.statusDetail(null), '');
  assert.strictEqual(lib.statusDetail({ np: { status: 'Відправник самостійно створив цю накладну, але ще не надав до відправки', code: '1' }, mp: { channel: 'Пром 1', status: 'Принят' } }), 'Нова Пошта: Створено, ще не відправлено');
  assert.strictEqual(lib.statusDetail({ np: { status: 'Відправлення отримано', code: '9', received: '2026-08-30' }, mp: null }), 'Нова Пошта: Відправлення отримано (2026-08-30)');
  assert.strictEqual(lib.statusDetail({ np: null, rd: { status: 'HTTP 429' }, mp: { channel: 'Rozetka', status: 'Не прийшов за замовленням' } }), 'Rozetka: Не прийшов за замовленням');
  assert.strictEqual(lib.statusDetail({ np: null, rd: { status: 'Видано', code: 60030, date: '2026-10-22' }, mp: { channel: 'Rozetka', status: 'Виконано' } }), 'Rozetka Delivery: Видано (2026-10-22)');
  assert.strictEqual(lib.statusDetail({ np: { status: 'Номер не знайдено', code: '3' }, mp: null, rd: null }), 'Нова Пошта: Номер не знайдено');
});

test('buildXlsx: коректний zip, читається sheet1.xml', () => {
  const buf = lib.buildXlsx([{ name: 'Зарплата', rows: [['Працівник', 'Сума'], ['Настя', 50.5]] }]);
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
  // кінець центрального каталогу
  assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  // перший запис — [Content_Types].xml: перевіримо розпакування
  const nameLen = buf.readUInt16LE(26), compLen = buf.readUInt32LE(18), crc = buf.readUInt32LE(14);
  const comp = buf.subarray(30 + nameLen, 30 + nameLen + compLen);
  const raw = zlib.inflateRawSync(comp);
  assert.ok(raw.toString().includes('<Types'));
  assert.strictEqual(lib.crc32(raw), crc);
  assert.ok(buf.toString('latin1').includes('xl/worksheets/sheet1.xml'));
});
