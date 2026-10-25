// Erkennt die RimWorld-Installation (Epic, GOG, Steam, Standardpfade) und den Config-Ordner.
const fs = require('fs');
const path = require('path');
const os = require('os');

const EPIC_MANIFESTS = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
const EXE = 'RimWorldWin64.exe';

function isGameDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, EXE)) && fs.existsSync(path.join(dir, 'Data', 'Core'));
}

function findEpic() {
  try {
    for (const f of fs.readdirSync(EPIC_MANIFESTS)) {
      if (!f.endsWith('.item')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(EPIC_MANIFESTS, f), 'utf8'));
      if (/rimworld/i.test(m.DisplayName || '') && isGameDir(m.InstallLocation)) {
        return { gameDir: m.InstallLocation, epicAppName: m.AppName || '' };
      }
    }
  } catch { /* kein Epic Launcher installiert */ }
  return null;
}

function findCommon() {
  const candidates = [];
  for (const drive of ['C', 'D', 'E', 'F']) {
    candidates.push(
      `${drive}:\\Program Files\\Epic Games\\RimWorld`,
      `${drive}:\\Epic Games\\RimWorld`,
      `${drive}:\\GOG Games\\RimWorld`,
      `${drive}:\\Program Files (x86)\\GOG Galaxy\\Games\\RimWorld`,
      `${drive}:\\Program Files (x86)\\Steam\\steamapps\\common\\RimWorld`,
      `${drive}:\\SteamLibrary\\steamapps\\common\\RimWorld`,
      `${drive}:\\Games\\RimWorld`
    );
  }
  const hit = candidates.find(isGameDir);
  return hit ? { gameDir: hit, epicAppName: '' } : null;
}

function defaultConfigDir() {
  return path.join(os.homedir(), 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config');
}

// Füllt fehlende Pfade in den Einstellungen automatisch auf.
function resolvePaths(settings) {
  const out = { ...settings };
  if (!isGameDir(out.gameDir)) {
    const found = findEpic() || findCommon();
    if (found) {
      out.gameDir = found.gameDir;
      if (!out.epicAppName) out.epicAppName = found.epicAppName;
    }
  } else if (!out.epicAppName) {
    const epic = findEpic();
    if (epic && path.resolve(epic.gameDir) === path.resolve(out.gameDir)) out.epicAppName = epic.epicAppName;
  }
  if (!out.modsDir && out.gameDir) out.modsDir = path.join(out.gameDir, 'Mods');
  if (!out.configDir) out.configDir = defaultConfigDir();
  return out;
}

// Liefert z. B. { full: '1.6.4871 rev573', short: '1.6' }.
function gameVersion(gameDir) {
  try {
    const full = fs.readFileSync(path.join(gameDir, 'Version.txt'), 'utf8').trim();
    const m = full.match(/^(\d+\.\d+)/);
    return { full, short: m ? m[1] : '' };
  } catch {
    return { full: '', short: '' };
  }
}

module.exports = { resolvePaths, gameVersion, isGameDir, EXE };
