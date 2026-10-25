// Download-Warteschlange: SteamCMD laden lassen, in den Mods-Ordner verschieben, merken, aktivieren.
const fs = require('fs');
const path = require('path');
const steamcmd = require('./steamcmd');
const { installs } = require('./store');
const { tr, has } = require('./i18n');

const MAX_ATTEMPTS = 3;

class Installer {
  constructor({ getModsDir, findInstalledPath, onUpdate, onBatchDone, onStatus, discoverDependencies }) {
    this.tasks = new Map();
    this.running = false;
    this.cancelled = false;
    Object.assign(this, { getModsDir, findInstalledPath, onUpdate, onBatchDone, onStatus, discoverDependencies });
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => a.order - b.order);
  }

  emit() {
    this.onUpdate(this.list());
  }

  // items: [{ id, title, preview, size, timeUpdated, isDependency, isUpdate, activate }]
  enqueue(items) {
    this.add(items);
    this.process();
  }

  add(items) {
    let order = this.tasks.size;
    for (const item of items) {
      const existing = this.tasks.get(item.id);
      if (existing && ['queued', 'downloading', 'installing'].includes(existing.state)) continue;
      this.tasks.set(item.id, {
        ...item,
        state: 'queued',
        error: '',
        progress: 0,
        attempts: 0,
        order: order++
      });
    }
    this.emit();
  }

  clearFinished() {
    for (const [id, t] of this.tasks) if (t.state === 'done' || t.state === 'error') this.tasks.delete(id);
    this.emit();
  }

  cancel() {
    this.cancelled = true;
    for (const t of this.tasks.values()) {
      if (t.state === 'queued') Object.assign(t, { state: 'error', error: tr('dlerr.Cancelled') });
    }
    steamcmd.cancel();
    this.emit();
  }

  async process() {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    const installed = [];
    try {
      await steamcmd.ensure((msg) => this.onStatus(msg));
      while (!this.cancelled) {
        const batch = this.list().filter((t) => t.state === 'queued');
        if (!batch.length) break;
        batch.forEach((t) => {
          t.state = 'downloading';
          t.attempts++;
        });
        this.emit();

        const timer = setInterval(() => {
          let changed = false;
          for (const t of batch) {
            if (t.state !== 'downloading' || !t.size) continue;
            const p = Math.min(0.99, steamcmd.downloadedBytes(t.id) / t.size);
            if (Math.abs(p - t.progress) > 0.005) {
              t.progress = p;
              changed = true;
            }
          }
          if (changed) this.emit();
        }, 800);

        await steamcmd.downloadItems(batch.map((t) => t.id), (ev) => {
          const t = this.tasks.get(ev.id);
          if (!t) return;
          if (ev.type === 'success') {
            t.state = 'installing';
            this.emit();
            try {
              // Bleibt "installing", bis die Abhängigkeiten geprüft sind (siehe unten).
              t.installedPath = this.install(t, ev.path);
              t.progress = 1;
              installed.push(t);
            } catch (e) {
              t.state = 'error';
              t.error = e.message;
            }
          } else if (ev.type === 'error') {
            // Timeouts sind bei großen Mods normal – SteamCMD setzt beim nächsten Versuch fort.
            if (t.attempts < MAX_ATTEMPTS && !this.cancelled) t.state = 'queued';
            else Object.assign(t, { state: 'error', error: translateError(ev.reason) });
          }
          this.emit();
        });
        clearInterval(timer);

        // Abhängigkeiten aus der About.xml der frisch installierten Mods nachladen –
        // viele Autoren tragen z. B. Harmony nur dort ein, nicht auf der Workshop-Seite.
        const fresh = batch.filter((t) => t.state === 'installing' && t.installedPath && !t.depsChecked);
        fresh.forEach((t) => (t.depsChecked = true));
        if (fresh.length && this.discoverDependencies && !this.cancelled) {
          try {
            const extra = await this.discoverDependencies(fresh);
            if (extra.length) this.add(extra);
          } catch { /* Nachladen ist optional – fehlende Abhängigkeiten zeigt die Bibliothek an */ }
        }
        fresh.forEach((t) => (t.state = 'done'));
        this.emit();
      }
    } catch (e) {
      for (const t of this.tasks.values()) {
        if (t.state === 'installing' && t.installedPath) t.state = 'done';
        else if (['queued', 'downloading', 'installing'].includes(t.state)) Object.assign(t, { state: 'error', error: e.message });
      }
      this.emit();
    } finally {
      this.running = false;
      this.onStatus('');
      if (installed.length) this.onBatchDone(installed);
      // Während des Abschlusses hinzugefügte Items nicht liegen lassen.
      if (!this.cancelled && this.list().some((t) => t.state === 'queued')) this.process();
    }
  }

  install(task, downloadedPath) {
    const src = fs.existsSync(downloadedPath) ? downloadedPath : steamcmd.itemDir(task.id);
    if (!fs.existsSync(src)) throw new Error(tr('err.filesMissing'));
    const modsDir = this.getModsDir();
    if (!modsDir) throw new Error(tr('err.noModsDir'));
    fs.mkdirSync(modsDir, { recursive: true });

    const existing = this.findInstalledPath(task.id);
    const target = existing || path.join(modsDir, task.id);
    if (existing && fs.existsSync(path.join(existing, '.git'))) {
      throw new Error(tr('err.gitRepo'));
    }
    fs.rmSync(target, { recursive: true, force: true });
    try {
      fs.renameSync(src, target);
    } catch {
      fs.cpSync(src, target, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    const idFile = path.join(target, 'About', 'PublishedFileId.txt');
    if (fs.existsSync(path.dirname(idFile)) && !fs.existsSync(idFile)) fs.writeFileSync(idFile, task.id, 'utf8');

    installs.record(task.id, {
      title: task.title,
      timeUpdated: task.timeUpdated || Math.floor(Date.now() / 1000),
      installedAt: Date.now()
    });
    return target;
  }
}

// SteamCMD-Fehlergründe (z. B. "Timeout", "Access Denied") in lesbare Texte übersetzen.
function translateError(reason) {
  if (!reason) return tr('common.unknownError');
  return has('dlerr.' + reason) ? tr('dlerr.' + reason) : reason;
}

module.exports = { Installer };
