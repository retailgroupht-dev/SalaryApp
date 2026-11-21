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

// Коди всередині номера, за якими впізнається те саме замовлення: 14-значні ТТН і коди посилок (RMP-…, PRM-…).
const numberCodes = (n) => [...(String(n || '').match(/\d{14}/g) || []), ...mp.parcelCodes(n)];

// Чому рядок вставленого з таблиці не пораховано (addPasted → skipped[].reason).
const SKIP = {
  noEmployee: 'не визначено працівника: імені в рядку немає, а кабінети працівників замовлення не знайшли',
  otherEmployee: (name) => `працівника «${name}» немає в застосунку`,
  empty: 'немає ні номера, ні працівника',
};

class Service {
  // opts.fetch — підміна fetch для Нової Пошти в тестах.
  constructor(store, opts = {}) { this.store = store; this.fetch = opts.fetch || null; this.migrateNumbers(); }
  get data() { return this.store.data; }

  // Раніше замовлення без ТТН записувалось із номером «rozetka-123»: тепер ТТН порожній, а № замовлення
  // і кабінет — окремі поля orderId/kind (заповнюються і з track.mp). Запис без ТТН, що дублює запис
  // із ТТН того ж замовлення, прибирається.
  migrateNumbers() {
    const re = /^(rozetka|prom|epicentr)-(\S+)$/;
    let changed = false;
    for (const o of this.data.orders) {
      const m = re.exec(o.number || '');
      if (m) { o.number = ''; o.kind = m[1]; o.orderId = m[2]; changed = true; }
      if (!o.orderId && o.track && o.track.mp && o.track.mp.orderId) { o.orderId = String(o.track.mp.orderId); o.kind = o.track.mp.kind || ''; changed = true; }
      if (o.orderId == null) { o.orderId = ''; o.kind = o.kind || ''; changed = true; }
      if (!lib.SOURCE[o.source]) { o.source = 'auto'; changed = true; } // база до розділення на два набори
      // невідправлена накладна НП (код 1) раніше лишалась «Перевіряється», тепер — «Немає даних» (2026-11-18)
      if (o.status === 'checking' && o.track && o.track.np && o.track.np.code === '1') { o.status = 'nodata'; changed = true; }
      // «Виконано» з сумою 0 (передплата НП, суми ніде немає) — «Немає даних», впишіть суму (2026-11-21)
      if (o.status === 'ok' && !o.dup && !(Number(o.amount) > 0) && o.track) { o.status = 'nodata'; o.track.noAmount = true; changed = true; }
      // «Перевіряється» без ТТН і без № замовлення — перевіряти нема чого (2026-11-18)
      if (o.status === 'checking' && !o.number && !o.orderId) { o.status = 'nodata'; changed = true; }
    }
    const withTtn = new Set(this.data.orders.filter((o) => o.number && o.orderId).map((o) => `${o.source}|${o.employeeId}|${o.kind}|${o.orderId}`));
    const before = this.data.orders.length;
    this.data.orders = this.data.orders.filter((o) => o.number || !o.orderId || !withTtn.has(`${o.source}|${o.employeeId}|${o.kind}|${o.orderId}`));
    if (changed || this.data.orders.length !== before) this.store.save();
    return before - this.data.orders.length;
  }

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
    if (patch.salarySource) s.salarySource = patch.salarySource === 'manual' ? 'manual' : 'auto';
    if (patch.auto) {
      const a = Object.assign({}, s.auto, patch.auto);
      a.enabled = !!a.enabled;
      a.hours = [1, 3, 6, 12, 24].includes(Number(a.hours)) ? Number(a.hours) : 6;
      s.auto = { enabled: a.enabled, hours: a.hours, lastRun: s.auto.lastRun || '', lastResult: s.auto.lastResult || '' };
    }
    if (patch.accounts) {
      const old = new Map(s.accounts.map((a) => [a.kind + '|' + a.token, a.name]));
      s.accounts = this.cleanAccounts(patch.accounts);
      // Перейменований кабінет → той самий канал у замовленнях.
      for (const a of s.accounts) {
        const prev = old.get(a.kind + '|' + a.token);
        if (prev && prev !== a.name) for (const o of this.data.orders) if (o.channel === prev) o.channel = a.name;
      }
    }
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
    const invalid = String(order.invalid || '').trim(); // неправильний рядок вставки: записується як є, причина тут
    const emp = invalid && order.employeeId == null && !order.employee ? null : this.requireEmployee(order.employeeId != null ? order.employeeId : order.employee);
    const number = String(order.number || '').trim().replace(/\s+/g, ' '), orderId = String(order.orderId || '').trim();
    let status = lib.STATUS[order.status] ? order.status : 'checking';
    if (status === 'checking' && !number && !orderId) status = 'nodata'; // перевіряти нема чого (lib.NO_NUMBER)
    return {
      id: Number(order.id) || 0,
      employeeId: emp ? emp.id : null,
      product: String(order.product || '').trim(),
      number,
      orderId,
      kind: mp.MP_ORDER.includes(order.kind) ? order.kind : '',
      source: order.source === 'auto' ? 'auto' : 'manual',
      amount: lib.round2(Number(order.amount) || 0),
      channel: String(order.channel || '').trim(),
      status,
      date: isDate(order.date) ? order.date : todayLocal(),
      month: isMonth(order.month) ? order.month : '', // місяць вкладки таблиці для вставленого (lib.orderMonth)
      pasted: !!order.pasted, // запис рядка вставки з 2026-11-19 (matchPasted)
      dup: Number(order.dup) || 0, // повтор номера в таблиці: № першого рядка; сума рахується один раз
      invalid, // «Неправильний рядок: …» — рядок вставки без працівника; у зарплату не йде
      tableAmount: Number(order.tableAmount) > 0 ? lib.round2(Number(order.tableAmount)) : 0, // сума з вставленої таблиці (важливіша за НП)
      track: order.track && typeof order.track === 'object'
        ? { checked: String(order.track.checked || ''), note: String(order.track.note || ''), problem: String(order.track.problem || ''),
          np: order.track.np || null, mp: order.track.mp || null, rd: order.track.rd || null, noAmount: !!order.track.noAmount,
          amountSource: String(order.track.amountSource || '') }
        : null,
    };
  }

  // Один запис за id (створити або оновити повністю).
  // Поля вставки (місяць вкладки, дубль) форма не надсилає: беруться з наявного запису, якщо їх не передано.
  withPasteFields(order) {
    const old = order && order.id ? this.data.orders.find((x) => x.id === Number(order.id)) : null;
    if (!old) return order;
    const keep = {};
    for (const k of ['month', 'pasted', 'dup', 'invalid', 'tableAmount']) if (order[k] === undefined) keep[k] = old[k];
    return Object.assign(keep, order);
  }

  upsertOrder(order) {
    const o = this.normalizeOrder(this.withPasteFields(order));
    // «Виконано» без суми чекало, поки людина впише суму: вписала — знову «Виконано»
    if (o.status === 'nodata' && o.track && o.track.noAmount && o.amount > 0) { o.status = 'ok'; o.track.noAmount = false; }
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
      const o = this.normalizeOrder(this.withPasteFields(raw));
      if (o.id) withId.push(o); else withoutId.push(o);
    }
    for (const o of withId) {
      const i = this.data.orders.findIndex((x) => x.id === o.id);
      if (i >= 0) { this.data.orders[i] = o; updated++; } else { this.data.orders.push(o); added++; }
    }
    for (const source of Object.keys(lib.SOURCE)) {
      const inc = withoutId.filter((o) => o.source === source);
      if (!inc.length) continue;
      const r = this.mergeInto(source, inc);
      added += r.added; updated += r.updated;
    }
    this.store.save();
    return { added, updated, parsed: list.length };
  }

  // Злиття за «працівник + номер» лише всередині свого набору (auto або manual); другий набір не чіпається.
  mergeInto(source, incoming) {
    const mine = this.data.orders.filter((o) => o.source === source), others = this.data.orders.filter((o) => o.source !== source);
    const r = lib.mergeOrders(mine, incoming.map((o) => Object.assign({ orderId: '', kind: '' }, o, { source })), () => this.store.nextId());
    this.data.orders = others.concat(r.orders);
    return { added: r.added, updated: r.updated };
  }

  deleteOrders(ids) {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(Number));
    const before = this.data.orders.length;
    this.data.orders = this.data.orders.filter((o) => !set.has(o.id));
    this.store.save();
    return { deleted: before - this.data.orders.length };
  }

  listOrders({ employee, period, status, q, source } = {}) {
    const emp = employee ? this.requireEmployee(employee) : null;
    const qq = (q || '').trim().toLowerCase();
    if (source && !lib.SOURCE[source]) throw new ApiError(400, 'source має бути auto або manual');
    return this.data.orders.filter((o) => (!emp || o.employeeId === emp.id) && (!source || o.source === source)
      && (!period || lib.orderMonth(o) === period)
      && (!status || o.status === status)
      && (!qq || (o.product || '').toLowerCase().includes(qq) || (o.number || '').toLowerCase().includes(qq) || (o.orderId || '').toLowerCase().includes(qq)));
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
  // Назви кабінетів — зрозумілі: «Пром Настя», «Пром Товкес 2», «Нова Пошта Малай» (за відправником у НП).
  async importAccountsFromScript(text, employee) {
    const emp = employee != null && employee !== '' ? this.requireEmployee(employee) : null;
    const parsed = mp.parseScriptAccounts(text).map((a) => Object.assign(a, { employeeId: emp ? emp.id : null }));
    if (!parsed.length) throw new ApiError(400, 'У тексті не знайдено жодного ключа (очікую масиви NOVA_POSHTA_ACCOUNTS, PROM_ACCOUNTS, EPICENTER_ACCOUNTS, ROZETKA_ACCOUNTS)');
    const known = new Set(this.data.settings.accounts.map((a) => a.kind + '|' + a.token));
    const counts = {};
    for (const a of parsed) {
      if (known.has(a.kind + '|' + a.token)) continue;
      let who = emp ? emp.name : '';
      if (a.kind === 'np') who = (await np.senderName(a.token, { fetch: this.fetch })) || who;
      if (!who) continue;
      counts[a.kind] = (counts[a.kind] || 0) + 1;
      a.name = `${mp.KINDS[a.kind]} ${who}`;
    }
    for (const kind of Object.keys(counts)) {
      if (counts[kind] < 2 || kind === 'np') continue;
      let i = 1;
      for (const a of parsed) if (a.kind === kind && !known.has(a.kind + '|' + a.token)) a.name += ` ${i++}`;
    }
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
  // Без запису в базу: {results: Map(номер → зведення), errors: [..]}. Шукає всіма ключами: за початком номера
  // видно, кого питати (14 цифр — Нова Пошта, PRM-/RMP- або 12 цифр — Rozetka Delivery, решта — номер замовлення),
  // а кабінет, який знайшов замовлення, каже, чиє воно (зведення.employeeId; null — спільний кабінет).
  async trackNumbers(numbers) {
    const list = [...new Set((Array.isArray(numbers) ? numbers : String(numbers || '').split(/[\s,;]+/)).map((n) => String(n || '').trim()).filter(Boolean))];
    if (!list.length) return { results: new Map(), errors: [] };
    try { return await lookup(list, this.data.settings.accounts, { fetch: this.fetch }); }
    catch (e) { throw new ApiError(502, e.message || String(e)); }
  }

  // Чиє це замовлення, коли працівника не вказано: кабінет, що його знайшов; інакше — наявне замовлення
  // з цим номером у наборі; якщо працівник у базі один — він. null = не визначено.
  ownerOf(number, t, source) {
    if (t.employeeId != null && this.data.employees.some((e) => e.id === t.employeeId)) return t.employeeId;
    const known = this.findExisting(null, number, { kind: t.mp && t.mp.kind, orderId: t.mp && t.mp.orderId, source });
    if (known) return known.employeeId;
    return this.data.employees.length === 1 ? this.data.employees[0].id : null;
  }

  // Наявне замовлення працівника з тим самим номером — точно або за кодом посилки/ТТН усередині
  // («RMP-251639361 723-5205316» з таблиці = «RMP-251639361» з кабінету).
  // Те саме замовлення працівника: за № замовлення в кабінеті (kind + orderId), за точним номером,
  // або за кодом посилки / 14-значним ТТН усередині номера (рядок таблиці з доважком).
  // employeeId null — будь-якого працівника.
  // index (orderIndex) — для багатьох пошуків поспіль: той самий результат без перебору всієї бази на кожен номер.
  findExisting(employeeId, number, { kind, orderId, source, index } = {}) {
    const fits = (x) => (employeeId == null || x.employeeId === employeeId) && (!source || x.source === source);
    if (index && !orderId) {
      if (!number) return null;
      const exact = (index.exact.get(number) || []).find(fits);
      if (exact) return exact;
      let best = null; // найперше в базі замовлення з таким самим кодом усередині номера
      for (const c of numberCodes(number)) for (const e of index.codes.get(c) || []) if (e.order.number !== number && fits(e.order) && (!best || e.pos < best.pos)) best = e;
      return best ? best.order : null;
    }
    const mine = this.data.orders.filter(fits);
    if (orderId) {
      const byOrder = mine.find((x) => x.orderId === String(orderId) && (!kind || !x.kind || x.kind === kind));
      if (byOrder) return byOrder;
    }
    if (!number) return null;
    const exact = mine.find((x) => x.number === number);
    if (exact) return exact;
    const codes = new Set(numberCodes(number));
    if (!codes.size) return null;
    return mine.find((x) => x.number !== number && numberCodes(x.number).some((c) => codes.has(c))) || null;
  }

  // Індекс замовлень за номером і за кодами всередині номера (у порядку бази) — для findExisting з index.
  orderIndex() {
    const exact = new Map(), codes = new Map();
    const add = (map, key, value) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
    this.data.orders.forEach((order, pos) => {
      if (!order.number) return;
      add(exact, order.number, order);
      for (const c of new Set(numberCodes(order.number))) add(codes, c, { order, pos });
    });
    return { exact, codes };
  }

  // Підставити зведення в замовлення. withDate — також дату (з маркетплейсу або дата накладної).
  applyTracking(o, t, { withDate } = {}) {
    const before = { status: o.status, amount: o.amount, date: o.date, channel: o.channel, number: o.number };
    // Сума: маркетплейс → (рядок таблиці: авто-набір за тим самим ТТН) → сума з вставленої таблиці → Нова Пошта останньою
    // (власник 2026-11-21). Якщо кабінети свого працівника суми не дали (замовлення в чужому кабінеті, лише Нова Пошта),
    // беремо те, що програма вже знає про цей ТТН в авто-наборі.
    const npAmountOnly = () => t.amount == null || /^Нова Пошта/.test(t.amountSource || ''); // накладений платіж або оголошена вартість
    if (o.source === 'manual' && o.number && (npAmountOnly() || !t.channel || !t.product || !t.date)) {
      const a = this.findExisting(null, o.number, { source: 'auto' });
      if (a) {
        t = Object.assign({}, t);
        if (npAmountOnly() && a.amount) { t.amount = a.amount; t.amountSource = a.channel || 'авто-набір'; t.note = (t.note ? t.note + '; ' : '') + 'сума з авто-набору'; }
        if (!t.channel) t.channel = a.channel;
        if (!t.product) t.product = a.product;
        if (!t.date) t.date = a.date;
        if (!t.found && a.status) { t.found = true; t.status = a.status; }
      }
    }
    if (o.tableAmount > 0 && npAmountOnly()) t = Object.assign({}, t, { amount: o.tableAmount, amountSource: 'таблиця', note: (t.note ? t.note + '; ' : '') + 'сума з таблиці' });
    o.status = t.status;
    if (t.amount != null) o.amount = o.dup ? 0 : lib.round2(t.amount); // дубль ТТН: сума врахована в першому рядку
    if (t.channel) o.channel = t.channel;
    if (!o.product && t.product) o.product = t.product;
    if (withDate && t.date) o.date = t.date;
    if (t.ttn && !o.number) o.number = t.ttn; // ТТН з'явився в кабінеті після створення замовлення
    const src = t.orderId ? t : (t.mp && t.mp.orderId ? t.mp : null);
    if (src && !o.orderId) { o.orderId = String(src.orderId); o.kind = mp.MP_ORDER.includes(src.kind) ? src.kind : ''; }
    o.track = { checked: todayLocal(), note: t.note, problem: t.problem, np: t.np, mp: t.mp, rd: t.rd, amountSource: t.amount != null ? t.amountSource || '' : '' };
    // «Виконано» без суми (передплата на НП — накладеного платежу немає, а ніде більше суми немає) — не 0 у зарплату,
    // а «Немає даних»: людина впише суму (lib.statusDetail підкаже оголошену вартість НП).
    if (o.status === 'ok' && !o.dup && !(o.amount > 0)) { o.status = 'nodata'; o.track.noAmount = true; }
    return before.status !== o.status || before.amount !== o.amount || before.date !== o.date || before.channel !== o.channel || before.number !== o.number;
  }

  // Додати замовлення за номерами (ТТН, PRM-…, номер замовлення): статус, сума, дата, канал — з джерел.
  // Працівника вказувати не обов’язково: його визначає кабінет, який знайшов замовлення (ownerOf);
  // номери, чий власник не визначився, не додаються і повертаються в noEmployee.
  // Повтор за «працівник + номер» оновлюється, а не дублюється.
  // products: {номер → назва товару} (необов’язково, для вставки з таблиці).
  // Номери, які вводять руками або вставляють з таблиці, → набір manual.
  async addByTtn({ employee, employeeId, numbers, channel, product, products, source } = {}) {
    const ref = employeeId != null && employeeId !== '' ? employeeId : employee;
    const emp = ref != null && ref !== '' ? this.requireEmployee(ref) : null;
    source = source === 'auto' ? 'auto' : 'manual';
    const { results, errors } = await this.trackNumbers(numbers);
    // outcomes: номер → {outcome: added|updated|unchanged|noEmployee|notFound, id?} — що сталося з кожним номером
    const res = { added: 0, updated: 0, unchanged: 0, notFound: [], noAmount: [], noEmployee: [], errors, orders: [], outcomes: {} };
    for (const [number, t] of results) {
      const ownerId = emp ? emp.id : this.ownerOf(number, t, source);
      if (ownerId == null) { res.noEmployee.push(number); res.outcomes[number] = { outcome: 'noEmployee' }; continue; }
      if (!t.found) { res.notFound.push(number); }
      let o = this.findExisting(ownerId, number, { source, kind: t.mp && t.mp.kind, orderId: t.mp && t.mp.orderId });
      let outcome = 'added';
      if (o) { outcome = this.applyTracking(o, t) ? 'updated' : 'unchanged'; res[outcome]++; }
      else {
        if (!t.found && source !== 'manual') { res.outcomes[number] = { outcome: 'notFound' }; continue; } // рядок таблиці лишається й без даних (як «НЕТ ДАННЫХ» у таблиці)
        o = this.normalizeOrder({ employeeId: ownerId, number, source, product: (products && products[number]) || product || t.product, channel: channel || t.channel, status: t.status, amount: t.amount || 0, date: t.date || todayLocal() });
        o.id = this.store.nextId();
        this.applyTracking(o, t);
        this.data.orders.push(o);
        res.added++;
      }
      if (t.found && t.amount == null) res.noAmount.push(number);
      res.orders.push(o);
      res.outcomes[number] = { outcome, id: o.id };
    }
    this.store.save();
    return res;
  }

  // Перевірити наявні замовлення: за ids або за фільтрами listOrders. Замовлення без номера пропускаються.
  async refreshFromNp({ ids, employee, period, status, q, source, withDate } = {}) {
    const orders = Array.isArray(ids) && ids.length
      ? this.data.orders.filter((o) => ids.map(Number).includes(o.id))
      : this.listOrders({ employee, period, status, q, source });
    const res = { checked: 0, updated: 0, skipped: 0, notFound: [], errors: [], changes: [] };
    const withNumber = orders.filter((o) => o.number);
    res.skipped = orders.length - withNumber.length;
    if (!withNumber.length) return res;
    const { results, errors } = await this.trackNumbers(withNumber.map((o) => o.number));
    res.errors.push(...errors);
    for (const o of withNumber) {
      const t = results.get(o.number);
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
  // Вставлене → сітка клітинок. input: текст або {rows | html | text}: готові рядки клітинок; html-таблиця з буфера
  // (Google Таблиці, Excel: клітинка = клітинка); інакше текст із табуляціями (lib.splitPasted).
  pastedGrid(input) {
    const p = typeof input === 'string' ? { text: input } : (input || {});
    if (Array.isArray(p.rows)) return p.rows.map((r) => (Array.isArray(r) ? r : [r]).map((c) => String(c == null ? '' : c)));
    return lib.htmlTable(p.html) || lib.splitPasted(p.text);
  }

  // Рядки вставленого (товар, ТТН/номер, працівник, дата пакування — колонки в будь-якому порядку) →
  // [{row, cells, line, number, product, packDate, dupOf, employeeId|null, employee}]. Кожен непорожній рядок —
  // окремий запис (власник 2026-11-19: кількість у застосунку = кількості рядків таблиці): і без номера, і з повтором
  // номера (dupOf — № першого рядка з цим номером). Рядки без імені (employeeId null) отримують працівника від
  // запису в базі або кабінету, який знайде замовлення; employee — працівник для таких рядків, якщо його вказали.
  // Дата пакування в таблиці стоїть лише на першому рядку дня — далі береться з рядка вище.
  // Товар — перша текстова клітинка (без номера рядка, «Запаковано» й приміток). Порожній рядок не рахується, але номер рядка займає.
  parsePasted(input, employee) {
    const fallback = employee != null && employee !== '' ? this.requireEmployee(employee) : null;
    const items = [], firstRow = new Map(); // номер → № першого рядка з ним
    let packDate = '';
    this.pastedGrid(input).forEach((raw, idx) => {
      const cells = raw.map((c) => c.replace(/\s+/g, ' ').trim());
      if (!cells.some(Boolean)) return;
      const shown = raw.map((c) => c.replace(/\r/g, '').trim()); // для сітки у вікні: клітинка як у таблиці, з переносами
      let number = '', emp = null, date = '', empCol = -1, amount = 0;
      const rest = [];
      for (const [col, c] of cells.entries()) {
        if (!c) continue;
        const n = !number && mp.numberCell(c);
        if (n) { number = n; continue; }
        const d = !date && lib.sheetDate(c);
        if (d) { date = d; continue; }
        const e = !emp && !/^\d+$/.test(c) && this.resolveEmployee(c); // лише за ім’ям: «3» у колонці A — номер рядка, не id працівника
        if (e) { emp = e; empCol = col; continue; }
        // сума: «590», «1 089,00», «378 грн» — не в колонці A (там номер рядка); остання ненульова в рядку —
        // ціна, яку людина вписала поруч із «Сумою» 0, важливіша
        const a = col > 0 && /^\d{1,5}(?:[.,]\d{1,2})?$/.test(c.replace(/[\s\u00a0]|грн\.?$/g, '')) ? Number(c.replace(/[\s\u00a0]|грн\.?$/g, '').replace(',', '.')) : NaN;
        if (Number.isFinite(a)) { if (a > 0) amount = a; continue; }
        rest.push(c);
      }
      if (!number) {
        // код посилки (RMP-…, PRM-…) або 14-значний ТТН усередині тексту товару
        for (let i = 0; i < rest.length && !number; i++) {
          const code = (rest[i].match(/\d{14}/) || [])[0] || mp.parcelCodes(rest[i])[0];
          if (code) { number = code; rest[i] = rest[i].replace(/[A-Z]{2,4}[-\s]?\d{6,}|\d{14}/i, '').replace(/\s+/g, ' ').trim(); }
        }
      }
      if (date) packDate = date;
      const it = { row: idx + 1, cells: shown, line: cells.filter(Boolean).join(' | '), number, product: rest.find((c) => /\p{L}/u.test(c)) || '',
        packDate, amount, dupOf: 0, employeeId: emp ? emp.id : null, employee: emp ? emp.name : '', empCol, raw: cells };
      if (number && firstRow.has(number)) it.dupOf = firstRow.get(number);
      else if (number) firstRow.set(number, it.row);
      items.push(it);
    });
    // Колонка працівника — та, де ім’я знайшлося найчастіше. Інше ім’я в ній (Корнійчук, Гаєвська…) — працівник, якого
    // немає в застосунку: рядок не записується, щоб кабінет не приписав його Насті чи Товкес.
    const cols = new Map();
    for (const it of items) if (it.empCol >= 0) cols.set(it.empCol, (cols.get(it.empCol) || 0) + 1);
    const empCol = [...cols].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const it of items) {
      const other = it.employeeId == null && empCol != null ? it.raw[empCol] || '' : '';
      if (other && /\p{L}/u.test(other) && other !== it.product) it.reason = SKIP.otherEmployee(other);
      else if (it.employeeId == null && fallback) Object.assign(it, { employeeId: fallback.id, employee: fallback.name });
      else if (it.employeeId == null && !it.number) it.reason = SKIP.empty; // лише номер рядка чи «Запаковано» — записувати нічого
      delete it.raw; delete it.empCol;
    }
    return items;
  }

  // Чий запис у ручному наборі відповідає кожному рядку (it.order) — щоб повторна вставка того самого діапазону
  // не подвоювала записи: рядок з номером — запис із тим самим номером (повтори номера — за порядком), рядок без
  // номера — запис без номера з тим самим працівником і товаром. Запис, уже взятий іншим рядком, не береться.
  // Неправильний рядок бере лише неправильний запис.
  matchPasted(items, index = this.orderIndex()) {
    const manual = this.data.orders.filter((o) => o.source === 'manual').sort((a, b) => a.id - b.id);
    const byNumber = new Map(), byProduct = new Map(), taken = new Set();
    const productKey = (empId, product) => `${empId}|${String(product || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const push = (map, k, o) => { if (!map.has(k)) map.set(k, []); map.get(k).push(o); };
    for (const o of manual) {
      if (o.number) push(byNumber, o.number, o);
      else if (!o.orderId) push(byProduct, o.invalid ? `!|${o.product}` : productKey(o.employeeId, o.product), o);
    }
    const free = (list, ok = () => true) => (list || []).find((o) => !taken.has(o.id) && ok(o));
    for (const it of items) {
      let o = null;
      if (it.reason) { // неправильний рядок — лише свій же неправильний запис (за номером або текстом рядка)
        // і за товаром: у вивантаженій з застосунку таблиці товар неправильного запису — це текст рядка першої вставки
        o = it.number ? free(byNumber.get(it.number), (x) => x.invalid) : free(byProduct.get(`!|${it.line}`)) || free(byProduct.get(`!|${it.product}`));
        if (o) taken.add(o.id);
        it.order = o;
        continue;
      }
      const mine = (x) => it.employeeId == null || x.employeeId === it.employeeId;
      if (it.number) {
        const list = byNumber.get(it.number);
        o = free(list, mine) || free(list);
        if (!o) { const f = this.findExisting(it.employeeId, it.number, { source: 'manual', index }); if (f && !taken.has(f.id)) o = f; }
      }
      if (!o && it.employeeId != null) o = free(byProduct.get(productKey(it.employeeId, it.product))); // і рядок, якому дописали ТТН
      if (o) taken.add(o.id);
      it.order = o;
    }
    return items;
  }

  // Місяць вкладки таблиці, з якої вставлено: найчастіший місяць дат пакування; без дат (скопійовано лише «товар, ТТН») —
  // найчастіший місяць наявних записів цих рядків; інакше '' (місяць за датою замовлення).
  pastedMonth(items) {
    const top = (months) => {
      const count = new Map();
      for (const m of months) if (m) count.set(m, (count.get(m) || 0) + 1);
      return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    };
    return top(items.map((it) => it.packDate.slice(0, 7))) || top(items.map((it) => it.order && lib.orderMonth(it.order)));
  }

  // Звірка для відповіді: total = counted + skipped.length; rows — сітка для вікна (рядок як у вставленому плюс
  // номер, працівник, сума, статус і стан: new / existing — у перегляді, added / updated / unchanged — після запису,
  // skip — не записано). Лічильники рахуються з цих самих рядків. orderOf(рядок) — запис, з якого взяти суму й статус.
  pastedReport(items, orderOf, month) {
    if (!items.length) throw new ApiError(400, 'Порожній текст');
    const rows = items.map((it) => {
      const o = orderOf(it);
      const owner = it.employee || (o && (this.resolveEmployee(o.employeeId) || {}).name) || '';
      // працівник рядка без імені до запису — лише припущення з бази: остаточно його визначить кабінет
      return { row: it.row, cells: it.cells, number: it.number, dupOf: it.dupOf, state: it.outcome || (it.order ? 'existing' : 'new'), reason: it.reason || '',
        employee: owner, employeeGuess: !it.employee && !it.outcome && !!owner, amount: o && (o.amount > 0 || it.outcome) ? o.amount : it.amount || (o ? o.amount : null), status: o ? o.status : (it.number ? '' : 'nodata'),
        statusLabel: o ? lib.statusLabel(o.status, o.track) : (it.number ? '' : lib.STATUS.nodata) };
    });
    const count = (state) => rows.filter((r) => r.state === state).length;
    // invalid — неправильні рядки: теж записуються (з позначкою), тож counted = total
    const invalid = items.filter((it) => it.reason).map((it) => Object.assign({ row: it.row, line: it.line, reason: it.reason }, it.number ? { number: it.number } : {}));
    return { total: rows.length, counted: rows.length, month, new: count('new'), existing: count('existing'),
      added: count('added'), updated: count('updated'), unchanged: count('unchanged'), duplicates: items.filter((it) => it.dupOf).length, invalid, rows };
  }

  // Попередній перегляд без запису й без запитів у мережу: що розпізнано в кожному рядку і чи є вже такий запис.
  // Сума й статус — із запису в ручному наборі, інакше з авто-набору за номером.
  previewPasted(input, employee) {
    const index = this.orderIndex(); // сотні рядків × тисячі замовлень: без індексу вікно завмирало б на секунди
    const items = this.matchPasted(this.parsePasted(input, employee), index);
    const month = input && input.month != null ? (isMonth(input.month) ? input.month : '') : this.pastedMonth(items);
    return this.pastedReport(items, (it) => it.order || (it.number && !it.reason ? this.findExisting(null, it.number, { source: 'auto', index }) : null), month);
  }

  // Записати вставлене: кожен рядок — свій запис у ручному наборі (month — місяць вкладки). Не записується лише рядок,
  // працівника якого не визначити (немає імені, запису в базі й кабінету, що знайшов би замовлення).
  // Відповідь — та сама звірка, що й у перегляді, з результатом кожного рядка, плюс notFound, noAmount, errors.
  async addPasted(input, employee) {
    const items = this.matchPasted(this.parsePasted(input, employee));
    const month = input && input.month != null ? (isMonth(input.month) ? input.month : '') : this.pastedMonth(items);
    // Дубль ТТН — за всім ручним набором, не лише цією вставкою: перший запис з номером рахує суму, решта — з сумою 0.
    const firstId = new Map();
    for (const o of this.data.orders) if (o.source === 'manual' && o.number && !(firstId.get(o.number) < o.id)) firstId.set(o.number, o.id);
    const dupOf = (o, number) => { const f = number && firstId.get(number); return f && f !== o.id ? f : 0; };
    const numbers = [...new Set(items.map((it) => it.number).filter(Boolean))];
    const { results, errors } = numbers.length ? await this.trackNumbers(numbers) : { results: new Map(), errors: [] };
    const res = { notFound: [], noAmount: [], errors };
    for (const it of items) {
      const t = it.number ? results.get(it.number) : null;
      const empId = it.reason ? null : it.employeeId != null ? it.employeeId : it.order ? it.order.employeeId : t ? this.ownerOf(it.number, t, 'manual') : null;
      if (empId == null && !it.reason) it.reason = SKIP.noEmployee;
      // Неправильний рядок теж записується (власник 2026-11-19: «не прибирати, а так і написати»): без працівника, «Немає даних».
      const invalid = it.reason || '';
      let o = it.order;
      if (o) {
        const before = JSON.stringify([o.employeeId, o.month, o.dup, o.product, o.status, o.amount, o.channel, o.invalid, o.tableAmount]);
        Object.assign(o, { employeeId: empId, month: month || o.month, pasted: true, dup: dupOf(o, o.number), invalid });
        if (it.amount) o.tableAmount = it.amount;
        if (it.amount && !t && !o.dup) {
          o.amount = it.amount;
          if (o.status === 'nodata' && o.track && o.track.noAmount) { o.status = 'ok'; o.track.noAmount = false; } // суму вписали в таблиці
        }
        // назва з таблиці головна (власник 2026-11-21): опис посилки НП («Розетка») чи назва з кабінету — лише коли своєї немає
        if (it.product && !invalid) o.product = it.product;
        if (t) this.applyTracking(o, t);
        if (o.dup) o.amount = 0;
        it.outcome = before === JSON.stringify([o.employeeId, o.month, o.dup, o.product, o.status, o.amount, o.channel, o.invalid, o.tableAmount]) ? 'unchanged' : 'updated';
      } else {
        o = this.normalizeOrder({ employeeId: empId, number: it.number, source: 'manual', product: invalid && !it.number ? it.line : it.product || (t && t.product), channel: t && t.channel,
          status: t ? t.status : 'nodata', amount: t ? 0 : it.amount, tableAmount: it.amount, date: (t && t.date) || it.packDate || todayLocal(), month, pasted: true, invalid });
        o.id = this.store.nextId();
        o.dup = dupOf(o, o.number);
        if (o.number && !firstId.has(o.number)) firstId.set(o.number, o.id);
        if (t) this.applyTracking(o, t);
        this.data.orders.push(o);
        it.outcome = 'added';
      }
      it.order = o;
      if (t && !t.found) res.notFound.push(it.number);
      if (t && t.found && t.amount == null) res.noAmount.push(it.number);
    }
    this.store.save();
    return Object.assign(res, this.pastedReport(items, (it) => it.order, month));
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
        const number = it.ttn || ''; // без ТТН (ще не відправлено або скасовано) — номер порожній, є лише № замовлення
        const c = combine(number || it.orderId, npFound.get(it.ttn), it, rdFound.get(mp.rozetkaDeliveryId(it.ttn)));
        const existing = this.findExisting(e.id, number, { kind: it.kind, orderId: it.orderId, source: 'auto' });
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
      const number = String(it.number || it.ttn || '').trim(), orderId = String(it.orderId || '').trim();
      if (!emp || (!number && !orderId)) continue;
      const t = { status: lib.STATUS[it.status] ? it.status : 'checking', amount: it.amount == null ? null : Number(it.amount), channel: it.channel, product: it.product, date: it.date, note: it.note || '', problem: it.problem || '', np: it.track && it.track.np, mp: it.track && it.track.mp, rd: it.track && it.track.rd, ttn: number, orderId, kind: it.kind };
      let o = this.findExisting(emp.id, number, { kind: it.kind, orderId, source: 'auto' });
      if (o) { if (this.applyTracking(o, t, { withDate: true })) updated++; }
      else {
        o = this.normalizeOrder({ employeeId: emp.id, number, orderId, kind: it.kind, source: 'auto', product: it.product, channel: it.channel, status: t.status, amount: t.amount || 0, date: it.date });
        o.id = this.store.nextId();
        this.applyTracking(o, t);
        this.data.orders.push(o);
        added++;
      }
    }
    this.store.save();
    return { added, updated };
  }

  // ---------- автоматичне оновлення ----------
  // Поточний і попередній місяць: зібрати відправлення з кабінетів кожного працівника й додати
  // в замовлення, потім перевірити незавершені (checking: в дорозі, в обробці, ще не перевірені). Паралельні запуски не допускаються.
  async autoSync() {
    if (this.syncing) return { skipped: true, message: 'Уже виконується' };
    this.syncing = true;
    const res = { collected: 0, added: 0, updated: 0, checked: 0, changed: 0, errors: [], months: [] };
    try {
      const d = new Date();
      const cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      d.setMonth(d.getMonth() - 1);
      const prev = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      res.months = [prev, cur];
      for (const period of res.months) {
        for (const e of this.data.employees) {
          if (!this.accountsFor(e.id).some((a) => a.kind !== 'np')) continue;
          try {
            const c = await this.collectShipments({ employee: e.id, period });
            res.collected += c.items.length;
            res.errors.push(...c.errors);
            const a = this.addShipments(c.items);
            res.added += a.added; res.updated += a.updated;
          } catch (err) { res.errors.push(`${e.name} ${period}: ${err.message || err}`); }
        }
        try {
          // «Немає даних» через невідправлену накладну НП (код 1) теж перевіряється: посилку можуть відправити пізніше.
          const ids = this.listOrders({ period, source: 'auto' })
            .filter((o) => o.status === 'checking' || (o.status === 'nodata' && o.track && o.track.np && o.track.np.code === '1'))
            .map((o) => o.id);
          const r = ids.length ? await this.refreshFromNp({ ids }) : { checked: 0, updated: 0, errors: [] };
          res.checked += r.checked; res.changed += r.updated; res.errors.push(...r.errors);
        } catch (err) { res.errors.push(`перевірка ${period}: ${err.message || err}`); }
      }
    } finally {
      this.syncing = false;
      const when = new Date();
      const stamp = `${todayLocal()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      this.data.settings.auto.lastRun = stamp;
      this.data.settings.auto.lastResult = `зібрано ${res.collected}, додано ${res.added}, оновлено ${res.updated + res.changed}` + (res.errors.length ? `, помилок ${res.errors.length}` : '');
      this.store.save();
    }
    return res;
  }

  // ---------- розрахунок і експорт ----------
  // source: 'auto' | 'manual'; без нього — набір із налаштувань (типово auto).
  salarySource(source) {
    if (source && !lib.SOURCE[source]) throw new ApiError(400, 'source має бути auto або manual');
    return source || this.data.settings.salarySource || 'auto';
  }
  salary(period, source) {
    if (period && !isMonth(period)) throw new ApiError(400, 'Період має бути у форматі YYYY-MM');
    source = this.salarySource(source);
    const rows = lib.calcSalary(this.data, period || '', source);
    const totals = rows.reduce((a, s) => ({ total: a.total + s.total, done: a.done + s.done, sumDone: lib.round2(a.sumDone + s.sumDone), salary: lib.round2(a.salary + s.salary) }),
      { total: 0, done: 0, sumDone: 0, salary: 0 });
    return { period: period || '', source, ratePercent: this.data.settings.ratePercent, rows, totals };
  }

  // Список замовлень (набір + фільтри, як у вкладці) одним аркушем.
  // Аркуші замовлень для XLSX (власник 2026-11-19): усі, відміни (відмова, повернення, скасовано), виконані, немає даних,
  // понад 5000 грн (будь-який статус). Порядок рядків — lib.orderCompare. rows — перший аркуш (усі): він же й CSV.
  orderSheets(orders) {
    const byId = new Map(this.data.employees.map((e) => [e.id, e.name]));
    const sorted = [...orders].sort(lib.orderCompare((id) => byId.get(id)));
    const table = (list) => [['Дата', 'Працівник', 'Товар', 'ТТН', '№ замовлення', 'Сума', 'Канал', 'Статус', 'Деталі'],
      ...list.map((o) => [o.date, byId.get(o.employeeId) || '', o.product, o.number, o.orderId || '', o.amount, o.channel, lib.statusLabel(o.status, o.track), lib.statusDetail(o.track, o)])];
    return [
      { name: 'Усі замовлення', rows: table(sorted) },
      { name: 'Відміни', rows: table(sorted.filter((o) => o.status === 'refused' || o.status === 'cancelled')) },
      { name: 'Виконані', rows: table(sorted.filter((o) => o.status === 'ok')) },
      { name: 'Немає даних', rows: table(sorted.filter((o) => o.status === 'nodata')) },
      { name: 'Більше 5000 грн', rows: table(sorted.filter((o) => Number(o.amount) > 5000)) },
    ];
  }

  exportOrdersBuffer(format, filters = {}) {
    const orders = this.listOrders(filters);
    const sheets = this.orderSheets(orders), rows = sheets[0].rows;
    const source = filters.source ? (filters.source === 'auto' ? 'авто' : 'таблиця') : 'усі';
    const filename = `замовлення-${source}-${filters.period || 'увесь-час'}.${format}`;
    if (format === 'xlsx') return { filename, buffer: lib.buildXlsx(sheets), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', count: orders.length };
    if (format === 'csv') return { filename, buffer: Buffer.from(lib.toCsv(rows), 'utf8'), contentType: 'text/csv; charset=utf-8', count: orders.length };
    throw new ApiError(400, 'Формат має бути xlsx або csv');
  }

  exportBuffer(format, period, source) {
    source = this.salarySource(source);
    const { rows: summary, totals } = this.salary(period, source);
    const head = ['Працівник', 'Ставка, %', 'Замовлень', 'Виконано', 'Відмови', 'Скасовано', 'Немає даних', lib.CHECKING_GROUP, 'Сума виконаних', 'Зарплата'];
    const sRows = [head, ...summary.map((s) => [s.name, s.ratePercent, s.total, s.done, s.refused, s.cancelled, s.nodata, s.checking, s.sumDone, s.salary])];
    sRows.push(['Разом', '', totals.total, totals.done, '', '', '', '', totals.sumDone, totals.salary]);
    const sheets = this.orderSheets(this.listOrders({ period, source })), oRows = sheets[0].rows;
    const filename = `зарплата-${source === 'auto' ? 'авто' : 'таблиця'}-${period || 'увесь-час'}.${format}`;
    if (format === 'xlsx') return { filename, buffer: lib.buildXlsx([{ name: 'Зарплата', rows: sRows }, ...sheets]), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
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
    this.data.orders = d.orders.filter((o) => ids.has(Number(o.employeeId)) || (o.invalid && o.employeeId == null)).map((o) => this.normalizeOrder(Object.assign({ source: 'auto' }, o))).map((o) => (o.id ? o : Object.assign(o, { id: this.store.nextId() })));
    const maxId = Math.max(999, ...this.data.employees.map((e) => e.id), ...this.data.orders.map((o) => o.id));
    if (this.data.nextId <= maxId) this.data.nextId = maxId + 1;
    this.migrateNumbers();
    this.store.save();
    return { employees: this.data.employees.length, orders: this.data.orders.length };
  }
}

module.exports = { Service, ApiError, todayLocal };
