'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData: () => ipcRenderer.invoke('data:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  saveEmployees: (list) => ipcRenderer.invoke('employees:save', list),
  saveOrder: (o) => ipcRenderer.invoke('orders:save', o),
  deleteOrders: (ids) => ipcRenderer.invoke('orders:delete', ids),
  importUrl: (p) => ipcRenderer.invoke('import:url', p),
  importFile: (p) => ipcRenderer.invoke('import:file', p),
  exportFile: (p) => ipcRenderer.invoke('export:file', p),
  apiStatus: () => ipcRenderer.invoke('api:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  showDataFile: () => ipcRenderer.invoke('app:showDataFile'),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, info) => cb(info)),
});
