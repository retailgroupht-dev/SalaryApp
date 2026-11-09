'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { Service } = require('./service');
const { createApi } = require('./api');

let win = null;
let store = null;
let service = null;
let api = null;
let autoUpdater = null;
let syncTimer = null;

// Автоматичне оновлення: перший запуск за 20 с після старту, далі кожні settings.auto.hours годин.
function runSync(reason) {
  if (!service || service.syncing) return;
  service.autoSync().then((r) => {
    if (win && !win.isDestroyed()) win.webContents.send('sync:done', Object.assign({ reason }, r));
  }).catch((e) => console.log('sync:', e.message));
}
function scheduleSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const a = service.data.settings.auto || {};
  if (!a.enabled || process.env.SALARY_SMOKE_SHOT) return;
  syncTimer = setInterval(() => runSync('timer'), (Number(a.hours) || 6) * 3600 * 1000);
}

const RELEASES_URL = 'https://github.com/retailgroupht-dev/SalaryApp/releases';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

// Дані з версії до перейменування (тека «Розрахунок зарплат») переносяться в теку SalaryApp.
function migrateOldDataDir(userData) {
  try {
    const target = path.join(userData, 'data.json');
    const old = path.join(path.dirname(userData), 'Розрахунок зарплат', 'data.json');
    if (!fs.existsSync(target) && fs.existsSync(old)) {
      fs.mkdirSync(userData, { recursive: true });
      fs.copyFileSync(old, target);
    }
  } catch (e) { console.log('migrate:', e.message); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'SalaryApp',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  // Перевірочний запуск без людини: SALARY_SMOKE_SHOT=<png> — знімки вікна й вихід.
  if (process.env.SALARY_SMOKE_SHOT) {
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const shot = async (file) => fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        await shot(process.env.SALARY_SMOKE_SHOT);
        for (const tab of ['auto', 'manual', 'shipments', 'settings']) {
          await win.webContents.executeJavaScript(`document.querySelector('[data-tab=${tab}]').click()`);
          if (tab === 'settings') await win.webContents.executeJavaScript("document.querySelector('#toggleDocs').click()");
          else await win.webContents.executeJavaScript("(document.querySelector('.tab.active table.grid') || {}).scrollIntoView && document.querySelector('.tab.active table.grid').scrollIntoView()");
          await new Promise((r) => setTimeout(r, 800));
          await shot(process.env.SALARY_SMOKE_SHOT.replace(/\.png$/, '') + `-${tab}.png`);
        }
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

function registerIpc() {
  ipcMain.handle('data:get', () => service.data);
  ipcMain.handle('clipboard:write', (_e, t) => clipboard.writeText(String(t || '')));

  ipcMain.handle('settings:save', async (_e, settings) => {
    const s = service.saveSettings(settings);
    if (settings.api) await api.apply(s.api);
    if (settings.auto) scheduleSync();
    return s;
  });

  ipcMain.handle('employees:save', (_e, employees) => service.saveEmployees(employees));
  ipcMain.handle('orders:save', (_e, order) => { service.upsertOrder(order); return service.data; });
  ipcMain.handle('orders:delete', (_e, ids) => { service.deleteOrders(ids); return service.data; });

  ipcMain.handle('np:track', (_e, numbers) => service.trackNumbers(numbers).then((r) => ({ results: [...r.results.values()], errors: r.errors })));
  ipcMain.handle('accounts:import', async (_e, p) => Object.assign(await service.importAccountsFromScript(p.text, p.employeeId), { settings: service.data.settings }));
  ipcMain.handle('import:paste', async (_e, p) => Object.assign(await service.addPasted(p.text), { data: service.data }));
  ipcMain.handle('shipments:collect', (_e, p) => service.collectShipments(p));
  ipcMain.handle('shipments:add', (_e, items) => Object.assign(service.addShipments(items), { data: service.data }));
  ipcMain.handle('sync:run', async () => Object.assign(await service.autoSync(), { data: service.data }));
  ipcMain.handle('accounts:test', () => service.testAccounts());
  ipcMain.handle('np:add', async (_e, p) => Object.assign(await service.addByTtn(p), { data: service.data }));
  ipcMain.handle('np:refresh', async (_e, p) => Object.assign(await service.refreshFromNp(p), { data: service.data }));

  ipcMain.handle('orders:export', async (_e, { format, filters }) => {
    const f = service.exportOrdersBuffer(format || 'xlsx', filters || {});
    const r = await dialog.showSaveDialog(win, { title: 'Зберегти замовлення', defaultPath: f.filename, filters: [{ name: (format || 'xlsx').toUpperCase(), extensions: [format || 'xlsx'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, f.buffer);
    return { path: r.filePath, count: f.count };
  });
  ipcMain.handle('export:file', async (_e, { format, period, source }) => {
    const f = service.exportBuffer(format, period, source);
    const r = await dialog.showSaveDialog(win, {
      title: 'Зберегти розрахунок',
      defaultPath: f.filename,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, f.buffer);
    return r.filePath;
  });

  ipcMain.handle('api:status', () => api.status());
  ipcMain.handle('api:docs', () => api.docs());
  ipcMain.handle('api:docsSave', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Зберегти документацію API',
      defaultPath: 'SalaryApp-API.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Текст', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, api.docs(), 'utf8');
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
    releasesUrl: RELEASES_URL,
  }));
  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('app:showDataFile', () => shell.showItemInFolder(store.file));
  ipcMain.handle('data:backup', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Зберегти резервну копію',
      defaultPath: `SalaryApp-копія-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(service.data, null, 1), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('data:restore', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Оберіть файл резервної копії',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); }
    catch (e) { throw new Error('Файл не читається як JSON'); }
    const res = service.replaceData(parsed);
    return Object.assign(res, { data: service.data });
  });
}

// SALARY_DATA_DIR — інша тека даних (для перевірок, щоб не чіпати робочу базу).
if (process.env.SALARY_DATA_DIR) app.setPath('userData', process.env.SALARY_DATA_DIR);

// Лише один екземпляр на теку даних: два запущені застосунки (напр. зібраний і режим розробки)
// перезаписували б data.json кожен своєю копією. Другий запуск лише показує вікно першого.
if (!app.requestSingleInstanceLock()) {
  console.log('SalaryApp уже запущено — цей екземпляр закривається');
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

app.whenReady().then(async () => {
  if (!process.env.SALARY_DATA_DIR) migrateOldDataDir(app.getPath('userData'));
  if (process.platform === 'darwin' && app.dock && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  store = new Store(app.getPath('userData'));
  service = new Service(store);
  api = createApi(service, { version: app.getVersion() });
  registerIpc();
  buildMenu();
  createWindow();
  setupUpdater();
  await api.apply(store.data.settings.api);
  scheduleSync();
  if (store.data.settings.auto.enabled && !process.env.SALARY_SMOKE_SHOT) setTimeout(() => runSync('startup'), 20000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (api) api.stop(); });
