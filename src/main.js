'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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

const RELEASES_URL = 'https://github.com/retailgroupht-dev/ht-dron/releases';

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
  // Перевірочний запуск без людини: SALARY_SMOKE_SHOT=<png> — знімки вікна й вихід.
  if (process.env.SALARY_SMOKE_SHOT) {
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const shot = async (file) => fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        await shot(process.env.SALARY_SMOKE_SHOT);
        for (const tab of ['orders', 'settings']) {
          await win.webContents.executeJavaScript(`document.querySelector('[data-tab=${tab}]').click()`);
          await new Promise((r) => setTimeout(r, 500));
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

  ipcMain.handle('settings:save', async (_e, settings) => {
    const s = service.saveSettings(settings);
    if (settings.api) await api.apply(s.api);
    return s;
  });

  ipcMain.handle('employees:save', (_e, employees) => service.saveEmployees(employees));
  ipcMain.handle('orders:save', (_e, order) => { service.upsertOrder(order); return service.data; });
  ipcMain.handle('orders:delete', (_e, ids) => { service.deleteOrders(ids); return service.data; });

  ipcMain.handle('import:url', async (_e, p) => Object.assign(await service.importFromUrl(p.url, p), { data: service.data }));

  ipcMain.handle('import:file', async (_e, p) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Оберіть CSV-файл (експорт аркуша)',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    return Object.assign(service.importCsvText(text, p), { data: service.data });
  });

  ipcMain.handle('export:file', async (_e, { format, period }) => {
    const f = service.exportBuffer(format, period);
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
}

// SALARY_DATA_DIR — інша тека даних (для перевірок, щоб не чіпати робочу базу).
if (process.env.SALARY_DATA_DIR) app.setPath('userData', process.env.SALARY_DATA_DIR);

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  service = new Service(store);
  api = createApi(service, { version: app.getVersion() });
  registerIpc();
  buildMenu();
  createWindow();
  setupUpdater();
  await api.apply(store.data.settings.api);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (api) api.stop(); });
