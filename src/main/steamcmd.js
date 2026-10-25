// SteamCMD (offizielles Kommandozeilen-Tool von Valve) einrichten und Workshop-Items anonym herunterladen.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const { APPID } = require('./workshop');

const ZIP_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

function baseDir() {
  return path.join(app.getPath('userData'), 'steamcmd');
}
function exePath() {
  return path.join(baseDir(), 'steamcmd.exe');
}
function contentDir() {
  return path.join(baseDir(), 'content');
}
function itemDir(id) {
  return path.join(contentDir(), 'steamapps', 'workshop', 'content', String(APPID), String(id));
}
function downloadDir(id) {
  return path.join(contentDir(), 'steamapps', 'workshop', 'downloads', String(APPID), String(id));
}

function isReady() {
  return fs.existsSync(exePath()) && fs.existsSync(path.join(baseDir(), 'steamerrorreporter.exe'));
}

function run(args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(exePath(), args, { cwd: baseDir(), windowsHide: true });
    let buffer = '';
    const handle = (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n|\r/);
      buffer = parts.pop();
      parts.forEach((l) => l.trim() && onLine?.(l.trim()));
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('close', (code) => {
      if (buffer.trim()) onLine?.(buffer.trim());
      resolve(code);
    });
    child.on('error', () => resolve(-1));
    run.current = child;
  });
}

const exec = (file, args) =>
  new Promise((resolve, reject) => execFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve())));

// Windows-eigenes tar (bsdtar) verwenden – ein tar aus Git/MSYS im PATH versteht "C:\…" nicht. Fallback: PowerShell.
async function extractZip(zip, dest) {
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  try {
    await exec(systemTar, ['-xf', zip, '-C', dest]);
  } catch {
    const ps = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  }
}

// Lädt SteamCMD herunter und lässt es sich beim ersten Start selbst aktualisieren.
async function ensure(onStatus = () => {}) {
  if (isReady()) return true;
  fs.mkdirSync(baseDir(), { recursive: true });
  if (!fs.existsSync(exePath())) {
    onStatus('SteamCMD wird heruntergeladen …');
    const res = await fetch(ZIP_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`SteamCMD-Download fehlgeschlagen (HTTP ${res.status})`);
    const zip = path.join(baseDir(), 'steamcmd.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    await extractZip(zip, baseDir());
    fs.rmSync(zip, { force: true });
  }
  onStatus('SteamCMD wird eingerichtet (einmalig, ca. 1 Minute) …');
  await run(['+quit'], (line) => {
    const m = line.match(/\[\s*(\d+)%\]\s*(.*)/);
    if (m) onStatus(`SteamCMD wird eingerichtet … ${m[1]}%`);
  });
  if (!isReady()) throw new Error('SteamCMD konnte nicht eingerichtet werden');
  onStatus('');
  return true;
}

// Lädt mehrere Items in einer SteamCMD-Sitzung. Events: { type: 'start'|'success'|'error', id, path?, reason? }
async function downloadItems(ids, onEvent, onLog) {
  // Den Workshop-Status von SteamCMD verwerfen, damit Updates immer frisch geladen werden.
  fs.rmSync(path.join(contentDir(), 'steamapps', 'workshop', `appworkshop_${APPID}.acf`), { force: true });
  const args = ['+force_install_dir', contentDir(), '+login', 'anonymous'];
  ids.forEach((id) => args.push('+workshop_download_item', String(APPID), String(id)));
  args.push('+quit');

  const pending = new Set(ids.map(String));
  await run(args, (line) => {
    onLog?.(line);
    let m;
    if ((m = line.match(/Downloading item (\d+)/))) {
      onEvent({ type: 'start', id: m[1] });
    } else if ((m = line.match(/Success\. Downloaded item (\d+) to "([^"]+)"/))) {
      pending.delete(m[1]);
      onEvent({ type: 'success', id: m[1], path: m[2] });
    } else if ((m = line.match(/ERROR! Download item (\d+) failed \(([^)]*)\)/))) {
      pending.delete(m[1]);
      onEvent({ type: 'error', id: m[1], reason: m[2] });
    } else if (/FAILED \(|Login Failure|No subscription/.test(line)) {
      onLog?.(line);
    }
  });
  // Items ohne Rückmeldung (z. B. Abbruch) als Fehler melden.
  pending.forEach((id) => onEvent({ type: 'error', id, reason: 'Keine Rückmeldung von SteamCMD' }));
}

function cancel() {
  try {
    run.current?.kill();
  } catch { /* bereits beendet */ }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch { /* Ordner existiert (noch) nicht */ }
  return total;
}

// Ungefährer Download-Fortschritt in Bytes (Steam lädt erst nach downloads/, dann nach content/).
function downloadedBytes(id) {
  return Math.max(dirSize(downloadDir(id)), dirSize(itemDir(id)));
}

function clearCache() {
  fs.rmSync(path.join(contentDir(), 'steamapps'), { recursive: true, force: true });
}

module.exports = { ensure, isReady, downloadItems, cancel, itemDir, downloadedBytes, clearCache, baseDir };
