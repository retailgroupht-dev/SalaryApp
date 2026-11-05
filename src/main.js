'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const lib = require('./lib');
const { Store } = require('./store');

let win = null;
let store = null;
let autoUpdater = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Розрахунок зарплат',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  // Перевірочний запуск без людини: SALARY_SMOKE_SHOT=<png> — знімок вікна й вихід.
  if (process.env.SALARY_SMOKE_SHOT) {
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const shot = async (file) => fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        await shot(process.env.SALARY_SMOKE_SHOT);
        await win.webContents.executeJavaScript("document.querySelector('[data-tab=orders]').click()");
        await new Promise((r) => setTimeout(r, 500));
        await shot(process.env.SALARY_SMOKE_SHOT.replace(/\.png$/, '') + '-orders.png');
        console.log('smoke: знімки збережено');
      } catch (e) { console.log('smoke: помилка', e.message); }
      app.quit();
    }, 2000));
  }
}

function sendUpdate(status, extra) {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', Object.assign({ status }, extra || {}));
}

function setupUpdater() {
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-available', (info) => sendUpdate('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdate('none'));
  autoUpdater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdate('downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => sendUpdate('error', { message: String(err && err.message || err) }));
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Редагування', submenu: [{ role: 'undo', label: 'Скасувати' }, { role: 'redo', label: 'Повторити' }, { type: 'separator' },
      { role: 'cut', label: 'Вирізати' }, { role: 'copy', label: 'Копіювати' }, { role: 'paste', label: 'Вставити' }, { role: 'selectAll', label: 'Вибрати все' }] },
    { label: 'Вигляд', submenu: [{ role: 'reload', label: 'Перезавантажити' }, { role: 'toggleDevTools', label: 'Інструменти розробника' }, { type: 'separator' },
      { role: 'resetZoom', label: 'Звичайний масштаб' }, { role: 'zoomIn', label: 'Збільшити' }, { role: 'zoomOut', label: 'Зменшити' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'На весь екран' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} при завантаженні таблиці`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error('Google повернув сторінку входу: відкрийте доступ «усім, хто має посилання»');
  return res.text();
}

function registerIpc() {
  ipcMain.handle('data:get', () => store.data);

  ipcMain.handle('settings:save', (_e, settings) => {
    store.data.settings = Object.assign({}, store.data.settings, settings);
    store.save();
    return store.data.settings;
  });

  ipcMain.handle('employees:save', (_e, employees) => {
    const seen = new Set();
    const clean = [];
    for (const e of employees) {
      const name = String(e.name || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const rate = e.ratePercent === '' || e.ratePercent == null ? null : Number(e.ratePercent);
      clean.push({ id: Number(e.id) || store.nextId(), name, ratePercent: Number.isFinite(rate) ? rate : null });
    }
    const ids = new Set(clean.map((e) => e.id));
    store.data.employees = clean;
    store.data.orders = store.data.orders.filter((o) => ids.has(o.employeeId));
    store.save();
    return store.data;
  });

  ipcMain.handle('orders:save', (_e, order) => {
    const o = {
      id: Number(order.id) || store.nextId(),
      employeeId: Number(order.employeeId),
      product: String(order.product || '').trim(),
      number: String(order.number || '').trim(),
      amount: lib.round2(Number(order.amount) || 0),
      channel: String(order.channel || '').trim(),
      status: lib.STATUS[order.status] ? order.status : 'checking',
      date: /^\d{4}-\d{2}-\d{2}$/.test(order.date || '') ? order.date : todayLocal(),
    };
    const i = store.data.orders.findIndex((x) => x.id === o.id);
    if (i >= 0) store.data.orders[i] = o; else store.data.orders.push(o);
    store.save();
    return store.data;
  });

  ipcMain.handle('orders:delete', (_e, ids) => {
    const set = new Set(ids.map(Number));
    store.data.orders = store.data.orders.filter((o) => !set.has(o.id));
    store.save();
    return store.data;
  });

  async function importCsvText(text, employeeId, date, defaultStatus) {
    const rows = lib.parseCsv(text);
    const incoming = lib.importRows(rows, { employeeId: Number(employeeId), date: date || todayLocal(), defaultStatus });
    const r = lib.mergeOrders(store.data.orders, incoming, () => store.nextId());
    store.data.orders = r.orders;
    store.save();
    return { added: r.added, updated: r.updated, parsed: incoming.length, data: store.data };
  }

  ipcMain.handle('import:url', async (_e, { url, employeeId, date, defaultStatus }) => {
    const exportUrl = lib.sheetExportUrl(url);
    if (!exportUrl) throw new Error('Це не посилання на Google Таблицю');
    const text = await fetchText(exportUrl);
    const res = await importCsvText(text, employeeId, date, defaultStatus);
    const urls = (store.data.settings.sheetUrls || []).filter((u) => u.employeeId !== Number(employeeId));
    urls.push({ employeeId: Number(employeeId), url });
    store.data.settings.sheetUrls = urls;
    store.save();
    return res;
  });

  ipcMain.handle('import:file', async (_e, { employeeId, date, defaultStatus }) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Оберіть CSV-файл (експорт аркуша «Лист2»)',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    return importCsvText(text, employeeId, date, defaultStatus);
  });

  ipcMain.handle('export:file', async (_e, { format, period }) => {
    const label = period || 'увесь-час';
    const r = await dialog.showSaveDialog(win, {
      title: 'Зберегти розрахунок',
      defaultPath: `зарплата-${label}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return null;
    const summary = lib.calcSalary(store.data, period);
    const head = ['Працівник', 'Ставка, %', 'Замовлень', 'Виконано', 'Відмови', 'Скасовано', 'Немає даних', 'Перевіряється', 'Сума виконаних', 'Зарплата'];
    const sRows = [head, ...summary.map((s) => [s.name, s.ratePercent, s.total, s.done, s.refused, s.cancelled, s.nodata, s.checking, s.sumDone, s.salary])];
    sRows.push(['Разом', '', summary.reduce((a, s) => a + s.total, 0), summary.reduce((a, s) => a + s.done, 0), '', '', '', '',
      lib.round2(summary.reduce((a, s) => a + s.sumDone, 0)), lib.round2(summary.reduce((a, s) => a + s.salary, 0))]);
    const byId = new Map(store.data.employees.map((e) => [e.id, e.name]));
    const orders = store.data.orders
      .filter((o) => !period || lib.monthOf(o.date) === period)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    const oRows = [['Дата', 'Працівник', 'Товар', 'Номер', 'Сума', 'Канал', 'Статус'],
      ...orders.map((o) => [o.date, byId.get(o.employeeId) || '', o.product, o.number, o.amount, o.channel, lib.STATUS[o.status] || o.status])];
    if (format === 'xlsx') {
      fs.writeFileSync(r.filePath, lib.buildXlsx([{ name: 'Зарплата', rows: sRows }, { name: 'Замовлення', rows: oRows }]));
    } else {
      fs.writeFileSync(r.filePath, lib.toCsv([...sRows, [], ...oRows]), 'utf8');
    }
    return r.filePath;
  });

  ipcMain.handle('update:check', async () => {
    if (!autoUpdater) return { status: 'error', message: 'Оновлювач недоступний' };
    if (!app.isPackaged) return { status: 'error', message: 'У режимі розробки оновлення не перевіряються' };
    try { await autoUpdater.checkForUpdates(); return { status: 'checking' }; }
    catch (e) { return { status: 'error', message: String(e.message || e) }; }
  });
  ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataFile: store.file,
    platform: process.platform,
    packaged: app.isPackaged,
    releasesUrl: 'https://github.com/retailgroupht-dev/ht-dron/releases',
  }));
  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('app:showDataFile', () => shell.showItemInFolder(store.file));
}

// SALARY_DATA_DIR — інша тека даних (для перевірок, щоб не чіпати робочу базу).
if (process.env.SALARY_DATA_DIR) app.setPath('userData', process.env.SALARY_DATA_DIR);

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  registerIpc();
  buildMenu();
  createWindow();
  setupUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
