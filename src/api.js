'use strict';
// Локальний HTTP API застосунку (JSON). Запускається з налаштувань: host, port, ключ.
// Якщо ключ задано, кожен запит має нести Authorization: Bearer <ключ>, X-Api-Key або ?key=.
const http = require('http');
const { ApiError } = require('./service');
const { buildDocs } = require('./api-docs');

const MAX_BODY = 50 * 1024 * 1024;

const ROUTES_DOC = [
  ['GET', '/api/health', 'стан: версія, кількість працівників і замовлень'],
  ['GET', '/api/salary?period=YYYY-MM', 'розрахунок зарплати (без period — за весь час)'],
  ['GET', '/api/employees', 'список працівників'],
  ['POST', '/api/employees', '{name, ratePercent?} — додати працівника'],
  ['DELETE', '/api/employees/:id', 'видалити працівника разом із його замовленнями'],
  ['GET', '/api/orders?employee=&period=&status=&q=', 'замовлення з фільтрами (employee — id або ім’я)'],
  ['POST', '/api/orders', 'об’єкт або масив {employee|employeeId, number, amount, product?, channel?, status?, date?}; без id — злиття за номером'],
  ['DELETE', '/api/orders/:id', 'видалити замовлення'],
  ['POST', '/api/import', '{employee, url} або {employee, csv, date?, defaultStatus?} — імпорт аркуша'],
  ['GET', '/api/track?numbers=a,b', 'пошук за номерами (НП + маркетплейси) без запису в базу'],
  ['POST', '/api/track', '{employee, numbers: [...] | "…", channel?} — додати/оновити замовлення за номерами'],
  ['POST', '/api/track/refresh', '{ids?} або {employee?, period?, status?, q?}, withDate? — перевірити наявні замовлення'],
  ['GET', '/api/export?format=xlsx|csv&period=', 'файл розрахунку'],
  ['GET', '/api/data', 'уся база (резервна копія JSON)'],
  ['PUT', '/api/data', 'замінити базу даними з резервної копії'],
  ['GET', '/api/settings', 'налаштування'],
  ['PUT', '/api/settings', '{ratePercent?, accounts?: [{kind, name, token}]} — ставка, кабінети'],
  ['POST', '/api/settings/accounts/import', '{script} — ключі з тексту Apps Script таблиці'],
  ['GET', '/api/settings/accounts/test', 'перевірити всі кабінети'],
  ['GET', '/api/docs', 'ця документація у Markdown (?download=1 — як файл)'],
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'Завеликий запит')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createApi(service, appInfo) {
  let server = null;
  let current = null; // {host, port}
  let lastError = '';

  function send(res, status, body, headers) {
    const h = Object.assign({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' }, headers || {});
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    if (!Buffer.isBuffer(body)) h['Content-Type'] = 'application/json; charset=utf-8';
    h['Content-Length'] = buf.length;
    res.writeHead(status, h);
    res.end(buf);
  }

  function authorized(req, url) {
    const token = (service.data.settings.api || {}).token;
    if (!token) return true;
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || url.searchParams.get('key') || '');
    return given === token;
  }

  async function handle(req, res) {
    // Некодована кирилиця в адресі (старіші Node приймають її як latin1-байти) — повертаємо UTF-8;
    // новіші Node відповідають 400 ще до нас, тож у запитах краще кодувати параметри.
    const rawUrl = /[\x80-\xff]/.test(req.url) ? Buffer.from(req.url, 'latin1').toString('utf8') : req.url;
    const url = new URL(rawUrl, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    try {
      if (m === 'OPTIONS') return send(res, 204, Buffer.alloc(0));
      if (!p.startsWith('/api')) return send(res, 404, { error: 'Невідомий шлях', routes: ROUTES_DOC });
      if (!authorized(req, url)) return send(res, 401, { error: 'Потрібен ключ API (Authorization: Bearer …)' });
      const q = Object.fromEntries(url.searchParams);
      const body = (m === 'POST' || m === 'PUT') ? (await readBody(req)) : '';
      const json = () => { if (!body.trim()) return {}; try { return JSON.parse(body); } catch (e) { throw new ApiError(400, 'Тіло запиту має бути JSON'); } };

      if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, version: appInfo.version, employees: service.data.employees.length, orders: service.data.orders.length, routes: ROUTES_DOC });
      if (m === 'GET' && p === '/api/salary') return send(res, 200, service.salary(q.period || ''));
      if (m === 'GET' && p === '/api/employees') return send(res, 200, service.data.employees);
      if (m === 'POST' && p === '/api/employees') { const b = json(); return send(res, 201, service.addEmployee(b.name, b.ratePercent)); }
      let mm;
      if (m === 'DELETE' && (mm = /^\/api\/employees\/(\d+)$/.exec(p))) { service.deleteEmployee(mm[1]); return send(res, 200, { ok: true }); }
      if (m === 'GET' && p === '/api/orders') return send(res, 200, service.listOrders(q));
      if (m === 'POST' && p === '/api/orders') { const b = json(); return send(res, 200, service.mergeOrders(Array.isArray(b) ? b : [b])); }
      if (m === 'DELETE' && (mm = /^\/api\/orders\/(\d+)$/.exec(p))) return send(res, 200, service.deleteOrders([mm[1]]));
      if (m === 'GET' && p === '/api/track') {
        const { results, errors } = await service.trackNumbers(q.numbers || q.number || '');
        return send(res, 200, { results: [...results.values()], errors });
      }
      if (m === 'POST' && p === '/api/track') return send(res, 200, await service.addByTtn(json()));
      if (m === 'POST' && p === '/api/track/refresh') return send(res, 200, await service.refreshFromNp(json()));
      if (m === 'POST' && p === '/api/import') {
        const b = json();
        if (b.url) return send(res, 200, await service.importFromUrl(b.url, b));
        if (typeof b.csv === 'string') return send(res, 200, service.importCsvText(b.csv, b));
        throw new ApiError(400, 'Потрібно url або csv');
      }
      if (m === 'GET' && p === '/api/export') {
        const f = service.exportBuffer(q.format || 'xlsx', q.period || '');
        return send(res, 200, f.buffer, { 'Content-Type': f.contentType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}` });
      }
      if (m === 'GET' && p === '/api/data') return send(res, 200, service.data);
      if (m === 'PUT' && p === '/api/data') return send(res, 200, service.replaceData(json()));
      if (m === 'GET' && p === '/api/docs') {
        const md = docs(req.headers.host);
        const h = { 'Content-Type': 'text/markdown; charset=utf-8' };
        if (q.download) h['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent('SalaryApp-API.md')}`;
        return send(res, 200, Buffer.from(md, 'utf8'), h);
      }
      if (m === 'GET' && p === '/api/settings') return send(res, 200, service.data.settings);
      if (m === 'PUT' && p === '/api/settings') { const b = json(); return send(res, 200, service.saveSettings({ ratePercent: b.ratePercent, accounts: b.accounts })); }
      if (m === 'POST' && p === '/api/settings/accounts/import') return send(res, 200, service.importAccountsFromScript((json() || {}).script));
      if (m === 'GET' && p === '/api/settings/accounts/test') return send(res, 200, await service.testAccounts());
      return send(res, 404, { error: 'Невідомий маршрут', routes: ROUTES_DOC });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      send(res, status, { error: e.message || String(e) });
    }
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server; server = null; current = null;
      s.close(() => resolve());
      s.closeAllConnections && s.closeAllConnections();
    });
  }

  function start(cfg) {
    return new Promise((resolve) => {
      lastError = '';
      const s = http.createServer(handle);
      s.on('error', (e) => { lastError = e.code === 'EADDRINUSE' ? `Порт ${cfg.port} зайнятий` : e.message; server = null; current = null; resolve(status()); });
      s.listen(cfg.port, cfg.host, () => { server = s; current = { host: cfg.host, port: s.address().port }; resolve(status()); });
    });
  }

  // Застосувати налаштування: перезапустити, якщо змінились, або зупинити.
  async function apply(cfg) {
    cfg = Object.assign({ enabled: false, host: '127.0.0.1', port: 8765 }, cfg || {});
    await stop();
    if (cfg.enabled) await start(cfg);
    return status();
  }

  function status() {
    return { running: !!server, host: current && current.host, port: current && current.port, url: current ? `http://${current.host}:${current.port}` : '', error: lastError, routes: ROUTES_DOC };
  }

  // Документація з актуальною адресою й ключем. hostHeader — з запиту (щоб у прикладах була адреса, якою звернулись).
  function docs(hostHeader) {
    const a = service.data.settings.api || {};
    const base = hostHeader ? `http://${hostHeader}` : (status().url || `http://${a.host || '127.0.0.1'}:${a.port || 8765}`);
    return buildDocs({ base, token: a.token || '', version: appInfo.version });
  }

  return { apply, stop, status, handle, docs };
}

module.exports = { createApi, ROUTES_DOC };
