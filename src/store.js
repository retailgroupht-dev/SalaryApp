'use strict';
// Зберігання даних застосунку: один JSON-файл у теці користувача
// (Windows: %APPDATA%\SalaryApp\data.json, macOS: ~/Library/Application Support/SalaryApp/…).
const fs = require('fs');
const path = require('path');
const { DEFAULT_EMPLOYEES } = require('./lib');

function defaultApi() { return { enabled: true, host: '127.0.0.1', port: 8765, token: '' }; }
// Кабінети: [{kind: np|prom|rozetka|epicentr, name, token}].
function defaultAccounts() { return []; }
// Автоматичне оновлення: збір відправлень з кабінетів і перевірка статусів кожні hours годин.
function defaultAuto() { return { enabled: true, hours: 6, lastRun: '', lastResult: '' }; }

function emptyData() {
  return {
    version: 1,
    settings: { ratePercent: 5, salarySource: 'auto', api: defaultApi(), accounts: defaultAccounts(), auto: defaultAuto() },
    employees: DEFAULT_EMPLOYEES.map((name, i) => ({ id: i + 1, name, ratePercent: null })),
    orders: [],
    nextId: 1000,
  };
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'data.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const d = JSON.parse(raw);
      const base = emptyData();
      const settings = Object.assign(base.settings, d.settings || {});
      settings.api = Object.assign(defaultApi(), settings.api || {});
      settings.accounts = Array.isArray(settings.accounts) ? settings.accounts : defaultAccounts();
      settings.auto = Object.assign(defaultAuto(), settings.auto || {});
      // Старе поле settings.np.apiKey → перший кабінет Нової Пошти.
      if (settings.np && settings.np.apiKey && !settings.accounts.some((a) => a.kind === 'np')) settings.accounts.push({ kind: 'np', name: 'НП 1', token: String(settings.np.apiKey) });
      delete settings.np;
      return {
        version: 1,
        settings,
        employees: Array.isArray(d.employees) ? d.employees : base.employees,
        orders: Array.isArray(d.orders) ? d.orders : [],
        nextId: Number(d.nextId) || 1000,
      };
    } catch (e) {
      return emptyData();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  nextId() { return this.data.nextId++; }
}

module.exports = { Store, emptyData };
