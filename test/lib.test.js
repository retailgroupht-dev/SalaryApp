'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const lib = require('../src/lib');

test('parseCsv: лапки, коми, переноси', () => {
  const rows = lib.parseCsv('a,"b,c","d ""e""",f\r\n1,2,3\n');
  assert.deepStrictEqual(rows, [['a', 'b,c', 'd "e"', 'f'], ['1', '2', '3']]);
});

test('sheetExportUrl', () => {
  assert.strictEqual(
    lib.sheetExportUrl('https://docs.google.com/spreadsheets/d/ABC_123/edit?usp=sharing#gid=77'),
    'https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=77');
  assert.strictEqual(lib.sheetExportUrl('https://example.com'), null);
});

test('mapSheetRow: звичайне замовлення Rozetka', () => {
  // A B C D E F G H I J K L M N O P Q R S T
  const cols = ['', 'чохол (XJ3277)', '20451522420002', '199', '', '', '', 'Замовлення виконано', '199',
    'Заказ Prom.ua не найден', '0', 'Заказ Епіцентр не найден', '0', '', '', '', 'Rozetka', '', '', 'ОК'];
  const o = lib.mapSheetRow(cols, { employeeId: 5, date: '2026-11-05' });
  assert.deepStrictEqual(o, {
    employeeId: 5, product: 'чохол (XJ3277)', number: '20451522420002', amount: 199,
    channel: 'Rozetka', status: 'ok', date: '2026-11-05',
  });
});

test('mapSheetRow: ОТКАЗ бере суму з Prom, статус відмова', () => {
  const cols = ['', 'сухпай 14шт', '20451522315648', 'ОТКАЗ', '', 'ОТКАЗ — Відмова від отримання', '5600',
    'Проверяется...', '0', 'Выполнен', '5600', 'Заказ Епіцентр не найден', '0', '', '', '', '', 'Пром 2', '', 'ОТКАЗ (Новая почта)'];
  const o = lib.mapSheetRow(cols, { employeeId: 1, date: '2026-11-05' });
  assert.strictEqual(o.status, 'refused');
  assert.strictEqual(o.amount, 5600);
  assert.strictEqual(o.channel, 'Пром 2');
});

test('mapSheetRow: порожній рядок пропускається, НЕТ ДАННЫХ -> nodata', () => {
  assert.strictEqual(lib.mapSheetRow(['', '', '', '', '', '', '', 'Проверяется...'], { employeeId: 1 }), null);
  const o = lib.mapSheetRow(['', 'компас', '1', 'НЕТ ДАННЫХ', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Заказ не найден ни в одном канале'], { employeeId: 1, date: '2026-11-05' });
  assert.strictEqual(o.status, 'nodata');
  assert.strictEqual(o.amount, 0);
});

test('mapSheetRow: аркуш «номер + сума» (Лист 1 мама)', () => {
  assert.strictEqual(lib.mapSheetRow(['c', '1200'], { employeeId: 2 }), null);
  const o = lib.mapSheetRow(['20451478799868', '247'], { employeeId: 2, date: '2026-11-05' });
  assert.deepStrictEqual(o, { employeeId: 2, product: '', number: '20451478799868', amount: 247, channel: '', status: 'ok', date: '2026-11-05' });
  const r = lib.mapSheetRow([' 201610116718 розетка', '350', '', ''], { employeeId: 2, date: '2026-11-05', defaultStatus: 'checking' });
  assert.strictEqual(r.number, '201610116718');
  assert.strictEqual(r.channel, 'Rozetka');
  assert.strictEqual(r.status, 'checking');
});

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
