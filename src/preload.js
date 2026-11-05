'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData: () => ipcRenderer.invoke('data:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  saveEmployees: (list) => ipcRenderer.invoke('employees:save', list),
  saveOrder: (o) => ipcRenderer.invoke('orders:save', o),
  deleteOrders: (ids) => ipcRenderer.invoke('orders:delete', ids),
  npTrack: (numbers) => ipcRenderer.invoke('np:track', numbers),
  npAdd: (p) => ipcRenderer.invoke('np:add', p),
  npRefresh: (p) => ipcRenderer.invoke('np:refresh', p),
  accountsImport: (text) => ipcRenderer.invoke('accounts:import', text),
  accountsTest: () => ipcRenderer.invoke('accounts:test'),
  importUrl: (p) => ipcRenderer.invoke('import:url', p),
  importFile: (p) => ipcRenderer.invoke('import:file', p),
  exportFile: (p) => ipcRenderer.invoke('export:file', p),
  apiStatus: () => ipcRenderer.invoke('api:status'),
  apiDocs: () => ipcRenderer.invoke('api:docs'),
  apiDocsSave: () => ipcRenderer.invoke('api:docsSave'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  showDataFile: () => ipcRenderer.invoke('app:showDataFile'),
  backupSave: () => ipcRenderer.invoke('data:backup'),
  backupRestore: () => ipcRenderer.invoke('data:restore'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, info) => cb(info)),
});
