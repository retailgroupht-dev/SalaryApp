'use strict';
// Генерує build/icon.png (1024×1024) засобами Electron: `npx electron build/make-icon.js`.
// electron-builder сам робить з нього .icns (macOS) і .ico (Windows).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;border-radius:230px;background:linear-gradient(160deg,#16a34a 0%,#166534 100%);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 -40px 80px rgba(0,0,0,.18)">
  <div style="width:640px;height:640px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fde68a,#f59e0b 70%,#b45309);box-shadow:0 30px 60px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;border:26px solid #fbbf24">
    <div style="font:900 440px/1 -apple-system,'Segoe UI',Arial,sans-serif;color:#7c2d12;margin-top:-20px;text-shadow:0 8px 0 rgba(255,255,255,.25)">₴</div>
  </div>
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('icon:', out, img.getSize());
  app.quit();
});
