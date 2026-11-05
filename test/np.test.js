'use strict';
const test = require('node:test');
const assert = require('node:assert');
const np = require('../src/np');

// Підроблена відповідь Нової Пошти: словник номер → документ.
function fakeFetch(docs, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (calls) calls.push(body);
    const data = body.methodProperties.Documents.map((d) => Object.assign({ Number: d.DocumentNumber, StatusCode: '3', Status: 'Номер не знайдено' }, docs[d.DocumentNumber] || {}));
    return { ok: true, json: async () => ({ success: true, data, errors: [], warnings: [] }) };
  };
}

test('НП: дати, статуси, сума', () => {
  assert.strictEqual(np.parseNpDate('26-09-2026 10:32:10'), '2026-09-26');
  assert.strictEqual(np.parseNpDate('30.09.2026 14:47:40'), '2026-09-30');
  assert.strictEqual(np.parseNpDate('2026-09-30 14:48:10'), '2026-09-30');
  assert.strictEqual(np.parseNpDate(''), '');
  assert.strictEqual(np.mapStatus('9'), 'ok');
  assert.strictEqual(np.mapStatus('102'), 'refused');
  assert.strictEqual(np.mapStatus('103'), 'refused');
  assert.strictEqual(np.mapStatus('2'), 'cancelled');
  assert.strictEqual(np.mapStatus('3'), 'nodata');
  assert.strictEqual(np.mapStatus('106'), 'refused'); // одержано і створено ЄН зворотної доставки = повернення (як у скрипті)
  assert.strictEqual(np.mapStatus('7'), 'checking');
  assert.strictEqual(np.mapStatus('999'), 'checking');
  assert.strictEqual(np.isTtn('20451520852070'), true);
  assert.strictEqual(np.isTtn('PRM-963778560'), false);
  const m = np.mapDocument({ Number: '20451520852070', StatusCode: '9', Status: 'Відправлення отримано', DateCreated: '01-09-2026 10:54:36', RecipientDateTime: '03.09.2026 11:40:39', RedeliverySum: '278', DocumentCost: '175', CargoDescriptionString: 'щітка' });
  assert.deepStrictEqual({ status: m.status, amount: m.amount, dateCreated: m.dateCreated, dateReceived: m.dateReceived, product: m.product, found: m.found },
    { status: 'ok', amount: 278, dateCreated: '2026-09-01', dateReceived: '2026-09-03', product: 'щітка', found: true });
  // без ключа суми немає — amount null, вартість доставки (DocumentCost) сумою не вважається
  const m2 = np.mapDocument({ Number: '20451535524936', StatusCode: '102', Status: 'Відмова від отримання', RedeliverySum: '', AfterpaymentOnGoodsCost: '', DocumentCost: '90', UndeliveryReasonsSubtypeDescription: 'Одержувач не з\'явився до відділення' });
  assert.deepStrictEqual({ status: m2.status, amount: m2.amount, reason: m2.reason }, { status: 'refused', amount: null, reason: 'Одержувач не з\'явився до відділення' });
});

test('НП: track — пакети по 100, пропуск не-ТТН, не знайдено', async () => {
  const calls = [];
  const docs = { 20451520852070: { StatusCode: '9', Status: 'Відправлення отримано' } };
  const numbers = ['20451520852070', 'PRM-1', ' 20451520852070 ', ...Array.from({ length: 150 }, (_, i) => String(20450000000000 + i))];
  const { found: r, errors } = await np.track(numbers, { fetch: fakeFetch(docs, calls), apiKey: 'k' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(calls.length, 2); // 151 унікальних номерів → 2 запити
  assert.strictEqual(calls[0].apiKey, 'k');
  assert.strictEqual(calls[0].methodProperties.Documents.length, 100);
  assert.strictEqual(r.size, 151);
  assert.strictEqual(r.get('20451520852070').status, 'ok');
  assert.strictEqual(r.get('20450000000005').found, false);
  assert.strictEqual(r.get('20450000000005').status, 'nodata');
  assert.strictEqual(r.has('PRM-1'), false);

  await assert.rejects(np.track(['20451520852070'], { fetch: async () => { throw new Error('ENOTFOUND'); } }), /недоступна/);

  // два кабінети: береться відповідь із сумою (власник накладної); чужий ключ бачить лише статус
  const calls2 = [];
  const twoKeys = async (url, init) => {
    const body = JSON.parse(init.body); calls2.push(body.apiKey);
    const full = body.apiKey === 'owner';
    const data = body.methodProperties.Documents.map((d) => ({ Number: d.DocumentNumber, StatusCode: '9', Status: 'Відправлення отримано', RedeliverySum: full ? '278' : '', PhoneSender: full ? '380' : '' }));
    return { ok: true, json: async () => ({ success: true, data }) };
  };
  const r2 = await np.track(['20451520852070'], { fetch: twoKeys, accounts: [{ name: 'НП 1', token: 'other' }, { name: 'НП 2', token: 'owner' }] });
  assert.deepStrictEqual(calls2, ['other', 'owner']);
  assert.deepStrictEqual({ amount: r2.found.get('20451520852070').amount, account: r2.found.get('20451520852070').account }, { amount: 278, account: 'НП 2' });
  // один ключ зламаний — помилка в errors, результат із другого
  const r3 = await np.track(['20451520852070'], { fetch: async (u, i) => (JSON.parse(i.body).apiKey === 'bad' ? { ok: true, json: async () => ({ success: false, errors: ['API key is invalid'] }) } : twoKeys(u, i)), accounts: [{ name: 'НП 1', token: 'bad' }, { name: 'НП 2', token: 'owner' }] });
  assert.strictEqual(r3.errors.length, 1);
  assert.strictEqual(r3.found.get('20451520852070').amount, 278);
  await assert.rejects(np.track(['20451520852070'], { fetch: async () => ({ ok: true, json: async () => ({ success: false, errors: ['API key is invalid'] }) }) }), /API key is invalid/);
});
