'use strict';
// Спільна логіка роботи з даними: нею користуються і вікно (IPC у main.js), і HTTP API (api.js).
const lib = require('./lib');
const np = require('./np');
const mp = require('./marketplaces');
const { lookup, combine, monthRange } = require('./lookup');

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new ApiError(502, `HTTP ${res.status} при завантаженні таблиці`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new ApiError(502, 'Google повернув сторінку входу: відкрийте доступ «усім, хто має посилання»');
  return res.text();
}

class Service {
  // opts.fetch — підміна fetch для Нової Пошти в тестах.
  constructor(store, opts = {}) { this.store = store; this.fetch = opts.fetch || null; }
  get data() { return this.store.data; }

  // ---------- налаштування ----------
  saveSettings(patch) {
    const s = this.data.settings;
    if (patch.ratePercent != null) {
      const r = Number(patch.ratePercent);
      if (!Number.isFinite(r) || r < 0) throw new ApiError(400, 'Ставка має бути невід’ємним числом');
      s.ratePercent = r;
    }
    if (patch.api) {
      const a = Object.assign({}, s.api, patch.api);
      a.enabled = !!a.enabled;
      a.port = Number(a.port) || 8765;
      if (a.port < 1 || a.port > 65535) throw new ApiError(400, 'Порт має бути від 1 до 65535');
      a.host = String(a.host || '127.0.0.1').trim() || '127.0.0.1';
      a.token = String(a.token || '').trim();
      s.api = a;
    }
    if (patch.accounts) s.accounts = this.cleanAccounts(patch.accounts);
    this.store.save();
    return s;
  }

  // ---------- працівники ----------
  saveEmployees(list) {
    const seen = new Set();
    const clean = [];
    for (const e of list) {
      const name = String(e.name || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const rate = e.ratePercent === '' || e.ratePercent == null ? null : Number(e.ratePercent);
      clean.push({ id: Number(e.id) || this.store.nextId(), name, ratePercent: Number.isFinite(rate) ? rate : null });
    }
    const ids = new Set(clean.map((e) => e.id));
    this.data.employees = clean;
    this.data.orders = this.data.orders.filter((o) => ids.has(o.employeeId));
    this.store.save();
    return this.data;
  }

  addEmployee(name, ratePercent) {
    name = String(name || '').trim();
    if (!name) throw new ApiError(400, 'Порожнє ім’я працівника');
    const existing = this.data.employees.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const e = { id: this.store.nextId(), name, ratePercent: ratePercent == null || ratePercent === '' ? null : Number(ratePercent) };
    this.data.employees.push(e);
    this.store.save();
    return e;
  }

  deleteEmployee(id) {
    const list = this.data.employees.filter((e) => e.id !== Number(id));
    if (list.length === this.data.employees.length) throw new ApiError(404, 'Працівника не знайдено');
    return this.saveEmployees(list);
  }

  // Працівник за id або за ім’ям (без урахування регістру).
  resolveEmployee(ref) {
    if (ref == null || ref === '') return null;
    const byId = this.data.employees.find((e) => e.id === Number(ref));
    if (byId) return byId;
    const name = String(ref).trim().toLowerCase();
    return this.data.employees.find((e) => e.name.toLowerCase() === name) || null;
  }

  requireEmployee(ref) {
    const e = this.resolveEmployee(ref);
    if (!e) throw new ApiError(400, `Працівника не знайдено: ${ref == null ? '(порожньо)' : ref}`);
    return e;
  }

  // ---------- замовлення ----------
  normalizeOrder(order) {
    const emp = this.requireEmployee(order.employeeId != null ? order.employeeId : order.employee);
    return {
      id: Number(order.id) || 0,
      employeeId: emp.id,
      product: String(order.product || '').trim(),
      number: String(order.number || '').trim().replace(/\s+/g, ' '),
      amount: lib.round2(Number(order.amount) || 0),
      channel: String(order.channel || '').trim(),
      status: lib.STATUS[order.status] ? order.status : 'checking',
      date: isDate(order.date) ? order.date : todayLocal(),
      track: order.track && typeof order.track === 'object'
        ? { checked: String(order.track.checked || ''), note: String(order.track.note || ''), problem: String(order.track.problem || ''),
          np: order.track.np || null, mp: order.track.mp || null, rd: order.track.rd || null }
        : null,
    };
  }

  // Один запис за id (створити або оновити повністю).
  upsertOrder(order) {
    const o = this.normalizeOrder(order);
    if (!o.id) o.id = this.store.nextId();
    const i = this.data.orders.findIndex((x) => x.id === o.id);
    if (i >= 0) this.data.orders[i] = o; else this.data.orders.push(o);
    this.store.save();
    return o;
  }

  // Пакет записів: за id, якщо він є, інакше злиття за «працівник + номер» (як імпорт).
  mergeOrders(list) {
    let added = 0, updated = 0;
    const withId = [], withoutId = [];
    for (const raw of list) {
      const o = this.normalizeOrder(raw);
      if (o.id) withId.push(o); else withoutId.push(o);
    }
    for (const o of withId) {
      const i = this.data.orders.findIndex((x) => x.id === o.id);
      if (i >= 0) { this.data.orders[i] = o; updated++; } else { this.data.orders.push(o); added++; }
    }
    const r = lib.mergeOrders(this.data.orders, withoutId, () => this.store.nextId());
    this.data.orders = r.orders;
    this.store.save();
    return { added: added + r.added, updated: updated + r.updated, parsed: list.length };
  }

  deleteOrders(ids) {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(Number));
    const before = this.data.orders.length;
    this.data.orders = this.data.orders.filter((o) => !set.has(o.id));
    this.store.save();
    return { deleted: before - this.data.orders.length };
  }

  listOrders({ employee, period, status, q } = {}) {
    const emp = employee ? this.requireEmployee(employee) : null;
    const qq = (q || '').trim().toLowerCase();
    return this.data.orders.filter((o) => (!emp || o.employeeId === emp.id)
      && (!period || lib.monthOf(o.date) === period)
      && (!status || o.status === status)
      && (!qq || (o.product || '').toLowerCase().includes(qq) || (o.number || '').toLowerCase().includes(qq)));
  }

  // ---------- імпорт ----------
  importCsvText(text, { employee, employeeId, date, defaultStatus } = {}) {
    const emp = this.requireEmployee(employeeId != null ? employeeId : employee);
    const rows = lib.parseCsv(text);
    const incoming = lib.importRows(rows, { employeeId: emp.id, date: isDate(date) ? date : todayLocal(), defaultStatus });
    const r = lib.mergeOrders(this.data.orders, incoming, () => this.store.nextId());
    this.data.orders = r.orders;
    this.store.save();
    return { added: r.added, updated: r.updated, parsed: incoming.length, employeeId: emp.id };
  }

  async importFromUrl(url, opts = {}) {
    const exportUrl = lib.sheetExportUrl(url);
    if (!exportUrl) throw new ApiError(400, 'Це не посилання на Google Таблицю');
    const text = await fetchText(exportUrl);
    const res = this.importCsvText(text, opts);
    const urls = (this.data.settings.sheetUrls || []).filter((u) => u.employeeId !== res.employeeId);
    urls.push({ employeeId: res.employeeId, url });
    this.data.settings.sheetUrls = urls;
    this.store.save();
    return res;
  }

  // ---------- кабінети (ключі) ----------
  // Кабінет: {kind, name, token, employeeId}. employeeId null = спільний для всіх працівників.
  // Той самий ключ у двох працівників (напр. Нова Пошта чи Rozetka в обох таблицях) → спільний.
  cleanAccounts(list) {
    const out = [];
    const byToken = new Map();
    const empIds = new Set(this.data.employees.map((e) => e.id));
    for (const a of Array.isArray(list) ? list : []) {
      const kind = String(a.kind || '').trim();
      const token = String(a.token || a.key || '').trim();
      if (!mp.KINDS[kind] || !token) continue;
      const employeeId = a.employeeId != null && a.employeeId !== '' && empIds.has(Number(a.employeeId)) ? Number(a.employeeId) : null;
      const key = kind + '|' + token;
      const dup = byToken.get(key);
      if (dup) { if (dup.employeeId !== employeeId) dup.employeeId = null; continue; }
      const base = String(a.name || '').trim() || mp.KINDS[kind];
      let name = base, i = 2;
      while (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${base} (${i++})`;
      const acc = { kind, name, token, employeeId };
      byToken.set(key, acc);
      out.push(acc);
    }
    return out;
  }

  // Кабінети, якими шукати замовлення працівника: його власні + спільні.
  accountsFor(employeeId) {
    return this.data.settings.accounts.filter((a) => a.employeeId == null || a.employeeId === Number(employeeId));
  }

  // Ключі з тексту Apps Script таблиць (NOVA_POSHTA_ACCOUNTS, PROM_ACCOUNTS, …) — додаються до наявних.
  importAccountsFromScript(text, employee) {
    const emp = employee != null && employee !== '' ? this.requireEmployee(employee) : null;
    const parsed = mp.parseScriptAccounts(text).map((a) => Object.assign(a, { employeeId: emp ? emp.id : null }));
    if (!parsed.length) throw new ApiError(400, 'У тексті не знайдено жодного ключа (очікую масиви NOVA_POSHTA_ACCOUNTS, PROM_ACCOUNTS, EPICENTER_ACCOUNTS, ROZETKA_ACCOUNTS)');
    const before = this.data.settings.accounts.length;
    this.data.settings.accounts = this.cleanAccounts([...this.data.settings.accounts, ...parsed]);
    this.store.save();
    return { parsed: parsed.length, added: this.data.settings.accounts.length - before, accounts: this.data.settings.accounts };
  }

  // Перевірка кожного кабінету: НП — тестовий запит, маркетплейси — перша сторінка замовлень.
  async testAccounts() {
    const out = [];
    for (const a of this.data.settings.accounts) {
      if (a.kind === 'np') {
        try {
          const r = await np.track(['20450000000000'], { accounts: [a], fetch: this.fetch });
          out.push({ name: a.name, kind: a.kind, ok: true, message: r.errors.length ? r.errors.join('; ') : 'працює' });
        } catch (e) { out.push({ name: a.name, kind: a.kind, ok: false, message: e.message || String(e) }); }
      } else {
        out.push(Object.assign({ name: a.name, kind: a.kind }, await mp.testAccount(a, { fetch: this.fetch })));
      }
    }
    return out;
  }

  // ---------- пошук за номером (Нова Пошта + маркетплейси) ----------
  // Без запису в базу: {results: [...], errors: [..]}.
  // employeeId — шукати лише його кабінетами (+ спільними); без нього — усіма.
  async trackNumbers(numbers, employeeId) {
    const list = [...new Set((Array.isArray(numbers) ? numbers : String(numbers || '').split(/[\s,;]+/)).map((n) => String(n || '').trim()).filter(Boolean))];
    if (!list.length) return { results: new Map(), errors: [] };
    const accounts = employeeId != null ? this.accountsFor(employeeId) : this.data.settings.accounts;
    try { return await lookup(list, accounts, { fetch: this.fetch }); }
    catch (e) { throw new ApiError(502, e.message || String(e)); }
  }

  // Підставити зведення в замовлення. withDate — також дату (з маркетплейсу або дата накладної).
  applyTracking(o, t, { withDate } = {}) {
    const before = { status: o.status, amount: o.amount, date: o.date, channel: o.channel };
    o.status = t.status;
    if (t.amount != null) o.amount = lib.round2(t.amount);
    if (t.channel) o.channel = t.channel;
    if (!o.product && t.product) o.product = t.product;
    if (withDate && t.date) o.date = t.date;
    o.track = { checked: todayLocal(), note: t.note, problem: t.problem, np: t.np, mp: t.mp, rd: t.rd };
    return before.status !== o.status || before.amount !== o.amount || before.date !== o.date || before.channel !== o.channel;
  }

  // Додати замовлення за номерами (ТТН, PRM-…, номер замовлення): статус, сума, дата, канал — з джерел.
  // Повтор за «працівник + номер» оновлюється, а не дублюється.
  // products: {номер → назва товару} (необов’язково, для вставки з таблиці).
  async addByTtn({ employee, employeeId, numbers, channel, product, products } = {}) {
    const emp = this.requireEmployee(employeeId != null ? employeeId : employee);
    const { results, errors } = await this.trackNumbers(numbers, emp.id);
    const res = { added: 0, updated: 0, notFound: [], noAmount: [], errors, orders: [] };
    for (const [number, t] of results) {
      if (!t.found) { res.notFound.push(number); }
      let o = this.data.orders.find((x) => x.employeeId === emp.id && x.number === number);
      if (o) { if (this.applyTracking(o, t)) res.updated++; }
      else {
        if (!t.found) continue;
        o = this.normalizeOrder({ employeeId: emp.id, number, product: (products && products[number]) || product || t.product, channel: channel || t.channel, status: t.status, amount: t.amount || 0, date: t.date || todayLocal() });
        o.id = this.store.nextId();
        this.applyTracking(o, t);
        this.data.orders.push(o);
        res.added++;
      }
      if (t.found && t.amount == null) res.noAmount.push(number);
      res.orders.push(o);
    }
    this.store.save();
    return res;
  }

  // Перевірити наявні замовлення: за ids або за фільтрами listOrders. Замовлення без номера пропускаються.
  async refreshFromNp({ ids, employee, period, status, q, withDate } = {}) {
    const orders = Array.isArray(ids) && ids.length
      ? this.data.orders.filter((o) => ids.map(Number).includes(o.id))
      : this.listOrders({ employee, period, status, q });
    const res = { checked: 0, updated: 0, skipped: 0, notFound: [], errors: [], changes: [] };
    const withNumber = orders.filter((o) => o.number);
    res.skipped = orders.length - withNumber.length;
    if (!withNumber.length) return res;
    const results = new Map();
    for (const empId of new Set(withNumber.map((o) => o.employeeId))) {
      const r = await this.trackNumbers(withNumber.filter((o) => o.employeeId === empId).map((o) => o.number), empId);
      for (const [n, t] of r.results) results.set(empId + '|' + n, t);
      res.errors.push(...r.errors);
    }
    for (const o of withNumber) {
      const t = results.get(o.employeeId + '|' + o.number);
      if (!t) continue;
      res.checked++;
      if (!t.found) res.notFound.push(o.number);
      const before = { status: o.status, amount: o.amount, date: o.date, channel: o.channel };
      if (this.applyTracking(o, t, { withDate })) {
        res.updated++;
        res.changes.push({ id: o.id, number: o.number, from: before, to: { status: o.status, amount: o.amount, date: o.date, channel: o.channel } });
      }
    }
    this.store.save();
    return res;
  }

  // ---------- вставка з таблиці ----------
  // Текст, скопійований із трьох колонок Google Таблиці (товар, ТТН/номер, працівник) у будь-якому
  // порядку: колонки розділені табуляцією. Повертає {rows: [{product, number, employee}], unknown: [...]}.
  parsePasted(text) {
    const rows = [], unknown = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const cells = raw.split('\t').map((c) => c.trim());
      if (!cells.some(Boolean)) continue;
      let number = '', emp = null, product = '';
      const rest = [];
      for (const c of cells) {
        if (!c) continue;
        if (!number && (np.isTtn(c) || /^PRM[-\s]?\d{6,}$/i.test(c) || /^\d{6,20}$/.test(c))) { number = c.replace(/\s+/g, ''); continue; }
        const e = !emp && this.resolveEmployee(c);
        if (e) { emp = e; continue; }
        rest.push(c);
      }
      product = rest.join(' ');
      if (!number) { unknown.push({ line: raw, reason: 'немає номера ТТН' }); continue; }
      if (!emp) { unknown.push({ line: raw, reason: 'не впізнано працівника' }); continue; }
      rows.push({ product, number, employeeId: emp.id, employee: emp.name });
    }
    return { rows, unknown };
  }

  async addPasted(text) {
    const { rows, unknown } = this.parsePasted(text);
    if (!rows.length && !unknown.length) throw new ApiError(400, 'Порожній текст');
    const res = { parsed: rows.length, added: 0, updated: 0, notFound: [], noAmount: [], errors: [], unknown };
    for (const empId of new Set(rows.map((r) => r.employeeId))) {
      const mine = rows.filter((r) => r.employeeId === empId);
      const products = {};
      for (const r of mine) if (r.product) products[r.number] = r.product;
      const r = await this.addByTtn({ employeeId: empId, numbers: mine.map((x) => x.number), products });
      res.added += r.added; res.updated += r.updated;
      res.notFound.push(...r.notFound); res.noAmount.push(...r.noAmount); res.errors.push(...r.errors);
    }
    return res;
  }

  // ---------- відправлення з кабінетів ----------
  // Усе, що створено в кабінетах маркетплейсів за місяць period (працівника або всіх),
  // звірене з Новою Поштою. Нічого не записує. Повертає {items, errors}.
  async collectShipments({ employee, period } = {}) {
    if (!isMonth(period)) throw new ApiError(400, 'Період має бути у форматі YYYY-MM');
    const { from, to } = monthRange(period);
    const emp = employee ? this.requireEmployee(employee) : null;
    const employees = emp ? [emp] : this.data.employees;
    const items = [], errors = [];
    for (const e of employees) {
      const accounts = this.accountsFor(e.id);
      const mpAccounts = accounts.filter((a) => a.kind !== 'np');
      if (!mpAccounts.length) continue;
      const r = await mp.listOrders(mpAccounts, { from, to, fetch: this.fetch });
      errors.push(...r.errors.map((x) => `${e.name}: ${x}`));
      // Спільний кабінет видно всім працівникам: їхні замовлення розрізняти нема як, тож
      // замовлення спільного кабінету показуються лише коли вибрано одного працівника.
      const own = r.items.filter((it) => it.employeeId === e.id || (emp && it.employeeId == null));
      const ttns = own.map((it) => it.ttn).filter((t) => np.isTtn(t));
      let npFound = new Map();
      if (ttns.length) {
        try { const t = await np.track(ttns, { accounts: accounts.filter((a) => a.kind === 'np'), fetch: this.fetch }); npFound = t.found; errors.push(...t.errors); }
        catch (err) { errors.push(`${e.name}: ${err.message || err}`); }
      }
      const rdIds = own.map((it) => mp.rozetkaDeliveryId(it.ttn)).filter(Boolean);
      const rdFound = rdIds.length ? await mp.rozetkaDelivery(rdIds, { fetch: this.fetch }) : new Map();
      for (const it of own) {
        const number = it.ttn || `${it.kind}-${it.orderId}`;
        const c = combine(number, npFound.get(it.ttn), it, rdFound.get(mp.rozetkaDeliveryId(it.ttn)));
        const existing = this.data.orders.find((o) => o.employeeId === e.id && o.number === number);
        items.push({
          employeeId: e.id, employee: e.name, number, ttn: it.ttn, orderId: it.orderId, channel: it.channel, kind: it.kind,
          product: it.product, amount: c.amount != null ? c.amount : it.amount, date: it.date, status: c.status, problem: c.problem,
          mpStatus: it.status, note: c.note, track: { np: c.np, mp: c.mp, rd: c.rd }, inBase: existing ? existing.id : null,
        });
      }
    }
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { items, period, from, to, errors };
  }

  // Додати зібрані відправлення в замовлення (повтор за «працівник + номер» оновлюється).
  addShipments(items) {
    let added = 0, updated = 0;
    for (const it of Array.isArray(items) ? items : []) {
      const emp = this.resolveEmployee(it.employeeId);
      const number = String(it.number || '').trim();
      if (!emp || !number) continue;
      const t = { status: lib.STATUS[it.status] ? it.status : 'checking', amount: it.amount == null ? null : Number(it.amount), channel: it.channel, product: it.product, date: it.date, note: it.note || '', problem: it.problem || '', np: it.track && it.track.np, mp: it.track && it.track.mp, rd: it.track && it.track.rd };
      let o = this.data.orders.find((x) => x.employeeId === emp.id && x.number === number);
      if (o) { if (this.applyTracking(o, t, { withDate: true })) updated++; }
      else {
        o = this.normalizeOrder({ employeeId: emp.id, number, product: it.product, channel: it.channel, status: t.status, amount: t.amount || 0, date: it.date });
        o.id = this.store.nextId();
        this.applyTracking(o, t);
        this.data.orders.push(o);
        added++;
      }
    }
    this.store.save();
    return { added, updated };
  }

  // ---------- розрахунок і експорт ----------
  salary(period) {
    if (period && !isMonth(period)) throw new ApiError(400, 'Період має бути у форматі YYYY-MM');
    const rows = lib.calcSalary(this.data, period || '');
    const totals = rows.reduce((a, s) => ({ total: a.total + s.total, done: a.done + s.done, sumDone: lib.round2(a.sumDone + s.sumDone), salary: lib.round2(a.salary + s.salary) }),
      { total: 0, done: 0, sumDone: 0, salary: 0 });
    return { period: period || '', ratePercent: this.data.settings.ratePercent, rows, totals };
  }

  exportBuffer(format, period) {
    const { rows: summary, totals } = this.salary(period);
    const head = ['Працівник', 'Ставка, %', 'Замовлень', 'Виконано', 'Відмови', 'Скасовано', 'Немає даних', 'Перевіряється', 'Сума виконаних', 'Зарплата'];
    const sRows = [head, ...summary.map((s) => [s.name, s.ratePercent, s.total, s.done, s.refused, s.cancelled, s.nodata, s.checking, s.sumDone, s.salary])];
    sRows.push(['Разом', '', totals.total, totals.done, '', '', '', '', totals.sumDone, totals.salary]);
    const byId = new Map(this.data.employees.map((e) => [e.id, e.name]));
    const orders = this.listOrders({ period }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    const oRows = [['Дата', 'Працівник', 'Товар', 'Номер', 'Сума', 'Канал', 'Статус'],
      ...orders.map((o) => [o.date, byId.get(o.employeeId) || '', o.product, o.number, o.amount, o.channel, lib.STATUS[o.status] || o.status])];
    const filename = `зарплата-${period || 'увесь-час'}.${format}`;
    if (format === 'xlsx') return { filename, buffer: lib.buildXlsx([{ name: 'Зарплата', rows: sRows }, { name: 'Замовлення', rows: oRows }]), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (format === 'csv') return { filename, buffer: Buffer.from(lib.toCsv([...sRows, [], ...oRows]), 'utf8'), contentType: 'text/csv; charset=utf-8' };
    throw new ApiError(400, 'Формат має бути xlsx або csv');
  }

  // ---------- резервна копія ----------
  replaceData(d) {
    if (!d || !Array.isArray(d.employees) || !Array.isArray(d.orders)) throw new ApiError(400, 'Очікую об’єкт із полями employees і orders');
    const settings = Object.assign({}, this.data.settings, d.settings || {}, { api: this.data.settings.api });
    settings.accounts = this.cleanAccounts(settings.accounts);
    settings.ratePercent = Number(settings.ratePercent) || 5;
    this.data.settings = settings;
    this.data.employees = d.employees.map((e) => ({ id: Number(e.id), name: String(e.name || '').trim(), ratePercent: e.ratePercent == null ? null : Number(e.ratePercent) })).filter((e) => e.id && e.name);
    const ids = new Set(this.data.employees.map((e) => e.id));
    this.data.orders = d.orders.filter((o) => ids.has(Number(o.employeeId))).map((o) => this.normalizeOrder(o)).map((o) => (o.id ? o : Object.assign(o, { id: this.store.nextId() })));
    const maxId = Math.max(999, ...this.data.employees.map((e) => e.id), ...this.data.orders.map((o) => o.id));
    if (this.data.nextId <= maxId) this.data.nextId = maxId + 1;
    this.store.save();
    return { employees: this.data.employees.length, orders: this.data.orders.length };
  }
}

module.exports = { Service, ApiError, todayLocal };
