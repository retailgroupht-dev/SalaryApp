'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const lib = require('../src/lib');

test('splitPasted: буфер Google Таблиць — клітинка з переносами в лапках, самотній \\r, лапка в тексті', () => {
  // живий вигляд (аркуш пакування, 2026-11-18): адреса замість ТТН на кілька рядків, \r у кінці назви товару
  const text = 'аптечка\t"Ужгород\nНова пошта\nВідділення 1\n0500000000"\tТовкес\r\n'
    + 'мультитул \r\t20451562644714\tНастя \n'
    + '"лупа ""велика""\n2шт"\tPRM-661772917\tНастя\n'
    + '"щітка" для бутлів\t20451520852070\n'
    + '\t\t\n'
    + 'останній\t723-5328470';
  assert.deepStrictEqual(lib.splitPasted(text), [
    ['аптечка', 'Ужгород\nНова пошта\nВідділення 1\n0500000000', 'Товкес'],
    ['мультитул \r', '20451562644714', 'Настя '],
    ['лупа "велика"\n2шт', 'PRM-661772917', 'Настя'],
    ['"щітка" для бутлів', '20451520852070'],
    ['', '', ''],
    ['останній', '723-5328470'],
  ]);
  assert.deepStrictEqual(lib.splitPasted(''), [['']]);
});

test('htmlTable: живий буфер Google Таблиць (text/html) — клітинка = клітинка, <br> усередині клітинки', () => {
  const fx = (name) => require('fs').readFileSync(require('path').join(__dirname, 'fixtures', name), 'utf8');
  const grid = lib.htmlTable(fx('sheets-clipboard.html'));
  assert.deepStrictEqual(grid.map((r) => r.length), [3, 3, 3, 3]);
  assert.deepStrictEqual(grid[0], ['аптечка олива', '20451520852070', 'Товкес']);
  assert.strictEqual(grid[2][1], 'Вітаю\nВідправте, будь ласка\nКиїв НП 1\nТОВ «Приклад» ЄДРПОУ: 00000000\nІваненко Іван\n0500000000\nОплата безготівкова\nпокладіть оригінали документів, будь ласка');
  assert.deepStrictEqual(grid[3], ['самоклеючі шпалери ламелі сірі', '20451521500117', 'Настя']);
  // text/plain того самого буфера дає ту саму сітку (усередині клітинки там \r\n, між рядками \n)
  const fromText = lib.splitPasted(fx('sheets-clipboard.tsv')).map((r) => r.map((c) => c.replace(/\r/g, '').trim()));
  assert.deepStrictEqual(fromText, grid);
  // colspan/rowspan: значення у верхній лівій клітинці, колонки не зсуваються; сутності; th; атрибути без лапок (Excel)
  assert.deepStrictEqual(lib.htmlTable('<html><body><!--StartFragment--><table border=0><col width=87><tr height=20><td colspan=2 rowspan="2" class=xl65>A &amp; B</td><td>c</td></tr><tr><td>d&nbsp;e<br>f</td></tr><tr><th>x</th><td></td><td>&#1040;&#x42f; &lt;b&gt;</td></tr></table><!--EndFragment--></body></html>'),
    [['A & B', '', 'c'], ['', '', 'd e\nf'], ['x', '', 'АЯ <b>']]);
  // «>» усередині значення атрибута тег не закриває (так виглядає клітинка з data-sheets-value у режимі редагування)
  assert.deepStrictEqual(lib.htmlTable('<table><tr><td data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;набір >10шт&quot;}" style=\'x:"a>b"\'><span title="1>0">набір &gt;10шт</span></td><td>2045</td></tr></table>'), [['набір >10шт', '2045']]);
  // одна клітинка приходить без <table>, порожній html — працює розбір тексту
  assert.strictEqual(lib.htmlTable('<span data-sheets-value="{}">20451520852070</span>'), null);
  assert.strictEqual(lib.htmlTable(''), null);
  assert.strictEqual(lib.htmlTable('<table></table>'), null);
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

test('sheetDate: дата пакування з клітинки таблиці', () => {
  const nov = new Date(2026, 10, 19), jan = new Date(2027, 0, 5);
  assert.strictEqual(lib.sheetDate('5.10', nov), '2026-10-05');
  assert.strictEqual(lib.sheetDate('13/10', nov), '2026-10-13');
  assert.strictEqual(lib.sheetDate('01.11', nov), '2026-11-01');
  assert.strictEqual(lib.sheetDate('28.12', jan), '2026-12-28'); // у січні грудень — минулого року
  assert.strictEqual(lib.sheetDate('5.10.2025', nov), '2025-10-05');
  assert.strictEqual(lib.sheetDate('32.10', nov), '');
  assert.strictEqual(lib.sheetDate('723-5328470', nov), '');
  assert.strictEqual(lib.orderMonth({ month: '2026-10', date: '2026-11-01' }), '2026-10');
  assert.strictEqual(lib.orderMonth({ month: '', date: '2026-11-01' }), '2026-11');
});

test('порядок у списку за кольором: зелені (за працівником) → жовті → сірі → червоні', () => {
  const names = { 1: 'Товкес', 2: 'Настя' };
  const o = (id, employeeId, status, track, extra) => Object.assign({ id, employeeId, status, date: '2026-10-0' + (id % 9 + 1), track }, extra || {});
  const list = [
    o(1, 1, 'checking', { np: { code: '7' } }),
    o(2, 2, 'nodata', { np: { code: '1' } }), // не відправлено
    o(3, 1, 'refused', { problem: 'ВОЗВРАТ' }),
    o(4, 1, 'ok', null),
    o(5, 2, 'cancelled', null),
    o(6, null, 'nodata', null, { invalid: 'немає ні номера, ні працівника' }),
    o(7, 2, 'refused', { problem: 'ОТКАЗ' }),
    o(8, 2, 'nodata', { np: { code: '3' } }),
    o(9, 2, 'ok', null),
  ];
  // виконано Насті, Товкес → немає даних → не відправлено → неправильний → у дорозі → відмова → повернення → скасовано
  assert.deepStrictEqual(list.sort(lib.orderCompare((id) => names[id])).map((x) => x.id), [9, 4, 8, 2, 6, 1, 7, 3, 5]);
});
