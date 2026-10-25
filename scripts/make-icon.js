// Entwicklerwerkzeug: rendert assets/icon.png (256×256) aus einem Lucide-Icon.
// Aufruf: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const lucide = require('lucide');

const node = lucide.icons.Puzzle;
const inner = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');

const html = `<html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3bf5f"/><stop offset="1" stop-color="#c9801f"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="#000" stroke-opacity=".15" stroke-width="4"/>
  <g transform="translate(48 48) scale(6.6667)" fill="none" stroke="#1b1306" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
</svg></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const out = path.join(__dirname, '..', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: 256, height: 256 }).toPNG());
  console.log('geschrieben:', out);
  app.quit();
});
