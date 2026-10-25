const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile, spawn } = require('child_process');

const { settings, installs } = require('./store');
const { resolvePaths, gameVersion, isGameDir, EXE } = require('./paths');
const { scanAll, parseMod, plainDescription } = require('./mods');
const modsconfig = require('./modsconfig');
const workshop = require('./workshop');
const steamcmd = require('./steamcmd');
const { Installer } = require('./installer');
const i18n = require('./i18n');
const { tr } = i18n;

// Beliebte, bewährte Mods als Startpunkt für die Vorschläge.
const ESSENTIALS = [
  '2009463077', // Harmony
  '818773962',  // HugsLib
  '2023507013', // Vanilla Expanded Framework
  '1508850027', // RimHUD
  '1279012058', // Pick Up And Haul
  '761421485',  // Allow Tool
  '730936602',  // Achtung!
  '1446523594', // Dubs Mint Menus
  '836308268',  // Dubs Bad Hygiene
  '1414302321', // Numbers
  '1561769193', // Common Sense
  '1541460369', // Better Pawn Control
  '867467808',  // Camera+
  '1874644848', // Character Editor
  '2038874626', // Dubs Performance Analyzer
  '1718190143', // Vanilla Furniture Expanded
  '2599504692'  // No Version Warning
];

const TITLEBAR = {
  light: { color: '#f4f5f7', symbolColor: '#3b3f46' },
  dark: { color: '#14161a', symbolColor: '#c9ccd2' },
  rimworld: { color: '#16130f', symbolColor: '#d8c9ad' }
};

let win;
let lastScan = { mods: [], byWorkshop: new Map() };

function ctx() {
  const s = resolvePaths(settings.get());
  return { s, version: gameVersion(s.gameDir) };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function isGameRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH'], { windowsHide: true }, (err, out) =>
      resolve(!err && out.toLowerCase().includes(EXE.toLowerCase()))
    );
  });
}

function scan() {
  const { s, version } = ctx();
  const mods = scanAll(s.gameDir, s.modsDir, version.short);
  const byWorkshop = new Map();
  mods.forEach((m) => m.workshopId && !byWorkshop.has(m.workshopId) && byWorkshop.set(m.workshopId, m));
  lastScan = { mods, byWorkshop };
  return { mods, byWorkshop, s, version };
}

function libraryState() {
  const { mods, s, version } = scan();
  const config = modsconfig.readConfig(s.configDir);
  const issues = modsconfig.analyze(config.active, mods, version.short);
  const activePos = new Map(config.active.map((id, i) => [id, i]));
  const record = installs.all();
  return {
    configExists: config.exists,
    active: config.active,
    issues,
    mods: mods.map((m) => ({
      ...m,
      description: plainDescription(m.description),
      previewUrl: m.preview ? pathToFileURL(m.preview).href : '',
      active: activePos.has(m.packageId),
      loadIndex: activePos.has(m.packageId) ? activePos.get(m.packageId) : -1,
      versionOk: modsconfig.versionSupported(m, version.short),
      installedVia: m.workshopId && record[m.workshopId] ? 'app' : 'manual'
    }))
  };
}

function byPackageMap() {
  const map = new Map();
  lastScan.mods.forEach((m) => !map.has(m.packageId) && map.set(m.packageId, m));
  return map;
}

async function saveActive(active, { sort = false } = {}) {
  const { s, version } = ctx();
  if (!lastScan.mods.length) scan();
  let list = [...new Set(active.map((id) => id.toLowerCase()))];
  if (!list.includes(modsconfig.CORE)) list.unshift(modsconfig.CORE);
  if (sort) list = modsconfig.autoSort(list, byPackageMap());
  if (await isGameRunning()) {
    throw new Error(tr('err.gameRunning'));
  }
  const officials = lastScan.mods.filter((m) => m.official).map((m) => m.packageId);
  modsconfig.writeConfig(s.configDir, list, version.full, officials);
  return libraryState();
}

const installer = new Installer({
  getModsDir: () => ctx().s.modsDir,
  findInstalledPath: (id) => {
    const { s } = ctx();
    const m = lastScan.byWorkshop.get(id);
    // Nur Ordner im Mods-Verzeichnis ersetzen, nie Spieldateien.
    return m && !m.official && m.path.startsWith(s.modsDir) ? m.path : '';
  },
  onUpdate: (tasks) => send('queue:update', tasks),
  onStatus: (msg) => send('status', msg),
  discoverDependencies: async (doneTasks) => {
    if (!settings.get().autoDependencies) return [];
    const { mods, version } = scan();
    const installedPkg = new Set(mods.map((m) => m.packageId));
    const busy = new Set(installer.list().filter((t) => t.state !== 'error').map((t) => t.id));
    const wanted = new Map(); // workshopId -> soll aktiviert werden?
    for (const task of doneTasks) {
      const mod = parseMod(task.installedPath, 'local', version.short);
      if (!mod) continue;
      const parentActive = task.activate || modsconfig.readConfig(ctx().s.configDir).active.includes(mod.packageId);
      for (const dep of mod.dependencies) {
        if (installedPkg.has(dep.packageId) || !dep.workshopId) continue;
        if (lastScan.byWorkshop.has(dep.workshopId) || busy.has(dep.workshopId)) continue;
        wanted.set(dep.workshopId, (wanted.get(dep.workshopId) || false) || parentActive);
      }
    }
    if (!wanted.size) return [];
    const info = await workshop.details([...wanted.keys()]);
    return [...wanted].map(([id, activate]) => {
      const i = info.find((x) => x.id === id) || {};
      return {
        id,
        title: i.title || `Workshop-Item ${id}`,
        preview: i.preview || '',
        size: i.size || 0,
        timeUpdated: i.timeUpdated || 0,
        isDependency: true,
        isUpdate: false,
        activate
      };
    });
  },
  onBatchDone: async (done) => {
    scan();
    const toActivate = done.filter((t) => t.activate);
    if (toActivate.length && settings.get().autoActivate) {
      try {
        const { s, version } = ctx();
        const current = modsconfig.readConfig(s.configDir).active;
        const added = toActivate
          .map((t) => parseMod(t.installedPath, 'local', version.short))
          .filter(Boolean)
          .map((m) => m.packageId);
        await saveActive([...current, ...added], { sort: settings.get().autoSortOnInstall });
        send('toast', { type: 'success', text: tr('toast.installedActivated', { n: added.length }) });
      } catch (e) {
        send('toast', { type: 'warning', text: tr('toast.installedNotActivated', { error: e.message }) });
      }
    } else {
      send('toast', { type: 'success', text: tr('toast.installed', { n: done.length }) });
    }
    send('library:changed');
  }
});

function createWindow() {
  const theme = settings.get().theme;
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: TITLEBAR[theme]?.color || '#16130f',
    title: 'RimWorld Mod Library',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...(TITLEBAR[theme] || TITLEBAR.rimworld), height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      openExternal(url);
    }
  });
}

function openExternal(url) {
  if (/^(https?:|steam:)/i.test(url)) shell.openExternal(url);
}

// ---------- IPC ----------
const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

handle('app:context', () => {
  const { s, version } = ctx();
  if (JSON.stringify(s) !== JSON.stringify(settings.get())) settings.set(s);
  return {
    settings: s,
    version,
    gameFound: isGameDir(s.gameDir),
    steamcmdReady: steamcmd.isReady(),
    appVersion: app.getVersion()
  };
});

handle('settings:set', (partial) => {
  const next = settings.set(partial);
  if (partial.language) i18n.setLanguage(partial.language);
  if (partial.theme && win) {
    try {
      win.setTitleBarOverlay({ ...(TITLEBAR[partial.theme] || TITLEBAR.rimworld), height: 40 });
    } catch { /* nicht unterstützt */ }
  }
  return next;
});

handle('dialog:folder', async (title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  return r.canceled ? '' : r.filePaths[0];
});

handle('library:state', () => libraryState());
handle('library:save', (active, opts) => saveActive(active, opts));
handle('library:sortPreview', (active) => {
  if (!lastScan.mods.length) scan();
  const { version } = ctx();
  const sorted = modsconfig.autoSort(active, byPackageMap());
  return { active: sorted, issues: modsconfig.analyze(sorted, lastScan.mods, version.short) };
});
handle('library:analyze', (active) => {
  if (!lastScan.mods.length) scan();
  return modsconfig.analyze(active, lastScan.mods, ctx().version.short);
});
handle('library:uninstall', async (modPath) => {
  const { s } = ctx();
  const mod = lastScan.mods.find((m) => m.path === modPath);
  if (!mod || mod.official || !path.resolve(modPath).startsWith(path.resolve(s.modsDir))) {
    throw new Error(tr('err.onlyModsFolder'));
  }
  await shell.trashItem(modPath); // in den Papierkorb – wiederherstellbar
  if (mod.workshopId) installs.remove(mod.workshopId);
  const config = modsconfig.readConfig(s.configDir);
  if (config.exists && config.active.includes(mod.packageId) && !(await isGameRunning())) {
    scan();
    const officials = lastScan.mods.filter((m) => m.official).map((m) => m.packageId);
    const { version } = ctx();
    modsconfig.writeConfig(s.configDir, config.active.filter((id) => id !== mod.packageId), version.full, officials);
  }
  return libraryState();
});
handle('library:checkUpdates', async () => {
  if (!lastScan.mods.length) scan();
  const record = installs.all();
  const local = lastScan.mods.filter((m) => m.workshopId && !m.official);
  const remote = await workshop.details(local.map((m) => m.workshopId));
  const byId = new Map(remote.map((r) => [r.id, r]));
  const updates = [];
  for (const m of local) {
    const r = byId.get(m.workshopId);
    if (!r || !r.ok || !r.timeUpdated) continue;
    const localTime = record[m.workshopId]?.timeUpdated || Math.floor(m.mtime / 1000);
    if (r.timeUpdated > localTime + 60) {
      updates.push({ ...r, localName: m.name, packageId: m.packageId, localTime, path: m.path });
    }
  }
  return updates;
});

handle('shell:open', (target) => {
  if (/^(https?:|steam:)/i.test(target)) return openExternal(target);
  if (fs.existsSync(target)) return shell.openPath(target);
});

handle('workshop:browse', (params) => workshop.browse(params));
handle('workshop:details', async (id) => {
  const [item] = await workshop.details([id]);
  let page = { required: [], requiredDlc: [], screenshots: [], author: '' };
  try {
    page = await workshop.pageInfo(id);
  } catch { /* Detailseite optional */ }
  return { ...item, ...page, author: item?.author || page.author };
});
handle('workshop:detailsMany', (ids) => workshop.details(ids));
handle('workshop:collection', (input) => workshop.collection(input));

handle('workshop:suggestions', async () => {
  const { version } = ctx();
  const { mods } = scan();
  const installedWs = new Set(mods.map((m) => m.workshopId).filter(Boolean));
  const installedPkg = new Set(mods.map((m) => m.packageId));
  const fitsVersion = (it) => !version.short || !it.versions.length || it.versions.includes(version.short);

  // Fehlende Abhängigkeiten installierter Mods
  const missing = new Map();
  for (const m of mods) {
    for (const d of m.dependencies) {
      if (installedPkg.has(d.packageId) || (d.workshopId && installedWs.has(d.workshopId))) continue;
      const key = d.workshopId || d.packageId;
      const entry = missing.get(key) || { ...d, requiredBy: [] };
      entry.requiredBy.push(m.name);
      missing.set(key, entry);
    }
  }
  const missingList = [...missing.values()];
  const missingDetails = await workshop.details(missingList.map((d) => d.workshopId).filter(Boolean)).catch(() => []);
  const missingOut = missingList.map((d) => ({
    ...d,
    item: missingDetails.find((x) => x.id === d.workshopId) || null
  }));

  const [essentials, trending, popular] = await Promise.all([
    workshop.details(ESSENTIALS).catch(() => []),
    workshop.browse({ sort: 'trend', days: 7, version: version.short }).then((r) => r.items).catch(() => []),
    workshop.browse({ sort: 'popular', version: version.short }).then((r) => r.items).catch(() => [])
  ]);
  const notInstalled = (it) => it.ok && !installedWs.has(it.id) && fitsVersion(it);
  return {
    missing: missingOut,
    essentials: essentials.filter(notInstalled),
    trending: trending.filter(notInstalled).slice(0, 12),
    popular: popular.filter(notInstalled).slice(0, 12)
  };
});

// ids: Workshop-IDs. opts: { withDeps, activate, isUpdate }
handle('install:enqueue', async (ids, opts = {}) => {
  if (!lastScan.mods.length) scan();
  const s = settings.get();
  const withDeps = opts.withDeps ?? s.autoDependencies;
  const roots = ids.map(String);
  let all = roots;
  let depNames = {};
  if (withDeps && !opts.isUpdate) {
    send('status', tr('status.checkingDeps'));
    const res = await workshop.resolveDependencies(roots, (id) => lastScan.byWorkshop.has(id));
    all = res.ids;
    depNames = res.names;
    send('status', '');
  }
  const info = await workshop.details(all);
  const byId = new Map(info.map((i) => [i.id, i]));
  const items = all.map((id) => {
    const i = byId.get(id) || {};
    return {
      id,
      title: i.title || depNames[id] || `Workshop-Item ${id}`,
      preview: i.preview || '',
      size: i.size || 0,
      timeUpdated: i.timeUpdated || 0,
      isDependency: !roots.includes(id),
      isUpdate: !!opts.isUpdate || lastScan.byWorkshop.has(id),
      activate: opts.activate !== false && !opts.isUpdate && !lastScan.byWorkshop.has(id)
    };
  });
  installer.enqueue(items);
  return { count: items.length, dependencies: items.filter((i) => i.isDependency).map((i) => i.title) };
});
handle('install:queue', () => installer.list());
handle('install:cancel', () => installer.cancel());
handle('install:clear', () => installer.clearFinished());

handle('steamcmd:ensure', () => steamcmd.ensure((msg) => send('status', msg)));
handle('steamcmd:clearCache', () => steamcmd.clearCache());

handle('game:launch', async () => {
  const { s } = ctx();
  if (await isGameRunning()) throw new Error(tr('err.alreadyRunning'));
  if (s.launchVia === 'epic' && s.epicAppName) {
    await shell.openExternal(`com.epicgames.launcher://apps/${s.epicAppName}?action=launch&silent=true`);
  } else {
    const exe = path.join(s.gameDir, EXE);
    if (!fs.existsSync(exe)) throw new Error(tr('err.exeNotFound'));
    spawn(exe, [], { cwd: s.gameDir, detached: true, stdio: 'ignore' }).unref();
  }
  return true;
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  i18n.setLanguage(settings.get().language);
  createWindow();
});
app.on('window-all-closed', () => {
  steamcmd.cancel();
  app.quit();
});
