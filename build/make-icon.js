'use strict';
// Генерує build/icon.png (1024×1024) засобами Electron: `npx electron build/make-icon.js`.
// electron-builder сам робить з нього .icns (macOS) і .ico (Windows).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Стиль — плоска «мультяшна» іконка на білому заокругленому тлі: зелена купюра під нахилом,
// дві золоті монети, товсті темні контури.
const OUT = '#1f2937';
const coin = (cx, cy) => `
  <g>
    <circle cx="${cx}" cy="${cy}" r="150" fill="#fbbf24" stroke="${OUT}" stroke-width="24"/>
    <circle cx="${cx}" cy="${cy}" r="108" fill="#f59e0b" stroke="${OUT}" stroke-width="18"/>
    <text x="${cx}" y="${cy + 8}" font-family="-apple-system,'Segoe UI',Arial,sans-serif" font-weight="800" font-size="150" fill="${OUT}" text-anchor="middle" dominant-baseline="middle">$</text>
  </g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="200" fill="#ffffff"/>
  <g transform="rotate(-14 440 400)">
    <rect x="90" y="220" width="700" height="370" rx="34" fill="#4ade80" stroke="${OUT}" stroke-width="26"/>
    <rect x="134" y="264" width="612" height="282" rx="18" fill="none" stroke="#15803d" stroke-width="12"/>
    <circle cx="440" cy="405" r="128" fill="#bbf7d0" stroke="${OUT}" stroke-width="22"/>
    <text x="440" y="413" font-family="-apple-system,'Segoe UI',Arial,sans-serif" font-weight="800" font-size="190" fill="${OUT}" text-anchor="middle" dominant-baseline="middle">$</text>
  </g>
  ${coin(780, 640)}
  ${coin(640, 790)}
</svg>`;
const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;

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
