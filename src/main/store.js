// Persistente JSON-Ablage für Einstellungen und Installations-Metadaten.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  language: 'en',             // 'en' | 'de'
  theme: 'rimworld',          // 'light' | 'dark' | 'rimworld'
  gameDir: '',                // RimWorld-Installationsordner
  modsDir: '',                // Mods-Ordner (Standard: <gameDir>/Mods)
  configDir: '',              // Ordner mit ModsConfig.xml
  epicAppName: '',            // für den Start über den Epic Launcher
  launchVia: 'epic',          // 'epic' | 'exe'
  autoActivate: true,         // neue Mods direkt aktivieren
  autoDependencies: true,     // Abhängigkeiten automatisch mitinstallieren
  autoSortOnInstall: true,    // Ladereihenfolge nach Installation sortieren
  versionFilter: true,        // Workshop nur für die eigene Spielversion zeigen
  libraryView: 'grid'         // 'grid' | 'list'
};

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const target = file(name);
  fs.writeFileSync(target + '.tmp', JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(target + '.tmp', target);
}

const settings = {
  get() {
    return { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
  },
  set(partial) {
    const next = { ...settings.get(), ...partial };
    writeJson('settings.json', next);
    return next;
  }
};

// Merkt sich pro Workshop-ID, welcher Stand installiert wurde (für die Update-Prüfung).
const installs = {
  all() {
    return readJson('installs.json', {});
  },
  record(workshopId, info) {
    const data = installs.all();
    data[workshopId] = { ...data[workshopId], ...info };
    writeJson('installs.json', data);
  },
  remove(workshopId) {
    const data = installs.all();
    delete data[workshopId];
    writeJson('installs.json', data);
  }
};

module.exports = { settings, installs, DEFAULT_SETTINGS };
