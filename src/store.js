'use strict';
// Зберігання даних застосунку: один JSON-файл у теці користувача
// (Windows: %APPDATA%\Розрахунок зарплат\data.json, macOS: ~/Library/Application Support/…).
const fs = require('fs');
const path = require('path');
const { DEFAULT_EMPLOYEES } = require('./lib');

function defaultApi() { return { enabled: true, host: '127.0.0.1', port: 8765, token: '' }; }
function defaultNp() { return { apiKey: '' }; }

function emptyData() {
  return {
    version: 1,
    settings: { ratePercent: 5, sheetUrls: [], api: defaultApi(), np: defaultNp() },
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
      settings.np = Object.assign(defaultNp(), settings.np || {});
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
