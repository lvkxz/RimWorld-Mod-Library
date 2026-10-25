// Entwicklerwerkzeug: startet die App mit eigenem Datenordner und nimmt Screenshots auf.
// Aufruf: npx electron scripts/shots.js <datenordner> <plan.js> <ausgabeordner>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [dataDir, planFile, outDir] = process.argv.slice(-3).map((p) => path.resolve(p));
app.setPath('userData', dataDir);
require('../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(1500);
  fs.mkdirSync(outDir, { recursive: true });
  const plan = require(planFile);
  for (const step of plan) {
    try {
      if (step.js) {
        const res = await win.webContents.executeJavaScript(step.js);
        if (step.log) console.log(step.name || 'js', JSON.stringify(res));
      }
      if (step.wait) await sleep(step.wait);
      if (step.waitFor) {
        const start = Date.now();
        while (Date.now() - start < (step.timeout || 300000)) {
          if (await win.webContents.executeJavaScript(step.waitFor)) break;
          await sleep(1000);
        }
      }
      if (step.shot) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, step.shot + '.png'), img.toPNG());
        console.log('shot', step.shot);
      }
    } catch (e) {
      console.log('step failed', step.name || step.shot, e.message);
    }
  }
  app.quit();
});
