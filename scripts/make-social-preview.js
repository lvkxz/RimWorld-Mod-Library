// Entwicklerwerkzeug: rendert docs/social-preview.png (1280×640) für die GitHub-Vorschau.
// Aufruf: npx electron scripts/make-social-preview.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const lucide = require('lucide');

const root = path.join(__dirname, '..');
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(path.join(root, file)).toString('base64')}`;

function svgIcon(name) {
  const node = lucide.icons[name];
  const inner = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

const features = [
  ['Puzzle', 'Auto dependencies'],
  ['ListOrdered', 'Load order sorting'],
  ['RefreshCw', 'One-click updates'],
  ['Layers', 'Collections']
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 640px; overflow: hidden;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    color: #ece2cf;
    background:
      radial-gradient(circle at 12% 0%, rgba(227,163,60,.28), transparent 46%),
      radial-gradient(circle at 100% 100%, rgba(140,90,40,.30), transparent 50%),
      #16130f;
    position: relative;
  }
  .grid {
    position: absolute; inset: 0; opacity: .07;
    background-image: linear-gradient(#e3a33c 1px, transparent 1px), linear-gradient(90deg, #e3a33c 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: linear-gradient(90deg, #000 0%, transparent 60%);
  }
  .left { position: absolute; left: 64px; top: 52px; width: 610px; }
  .brand { display: flex; align-items: center; gap: 20px; margin-bottom: 22px; }
  .brand img { width: 88px; height: 88px; filter: drop-shadow(0 12px 28px rgba(0,0,0,.55)); }
  .kicker { font-size: 18px; letter-spacing: 3px; text-transform: uppercase; color: #e3a33c; font-weight: 600; }
  h1 { font-size: 58px; line-height: 1.02; font-weight: 750; letter-spacing: -1.5px; }
  .tag { font-size: 22px; line-height: 1.4; color: #c9bba1; margin: 0 0 24px; }
  .tag b { color: #f0b95a; font-weight: 650; }
  .chips { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
  .chip {
    display: flex; align-items: center; gap: 11px;
    padding: 10px 14px; border-radius: 12px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(227,163,60,.28);
    font-size: 17px; font-weight: 600;
  }
  .chip svg { width: 20px; height: 20px; color: #e3a33c; flex-shrink: 0; }
  .foot {
    position: absolute; left: 64px; bottom: 34px;
    display: flex; align-items: center; gap: 12px; font-size: 18px; color: #8a7c66;
  }
  .foot svg { width: 20px; height: 20px; }
  .pill { padding: 5px 12px; border-radius: 999px; background: #e3a33c; color: #1b1306; font-weight: 700; font-size: 15px; }
  .shot {
    position: absolute; left: 712px; top: 92px; width: 760px;
    border-radius: 14px; overflow: hidden;
    border: 1px solid rgba(227,163,60,.35);
    box-shadow: 0 30px 80px rgba(0,0,0,.65), 0 0 0 8px rgba(255,255,255,.03);
    transform: perspective(1600px) rotateY(-14deg) rotateX(4deg);
    transform-origin: left center;
  }
  .shot img { display: block; width: 100%; }
  .fade { position: absolute; right: 0; top: 0; bottom: 0; width: 120px; background: linear-gradient(90deg, transparent, #16130f); }
</style></head><body>
  <div class="grid"></div>
  <div class="left">
    <div class="brand">
      <img src="${dataUri('assets/icon.png')}" alt="">
      <div class="kicker">Mod manager</div>
    </div>
    <h1>RimWorld<br>Mod Library</h1>
    <p class="tag" style="margin-top:16px">Steam Workshop mods for <b>Epic Games</b> &amp; <b>GOG</b> RimWorld.<br>No Steam account needed.</p>
    <div class="chips">${features.map(([ic, label]) => `<div class="chip">${svgIcon(ic)}${label}</div>`).join('')}</div>
  </div>
  <div class="foot">${svgIcon('Link')}github.com/lvkxz/RimWorld-Mod-Library <span class="pill">Free · Windows</span></div>
  <div class="shot"><img src="${dataUri('docs/screenshots/library.png')}" alt=""></div>
  <div class="fade"></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 640, useContentSize: true, show: false, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 640 });
  const out = path.join(root, 'docs', 'social-preview.png');
  fs.writeFileSync(out, img.resize({ width: 1280, height: 640, quality: 'best' }).toPNG());
  console.log('geschrieben:', out);
  app.quit();
});
