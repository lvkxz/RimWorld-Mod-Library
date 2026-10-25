/* global lucide, bbcode, escapeHtml */
'use strict';

// ====================================================================
// Zustand & Helfer
// ====================================================================
const state = {
  ctx: null,
  view: 'library',
  lib: null,
  installedWs: new Map(),   // workshopId -> lokaler Mod
  libFilter: 'all',
  libQuery: '',
  lo: { active: [], issues: {}, dirty: false, query: '' },
  ws: { query: '', sort: 'trend', days: 7, tag: 'Mod', page: 1, items: [], total: 0, totalPages: 1, loading: false, error: '' },
  updates: null,
  updatesLoading: false,
  queue: [],
  suggestions: null,
  suggestionsLoading: false,
  collection: null,
  collSelected: new Set(),
  collLoading: false,
  collInput: '',
  status: ''
};

const $ = (sel, root = document) => root.querySelector(sel);
const h = (s) => escapeHtml(String(s ?? ''));
const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}"></i>`;
const content = () => $('#content');
const refreshIcons = () => lucide.createIcons({ icons: lucide.icons });

const nf = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
const fmtNum = (n) => nf.format(n || 0);
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
function fmtSize(bytes) {
  if (!bytes) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function starsHtml(rating) {
  if (rating < 0) return '';
  let out = '<span class="stars" title="' + rating + ' von 5 Sternen">';
  for (let i = 1; i <= 5; i++) out += icon('star', i <= rating ? '' : 'off');
  return out + '</span>';
}
const versionNow = () => state.ctx?.version?.short || '';
const settings = () => state.ctx?.settings || {};

function toast(text, type = 'info') {
  const icons = { info: 'info', success: 'circle-check-big', warning: 'triangle-alert', error: 'circle-alert' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(icons[type] || 'info')}<span>${h(text)}</span>`;
  $('#toasts').appendChild(el);
  refreshIcons();
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 4200);
}

async function safe(fn, fallbackMsg) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || fallbackMsg || 'Unbekannter Fehler', 'error');
    return undefined;
  }
}

// ====================================================================
// Dialoge
// ====================================================================
function confirmDialog({ title, text, list = [], ok = 'OK', cancel = 'Abbrechen', danger = false, iconName = 'circle-alert' }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.className = 'modal small';
    modal.innerHTML = `
      <div class="confirm-body">
        <h3>${icon(iconName)}${h(title)}</h3>
        ${text ? `<p>${h(text)}</p>` : ''}
        ${list.length ? `<ul>${list.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="confirm-actions">
        <button class="btn" data-r="0">${h(cancel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${h(ok)}</button>
      </div>`;
    openModal();
    refreshIcons();
    modal.querySelectorAll('[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        state.modalResolve = null;
        closeModal();
        resolve(b.dataset.r === '1');
      })
    );
    state.modalResolve = () => resolve(false);
  });
}

function openModal() {
  $('#modalBackdrop').classList.add('open');
}
function closeModal() {
  $('#modalBackdrop').classList.remove('open');
  state.modalResolve?.();
  state.modalResolve = null;
  state.openWorkshopId = null;
}
function openDrawer(html) {
  $('#drawer').innerHTML = html;
  $('#drawer').classList.add('open');
  $('#drawerBackdrop').classList.add('open');
  refreshIcons();
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawerBackdrop').classList.remove('open');
  state.drawerMod = null;
}

// ====================================================================
// Daten laden
// ====================================================================
async function loadContext() {
  state.ctx = await window.api.context();
  document.documentElement.dataset.theme = state.ctx.settings.theme;
  const v = state.ctx.version;
  $('#gameMeta').textContent = state.ctx.gameFound
    ? `Version ${v.short || '?'} · ${state.ctx.settings.epicAppName ? 'Epic Games' : 'Lokal'}`
    : 'Nicht gefunden';
}

async function loadLibrary() {
  const lib = await safe(() => window.api.library());
  if (!lib) return;
  state.lib = lib;
  state.installedWs = new Map(lib.mods.filter((m) => m.workshopId).map((m) => [m.workshopId, m]));
  if (!state.lo.dirty) {
    state.lo.active = [...lib.active];
    state.lo.issues = lib.issues;
  }
  updateBadges();
}

function issueCount(issues) {
  return Object.values(issues || {}).reduce((n, list) => n + list.length, 0);
}

function updateBadges() {
  const set = (id, val) => {
    const el = $(id);
    el.textContent = val || '';
    el.classList.toggle('show', !!val);
  };
  const local = state.lib ? state.lib.mods.filter((m) => !m.official).length : 0;
  set('#badgeLibrary', local);
  set('#badgeIssues', issueCount(state.lo.dirty ? state.lo.issues : state.lib?.issues));
  set('#badgeUpdates', state.updates?.length || 0);
  const busy = state.queue.filter((t) => ['queued', 'downloading', 'installing'].includes(t.state)).length;
  set('#badgeDownloads', busy);
}

async function checkUpdates(silent = false) {
  state.updatesLoading = true;
  if (state.view === 'updates') render();
  try {
    state.updates = await window.api.checkUpdates();
  } catch (e) {
    if (!silent) toast(e.message, 'error');
  }
  state.updatesLoading = false;
  updateBadges();
  if (state.view === 'updates') render();
}

// ====================================================================
// Navigation
// ====================================================================
function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  content().scrollTop = 0;
  render();
}

function render() {
  const views = { library: viewLibrary, loadorder: viewLoadOrder, workshop: viewWorkshop, suggestions: viewSuggestions, updates: viewUpdates, collections: viewCollections, downloads: viewDownloads, settings: viewSettings };
  content().innerHTML = (views[state.view] || viewLibrary)();
  refreshIcons();
  afterRender[state.view]?.();
}
const afterRender = {};

// ====================================================================
// Gemeinsame Bausteine
// ====================================================================
function queueTask(id) {
  return state.queue.find((t) => t.id === id && ['queued', 'downloading', 'installing'].includes(t.state));
}

function installButton(item, { small = false } = {}) {
  const id = item.id;
  const sm = small ? 'btn-sm' : '';
  const task = queueTask(id);
  let inner;
  if (task) {
    const pct = task.state === 'downloading' && task.progress ? ` ${Math.round(task.progress * 100)} %` : '';
    const label = task.state === 'queued' ? 'Wartet …' : task.state === 'installing' ? 'Installiert …' : `Lädt${pct}`;
    inner = `<button class="btn ${sm}" disabled>${icon('loader-circle', 'spin')}${label}</button>`;
  } else if (state.installedWs.has(id)) {
    const hasUpdate = state.updates?.some((u) => u.id === id);
    inner = hasUpdate
      ? `<button class="btn btn-primary ${sm}" data-action="update" data-id="${id}">${icon('refresh-cw')}Update</button>`
      : `<button class="btn btn-ok ${sm}" data-action="showInstalled" data-id="${id}">${icon('check')}Installiert</button>`;
  } else {
    inner = `<button class="btn btn-primary ${sm}" data-action="install" data-id="${id}">${icon('download')}Installieren</button>`;
  }
  return `<span class="install-slot" data-slot="${id}" data-small="${small ? 1 : 0}">${inner}</span>`;
}

// Aktualisiert alle Installations-Buttons, ohne die Ansicht neu aufzubauen.
function patchInstallButtons() {
  document.querySelectorAll('.install-slot').forEach((slot) => {
    const html = installButton({ id: slot.dataset.slot }, { small: slot.dataset.small === '1' });
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    slot.replaceWith(tmp.firstElementChild);
  });
  refreshIcons();
}

function workshopCard(item) {
  const vNow = versionNow();
  const fits = !vNow || !item.versions.length || item.versions.includes(vNow);
  const installed = state.installedWs.has(item.id);
  return `
    <article class="card" data-action="openWorkshop" data-id="${item.id}">
      <div class="card-img">
        ${item.preview ? `<img src="${h(item.preview)}" loading="lazy" alt="">` : `<div class="placeholder">${icon('image-off')}</div>`}
        <div class="card-flags">
          <span>${installed ? `<span class="chip chip-ok">${icon('check')}Installiert</span>` : ''}</span>
          <span>${fits ? '' : `<span class="chip chip-warn" title="Unterstützt: ${h(item.versions.join(', '))}">${icon('triangle-alert')}${h(item.versions[0] || '?')}</span>`}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${h(item.title)}</div>
        <div class="card-sub">${item.author ? 'von ' + h(item.author) : '&nbsp;'}</div>
        ${item.shortDescription ? `<div class="card-desc">${h(item.shortDescription)}</div>` : ''}
        <div class="card-meta">
          <span title="Abonnenten">${icon('users')}${fmtNum(item.subscriptions)}</span>
          ${starsHtml(item.stars)}
          <span title="Zuletzt aktualisiert">${icon('clock')}${fmtDate(item.timeUpdated)}</span>
        </div>
      </div>
      <div class="card-foot">
        <span class="grow">${item.versions.slice(0, 3).map((v) => `<span class="chip ${v === vNow ? 'chip-accent' : ''}">${h(v)}</span>`).join(' ')}</span>
        ${installButton(item, { small: true })}
      </div>
    </article>`;
}

function skeletonCards(n = 8) {
  return Array.from({ length: n }, () => `
    <div class="card sk"><div class="card-img"><div class="skeleton"></div></div>
      <div class="card-body"><div class="skeleton" style="height:16px;width:80%"></div>
      <div class="skeleton" style="height:12px;width:50%"></div><div class="skeleton" style="height:12px;width:90%;margin-top:8px"></div></div></div>`).join('');
}

function modThumb(mod, cls = 'row-thumb') {
  return `<div class="${cls}">${mod?.previewUrl ? `<img src="${h(mod.previewUrl)}" loading="lazy" alt="">` : icon('package')}</div>`;
}

function sourceChip(mod) {
  if (mod.official) return `<span class="chip chip-accent">${icon('crown')}Offiziell</span>`;
  if (mod.workshopId) return `<span class="chip">${icon('store')}Workshop</span>`;
  return `<span class="chip">${icon('folder')}Lokal</span>`;
}

function issuesFor(pkg) {
  return state.lib?.issues?.[pkg] || [];
}

function issueChip(list) {
  if (!list.length) return '';
  const err = list.some((i) => i.level === 'error');
  return `<span class="chip ${err ? 'chip-err' : 'chip-warn'}" title="${h(list.map((i) => i.text).join('\n'))}">${icon(err ? 'circle-alert' : 'triangle-alert')}${list.length}</span>`;
}

// ====================================================================
// Ansicht: Bibliothek
// ====================================================================
function filteredMods() {
  const q = state.libQuery.trim().toLowerCase();
  return state.lib.mods.filter((m) => {
    if (q && !`${m.name} ${m.author} ${m.packageId}`.toLowerCase().includes(q)) return false;
    switch (state.libFilter) {
      case 'active': return m.active;
      case 'inactive': return !m.active;
      case 'issues': return issuesFor(m.packageId).length > 0 || !m.versionOk;
      case 'official': return m.official;
      default: return true;
    }
  });
}

function viewLibrary() {
  if (!state.ctx?.gameFound) {
    return `
      <div class="view-head"><div><h1>${icon('library')}Bibliothek</h1></div></div>
      <div class="callout err">${icon('circle-alert')}<div class="grow"><b>RimWorld wurde nicht gefunden</b>
      <p>Bitte wähle den Installationsordner von RimWorld in den Einstellungen aus.</p></div>
      <button class="btn btn-primary" data-action="nav" data-view="settings">${icon('settings')}Einstellungen</button></div>`;
  }
  if (!state.lib) return `<div class="empty">${icon('loader-circle', 'spin')}<p>Mods werden geladen …</p></div>`;

  const mods = state.lib.mods;
  const local = mods.filter((m) => !m.official);
  const active = mods.filter((m) => m.active).length;
  const issues = issueCount(state.lib.issues);
  const list = filteredMods();
  const view = settings().libraryView || 'grid';

  const filters = [
    ['all', 'Alle', 'layout-grid'], ['active', 'Aktiv', 'circle-check-big'], ['inactive', 'Inaktiv', 'ban'],
    ['issues', 'Probleme', 'triangle-alert'], ['official', 'Offiziell', 'crown']
  ];

  let body;
  if (!local.length && state.libFilter === 'all' && !state.libQuery) {
    body = `
      <div class="empty">${icon('package')}<h3>Noch keine Mods installiert</h3>
        <p>Stöbere im Steam Workshop oder schau dir unsere Vorschläge für den Einstieg an.</p>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-primary" data-action="nav" data-view="suggestions">${icon('sparkles')}Vorschläge ansehen</button>
          <button class="btn" data-action="nav" data-view="workshop">${icon('compass')}Workshop durchsuchen</button>
        </div>
      </div>
      <div class="section-head"><h2>${icon('crown')}Offizielle Inhalte</h2></div>
      <div class="grid">${mods.filter((m) => m.official).map(libCard).join('')}</div>`;
  } else if (!list.length) {
    body = `<div class="empty">${icon('search')}<h3>Keine Treffer</h3><p>Passe Suche oder Filter an.</p></div>`;
  } else if (view === 'list') {
    body = `<div class="list">${list.map(libRow).join('')}</div>`;
  } else {
    body = `<div class="grid">${list.map(libCard).join('')}</div>`;
  }

  return `
    <div class="view-head">
      <div><h1>${icon('library')}Bibliothek</h1><p>Deine installierten Mods für RimWorld ${h(versionNow())}</p></div>
      <div class="view-actions">
        <button class="btn" data-action="openPath" data-path="${h(settings().modsDir)}">${icon('folder-open')}Mods-Ordner</button>
        <button class="btn btn-icon" data-action="reloadLibrary" title="Neu einlesen">${icon('rotate-ccw')}</button>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat">${icon('package')}<div><b>${local.length}</b><small>Mods installiert</small></div></div>
      <div class="stat ok">${icon('circle-check-big')}<div><b>${active}</b><small>Aktiv (inkl. Core/DLC)</small></div></div>
      <div class="stat ${issues ? 'warn' : 'ok'}">${icon(issues ? 'triangle-alert' : 'shield-alert')}<div><b>${issues}</b><small>${issues ? 'Hinweise zur Ladereihenfolge' : 'Keine Probleme'}</small></div></div>
      <div class="stat">${icon('refresh-cw')}<div><b>${state.updates ? state.updates.length : '…'}</b><small>Updates verfügbar</small></div></div>
    </div>
    ${!state.lib.configExists ? `<div class="callout">${icon('info')}<div class="grow"><b>RimWorld wurde noch nie gestartet</b><p>Es gibt noch keine ModsConfig.xml. Sie wird automatisch angelegt, sobald du Mods aktivierst.</p></div></div>` : ''}
    <div class="toolbar">
      <div class="search-box">${icon('search')}<input class="input" id="libSearch" placeholder="Installierte Mods filtern …" value="${h(state.libQuery)}"></div>
      <div class="segmented">${filters.map(([k, l, i]) => `<button class="${state.libFilter === k ? 'active' : ''}" data-action="libFilter" data-filter="${k}">${icon(i)}${l}</button>`).join('')}</div>
      <span class="grow"></span>
      <div class="segmented">
        <button class="${view === 'grid' ? 'active' : ''}" data-action="libView" data-mode="grid" title="Kacheln">${icon('layout-grid')}</button>
        <button class="${view === 'list' ? 'active' : ''}" data-action="libView" data-mode="list" title="Liste">${icon('list')}</button>
      </div>
    </div>
    ${body}`;
}
afterRender.library = () => {
  const input = $('#libSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    state.libQuery = input.value;
    const pos = input.selectionStart;
    render();
    const again = $('#libSearch');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
};

function modSwitch(mod) {
  const locked = mod.packageId === 'ludeon.rimworld';
  return `<button class="switch ${mod.active ? 'on' : ''}" data-action="toggleMod" data-pkg="${h(mod.packageId)}"
    title="${locked ? 'Core ist immer aktiv' : mod.active ? 'Deaktivieren' : 'Aktivieren'}" ${locked ? 'disabled' : ''}></button>`;
}

function libCard(mod) {
  const issues = issuesFor(mod.packageId);
  const vNow = versionNow();
  return `
    <article class="card ${mod.active ? '' : 'inactive'}" data-action="openMod" data-key="${h(mod.key)}">
      <div class="card-img">
        ${mod.previewUrl ? `<img src="${h(mod.previewUrl)}" loading="lazy" alt="">` : `<div class="placeholder">${icon('package')}</div>`}
        <div class="card-flags">
          <span>${mod.active ? `<span class="chip chip-ok">${icon('check')}Aktiv</span>` : ''}</span>
          <span>${issueChip(issues)}${!mod.versionOk ? ` <span class="chip chip-warn" title="Nicht für ${h(vNow)} markiert">${icon('triangle-alert')}${h(mod.supportedVersions.slice(-1)[0] || '')}</span>` : ''}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${h(mod.name)}</div>
        <div class="card-sub">${mod.author ? 'von ' + h(mod.author) : h(mod.packageId)}</div>
        <div class="card-meta">${mod.supportedVersions.slice(-3).map((v) => `<span class="chip ${v === vNow ? 'chip-accent' : ''}">${h(v)}</span>`).join('')}</div>
      </div>
      <div class="card-foot">
        ${modSwitch(mod)}
        <span class="grow">${mod.active ? `Ladeposition ${mod.loadIndex + 1}` : 'Inaktiv'}</span>
        ${sourceChip(mod)}
      </div>
    </article>`;
}

function libRow(mod) {
  const issues = issuesFor(mod.packageId);
  return `
    <div class="row ${mod.active ? '' : 'inactive'}" data-action="openMod" data-key="${h(mod.key)}">
      ${modSwitch(mod)}
      ${modThumb(mod)}
      <div class="row-main">
        <div class="row-title">${h(mod.name)}</div>
        <div class="row-sub">${h(mod.author || '')} · ${h(mod.packageId)}</div>
      </div>
      <div class="row-chips">
        ${issueChip(issues)}
        ${mod.supportedVersions.slice(-2).map((v) => `<span class="chip ${v === versionNow() ? 'chip-accent' : ''}">${h(v)}</span>`).join('')}
        ${sourceChip(mod)}
      </div>
    </div>`;
}

function modByKey(key) {
  return state.lib?.mods.find((m) => m.key === key);
}
function modByPkg(pkg) {
  return state.lib?.mods.find((m) => m.packageId === pkg);
}

function depStatus(dep) {
  const installed = modByPkg(dep.packageId) || (dep.workshopId && state.installedWs.get(dep.workshopId));
  if (!installed) return 'miss';
  return installed.active ? 'ok' : 'inactive';
}

function openModDrawer(mod) {
  state.drawerMod = mod.key;
  const issues = issuesFor(mod.packageId);
  const vNow = versionNow();
  const deps = mod.dependencies.map((d) => {
    const st = depStatus(d);
    const label = { ok: 'Aktiv', inactive: 'Installiert, nicht aktiv', miss: 'Nicht installiert' }[st];
    const ic = { ok: 'circle-check-big', inactive: 'circle-alert', miss: 'circle-alert' }[st];
    let btn = '';
    if (st === 'inactive') btn = `<button class="btn btn-sm" data-action="activatePkg" data-pkg="${h(d.packageId)}">${icon('plus')}Aktivieren</button>`;
    if (st === 'miss' && d.workshopId) btn = installButton({ id: d.workshopId }, { small: true });
    if (st === 'miss' && !d.workshopId) btn = `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(d.displayName)}">${icon('search')}Suchen</button>`;
    return `<div class="dep ${st}">${icon(ic)}<div class="grow"><b>${h(d.displayName)}</b><br><small class="card-sub">${label}</small></div>${btn}</div>`;
  }).join('');

  openDrawer(`
    <div class="detail-hero">
      ${mod.previewUrl ? `<img class="bg" src="${h(mod.previewUrl)}" alt=""><img class="fg" src="${h(mod.previewUrl)}" alt="">` : `<div class="placeholder" style="position:absolute;inset:0;display:grid;place-items:center;color:var(--text-3)">${icon('package')}</div>`}
      <button class="btn btn-icon detail-close" data-action="closeDrawer">${icon('x')}</button>
    </div>
    <div class="detail-body">
      <h2 class="detail-title">${h(mod.name)}</h2>
      <div class="detail-author">${mod.author ? 'von ' + h(mod.author) : ''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${sourceChip(mod)}
        ${mod.active ? `<span class="chip chip-ok">${icon('check')}Aktiv · Position ${mod.loadIndex + 1}</span>` : `<span class="chip">${icon('ban')}Inaktiv</span>`}
        ${mod.supportedVersions.map((v) => `<span class="chip ${v === vNow ? 'chip-accent' : ''}">${h(v)}</span>`).join('')}
      </div>
      <div class="detail-actions">
        ${mod.packageId === 'ludeon.rimworld' ? '' : mod.active
          ? `<button class="btn" data-action="toggleMod" data-pkg="${h(mod.packageId)}">${icon('ban')}Deaktivieren</button>`
          : `<button class="btn btn-primary" data-action="toggleMod" data-pkg="${h(mod.packageId)}">${icon('circle-check-big')}Aktivieren</button>`}
        <button class="btn" data-action="openPath" data-path="${h(mod.path)}">${icon('folder-open')}Ordner</button>
        ${mod.workshopId ? `<button class="btn" data-action="openWorkshop" data-id="${mod.workshopId}">${icon('store')}Workshop-Details</button>` : ''}
        ${mod.workshopId && !mod.official ? `<button class="btn" data-action="update" data-id="${mod.workshopId}" title="Neueste Version herunterladen">${icon('refresh-cw')}Neu laden</button>` : ''}
        ${mod.official ? '' : `<button class="btn btn-danger" data-action="uninstall" data-key="${h(mod.key)}">${icon('trash-2')}Entfernen</button>`}
      </div>
      ${!mod.versionOk ? `<div class="callout warn">${icon('triangle-alert')}<div class="grow"><b>Nicht für RimWorld ${h(vNow)} markiert</b><p>Der Mod unterstützt laut About.xml: ${h(mod.supportedVersions.join(', '))}. Er kann trotzdem funktionieren.</p></div></div>` : ''}
      ${issues.length ? `<div class="detail-section"><h4>${icon('triangle-alert')}Hinweise</h4><div class="dep-list">${issues.map(issueRow.bind(null, mod.packageId)).join('')}</div></div>` : ''}
      ${mod.dependencies.length ? `<div class="detail-section"><h4>${icon('link')}Abhängigkeiten</h4><div class="dep-list">${deps}</div></div>` : ''}
      <div class="detail-section"><h4>${icon('info')}Details</h4>
        <dl class="kv">
          <dt>Package-ID</dt><dd><code>${h(mod.packageId)}</code></dd>
          ${mod.modVersion ? `<dt>Mod-Version</dt><dd>${h(mod.modVersion)}</dd>` : ''}
          ${mod.workshopId ? `<dt>Workshop-ID</dt><dd><code>${h(mod.workshopId)}</code></dd>` : ''}
          <dt>Ordner</dt><dd><code>${h(mod.path)}</code></dd>
          ${mod.url ? `<dt>Website</dt><dd><a href="${h(mod.url)}" target="_blank">${h(mod.url)}</a></dd>` : ''}
          ${mod.loadAfter.length ? `<dt>Lädt nach</dt><dd>${h(mod.loadAfter.join(', '))}</dd>` : ''}
          ${mod.loadBefore.length ? `<dt>Lädt vor</dt><dd>${h(mod.loadBefore.join(', '))}</dd>` : ''}
          ${mod.incompatibleWith.length ? `<dt>Inkompatibel</dt><dd>${h(mod.incompatibleWith.join(', '))}</dd>` : ''}
        </dl>
      </div>
      ${mod.description ? `<div class="detail-section"><h4>${icon('list')}Beschreibung</h4><div class="bb bb-plain">${h(mod.description)}</div></div>` : ''}
    </div>`);
}

function issueRow(pkg, issue) {
  const err = issue.level === 'error';
  let btn = '';
  if (issue.fix?.type === 'activate') btn = `<button class="btn btn-sm" data-action="activatePkg" data-pkg="${h(issue.fix.packageId)}">${icon('plus')}Aktivieren</button>`;
  if (issue.fix?.type === 'install' && issue.fix.workshopId) btn = installButton({ id: issue.fix.workshopId }, { small: true });
  if (issue.fix?.type === 'install' && !issue.fix.workshopId) btn = `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(issue.fix.name)}">${icon('search')}Suchen</button>`;
  if (issue.fix?.type === 'sort') btn = `<button class="btn btn-sm" data-action="autoSortNow">${icon('wand-sparkles')}Sortieren</button>`;
  return `<div class="dep ${err ? 'miss' : 'inactive'}">${icon(err ? 'circle-alert' : 'triangle-alert')}<div class="grow">${h(issue.text)}</div>${btn}</div>`;
}

// Aktivieren inkl. installierter, inaktiver Abhängigkeiten; Deaktivieren mit Rückfrage bei abhängigen Mods.
async function toggleMod(pkg, forceOn) {
  const mod = modByPkg(pkg);
  if (!mod || !state.lib) return;
  const on = forceOn ?? !mod.active;
  let active = [...state.lib.active];

  if (on) {
    const add = [];
    const missing = [];
    const visit = (m) => {
      if (!m || add.includes(m.packageId) || active.includes(m.packageId)) return;
      for (const d of m.dependencies) {
        const dm = modByPkg(d.packageId);
        if (dm) visit(dm);
        else missing.push(d);
      }
      add.push(m.packageId);
    };
    visit(mod);
    active = [...active, ...add];
    await saveActive(active, settings().autoSortOnInstall, add.length > 1 ? `${add.length} Mods aktiviert (inkl. Abhängigkeiten)` : `„${mod.name}“ aktiviert`);
    const installable = missing.filter((d) => d.workshopId);
    if (missing.length) {
      const ok = await confirmDialog({
        title: 'Fehlende Abhängigkeiten',
        text: `„${mod.name}“ benötigt Mods, die noch nicht installiert sind:`,
        list: missing.map((d) => d.displayName),
        ok: installable.length ? 'Jetzt installieren' : 'OK',
        iconName: 'link'
      });
      if (ok && installable.length) installWorkshop(installable.map((d) => d.workshopId));
    }
  } else {
    const dependents = state.lib.mods.filter((m) => m.active && m.dependencies.some((d) => d.packageId === pkg));
    if (dependents.length) {
      const ok = await confirmDialog({
        title: `„${mod.name}“ deaktivieren?`,
        text: 'Diese aktiven Mods benötigen ihn und funktionieren ohne ihn nicht:',
        list: dependents.map((m) => m.name),
        ok: 'Trotzdem deaktivieren',
        danger: true
      });
      if (!ok) return;
    }
    await saveActive(active.filter((id) => id !== pkg), false, `„${mod.name}“ deaktiviert`);
  }
}

async function saveActive(active, sort, message) {
  const lib = await safe(() => window.api.saveActive(active, { sort }));
  if (!lib) return false;
  state.lib = lib;
  state.installedWs = new Map(lib.mods.filter((m) => m.workshopId).map((m) => [m.workshopId, m]));
  state.lo = { ...state.lo, active: [...lib.active], issues: lib.issues, dirty: false };
  updateBadges();
  if (message) toast(message, 'success');
  rerenderKeepScroll();
  if (state.drawerMod) {
    const m = modByKey(state.drawerMod);
    if (m) openModDrawer(m);
  }
  return true;
}

function rerenderKeepScroll() {
  const top = content().scrollTop;
  render();
  content().scrollTop = top;
}

// ====================================================================
// Ansicht: Ladereihenfolge
// ====================================================================
function loIssues(pkg) {
  return state.lo.issues?.[pkg] || [];
}

function viewLoadOrder() {
  if (!state.lib) return `<div class="empty">${icon('loader-circle', 'spin')}</div>`;
  const activeSet = new Set(state.lo.active);
  const q = state.lo.query.toLowerCase();
  const inactive = state.lib.mods.filter((m) => !activeSet.has(m.packageId) && (!q || m.name.toLowerCase().includes(q)));
  const allIssues = state.lo.active.flatMap((pkg) => loIssues(pkg).map((i) => ({ pkg, ...i })));

  const activeRows = state.lo.active.map((pkg, i) => {
    const mod = modByPkg(pkg);
    const iss = loIssues(pkg);
    const err = iss.some((x) => x.level === 'error');
    return `
      <div class="lo-item ${mod?.official ? 'lo-official' : ''}" draggable="true" data-pkg="${h(pkg)}" data-list="active">
        <span class="grip">${icon('grip-vertical')}</span>
        <span class="idx">${i + 1}</span>
        ${modThumb(mod, 'lo-thumb')}
        <span class="lo-name" data-action="${mod ? 'openMod' : ''}" data-key="${h(mod?.key || '')}">${h(mod?.name || pkg)}${mod?.official ? '<small>Offiziell</small>' : ''}${!mod ? '<small>nicht installiert</small>' : ''}</span>
        ${iss.length ? `<span class="lo-issue ${err ? 'err' : ''}" title="${h(iss.map((x) => x.text).join('\n'))}">${icon(err ? 'circle-alert' : 'triangle-alert')}</span>` : ''}
        <span class="lo-actions">
          <button class="btn btn-ghost btn-sm btn-icon" data-action="loMove" data-pkg="${h(pkg)}" data-dir="-1" title="Nach oben">${icon('arrow-up')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-action="loMove" data-pkg="${h(pkg)}" data-dir="1" title="Nach unten">${icon('arrow-down')}</button>
          ${pkg === 'ludeon.rimworld' ? '' : `<button class="btn btn-ghost btn-sm btn-icon" data-action="loRemove" data-pkg="${h(pkg)}" title="Deaktivieren">${icon('minus')}</button>`}
        </span>
      </div>`;
  }).join('');

  const inactiveRows = inactive.map((mod) => `
    <div class="lo-item" draggable="true" data-pkg="${h(mod.packageId)}" data-list="inactive">
      ${modThumb(mod, 'lo-thumb')}
      <span class="lo-name" data-action="openMod" data-key="${h(mod.key)}">${h(mod.name)}</span>
      ${!mod.versionOk ? `<span class="lo-issue" title="Nicht für ${h(versionNow())} markiert">${icon('triangle-alert')}</span>` : ''}
      <button class="btn btn-ghost btn-sm btn-icon" data-action="loAdd" data-pkg="${h(mod.packageId)}" title="Aktivieren">${icon('plus')}</button>
    </div>`).join('');

  return `
    <div class="view-head">
      <div><h1>${icon('list-ordered')}Ladereihenfolge</h1><p>Ziehe Mods per Drag &amp; Drop. Bibliotheken wie Harmony gehören nach oben.</p></div>
      <div class="view-actions">
        <button class="btn" data-action="loAutoSort">${icon('wand-sparkles')}Automatisch sortieren</button>
        <button class="btn btn-primary" data-action="loSave" ${state.lo.dirty ? '' : 'disabled'}>${icon('save')}Speichern</button>
      </div>
    </div>
    <div class="lo-wrap">
      <section class="panel">
        <div class="panel-head"><h3>${icon('ban')}Inaktiv</h3><span class="count">${inactive.length}</span>
          <div class="search-box">${icon('search')}<input class="input" id="loSearch" placeholder="Filtern …" value="${h(state.lo.query)}"></div></div>
        <div class="panel-body" data-dropzone="inactive">${inactiveRows || '<div class="empty-mini">Alle installierten Mods sind aktiv.</div>'}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>${icon('circle-check-big')}Aktiv</h3><span class="count">${state.lo.active.length} Mods · von oben nach unten geladen</span></div>
        <div class="panel-body" data-dropzone="active">${activeRows}</div>
      </section>
    </div>
    <section class="panel issues">
      <div class="panel-head"><h3>${icon(allIssues.length ? 'triangle-alert' : 'shield-alert')}${allIssues.length ? `${allIssues.length} Hinweise` : 'Keine Probleme gefunden'}</h3></div>
      ${allIssues.map((i) => {
        const mod = modByPkg(i.pkg);
        return `<div class="issue ${i.level === 'error' ? 'err' : ''}">${icon(i.level === 'error' ? 'circle-alert' : 'triangle-alert')}
          <div class="issue-text"><b>${h(mod?.name || i.pkg)}</b>: ${h(i.text)}</div>${issueFixButton(i)}</div>`;
      }).join('')}
    </section>
    ${state.lo.dirty ? `
      <div class="dirty-bar"><span class="grow">${icon('triangle-alert')}Ungespeicherte Änderungen an der Ladereihenfolge</span>
        <button class="btn" data-action="loDiscard">${icon('undo-2')}Verwerfen</button>
        <button class="btn btn-primary" data-action="loSave">${icon('save')}Speichern</button></div>` : ''}`;
}

function issueFixButton(i) {
  if (i.fix?.type === 'activate') return `<button class="btn btn-sm" data-action="loAdd" data-pkg="${h(i.fix.packageId)}" data-before="${h(i.pkg)}">${icon('plus')}Aktivieren</button>`;
  if (i.fix?.type === 'install' && i.fix.workshopId) return installButton({ id: i.fix.workshopId }, { small: true });
  if (i.fix?.type === 'install') return `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(i.fix.name)}">${icon('search')}Suchen</button>`;
  if (i.fix?.type === 'sort') return `<button class="btn btn-sm" data-action="loAutoSort">${icon('wand-sparkles')}Sortieren</button>`;
  return '';
}

async function loChanged(list) {
  state.lo.active = list;
  state.lo.dirty = true;
  state.lo.issues = (await safe(() => window.api.analyze(list))) || {};
  updateBadges();
  rerenderKeepScroll();
}

afterRender.loadorder = () => {
  const search = $('#loSearch');
  search?.addEventListener('input', () => {
    state.lo.query = search.value;
    const pos = search.selectionStart;
    rerenderKeepScroll();
    const again = $('#loSearch');
    again.focus();
    again.setSelectionRange(pos, pos);
  });

  let dragPkg = null;
  let dragFrom = null;
  const clear = () => document.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  content().querySelectorAll('.lo-item[draggable]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragPkg = el.dataset.pkg;
      dragFrom = el.dataset.list;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clear();
    });
  });
  const activeZone = content().querySelector('[data-dropzone="active"]');
  const inactiveZone = content().querySelector('[data-dropzone="inactive"]');
  activeZone?.addEventListener('dragover', (e) => {
    if (!dragPkg) return;
    e.preventDefault();
    clear();
    const item = e.target.closest('.lo-item');
    if (item && item.dataset.list === 'active') {
      const r = item.getBoundingClientRect();
      item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    }
  });
  activeZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    const item = e.target.closest('.lo-item');
    const list = state.lo.active.filter((p) => p !== dragPkg);
    let idx = list.length;
    if (item && item.dataset.list === 'active' && item.dataset.pkg !== dragPkg) {
      const r = item.getBoundingClientRect();
      idx = list.indexOf(item.dataset.pkg) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
    } else if (item?.dataset.pkg === dragPkg) {
      idx = state.lo.active.indexOf(dragPkg);
    }
    list.splice(idx, 0, dragPkg);
    clear();
    dragPkg = null;
    loChanged(list);
  });
  inactiveZone?.addEventListener('dragover', (e) => {
    if (dragFrom === 'active' && dragPkg !== 'ludeon.rimworld') e.preventDefault();
  });
  inactiveZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    const pkg = dragPkg;
    dragPkg = null;
    loChanged(state.lo.active.filter((p) => p !== pkg));
  });
};

// ====================================================================
// Ansicht: Workshop
// ====================================================================
function viewWorkshop() {
  const ws = state.ws;
  const sorts = [['trend', 'Im Trend', 'trending-up'], ['popular', 'Beliebteste', 'crown'], ['recent', 'Neueste', 'sparkles'], ['updated', 'Aktualisiert', 'refresh-cw']];
  if (ws.query) sorts.unshift(['relevance', 'Relevanz', 'search']);
  const types = [['', 'Alle'], ['Mod', 'Mods'], ['Translation', 'Übersetzungen'], ['Scenario', 'Szenarien']];
  const v = versionNow();
  let body;
  if (ws.error) {
    body = `<div class="empty">${icon('circle-alert')}<h3>Workshop nicht erreichbar</h3><p>${h(ws.error)}</p>
      <button class="btn" data-action="wsSearch">${icon('rotate-ccw')}Erneut versuchen</button></div>`;
  } else if (ws.loading && !ws.items.length) {
    body = `<div class="grid">${skeletonCards(12)}</div>`;
  } else if (!ws.items.length) {
    body = `<div class="empty">${icon('search')}<h3>Nichts gefunden</h3><p>Versuche andere Suchbegriffe oder Filter.</p></div>`;
  } else {
    body = `<div class="grid">${ws.items.map(workshopCard).join('')}${ws.loading ? skeletonCards(4) : ''}</div>
      ${ws.page < ws.totalPages && !ws.loading ? `<div class="load-more"><button class="btn" data-action="wsMore">${icon('plus')}Mehr laden</button></div>` : ''}`;
  }
  return `
    <div class="view-head">
      <div><h1>${icon('compass')}Steam Workshop</h1><p>${ws.total ? `${ws.total.toLocaleString('de-DE')} Ergebnisse` : 'Mods direkt aus dem RimWorld-Workshop'}${settings().versionFilter && v ? ` für Version ${h(v)}` : ''}</p></div>
    </div>
    <div class="toolbar">
      <div class="search-box large" style="flex:1">${icon('search')}<input class="input" id="wsQuery" placeholder="Nach Mods suchen, z. B. „Vanilla Expanded“, „Hospitality“, „Combat Extended“ …" value="${h(ws.query)}"></div>
      <button class="btn btn-primary" style="height:44px" data-action="wsSearch">${icon('search')}Suchen</button>
    </div>
    <div class="toolbar">
      <div class="segmented">${sorts.map(([k, l, i]) => `<button class="${ws.sort === k ? 'active' : ''}" data-action="wsSort" data-sort="${k}">${icon(i)}${l}</button>`).join('')}</div>
      ${ws.sort === 'trend' ? `<select class="select" id="wsDays">${[[1, 'Heute'], [7, 'Diese Woche'], [30, 'Diesen Monat'], [90, '3 Monate'], [365, 'Dieses Jahr']].map(([d, l]) => `<option value="${d}" ${ws.days === d ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      <span class="grow"></span>
      ${types.map(([t, l]) => `<button class="chip-btn ${ws.tag === t ? 'active' : ''}" data-action="wsTag" data-tag="${t}">${l}</button>`).join('')}
      ${v ? `<button class="chip-btn ${settings().versionFilter ? 'active' : ''}" data-action="wsVersion" title="Nur Mods für deine Spielversion">${icon('filter')} Nur ${h(v)}</button>` : ''}
    </div>
    ${body}`;
}
afterRender.workshop = () => {
  const q = $('#wsQuery');
  q?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') wsSearch();
  });
  $('#wsDays')?.addEventListener('change', (e) => {
    state.ws.days = +e.target.value;
    wsSearch();
  });
  if (!state.ws.items.length && !state.ws.loading && !state.ws.error && !state.ws.started) wsSearch();
};

async function wsSearch(more = false) {
  const ws = state.ws;
  const input = $('#wsQuery');
  if (input && !more) {
    const newQuery = input.value.trim();
    if (newQuery && newQuery !== ws.query && ws.sort === 'trend') ws.sort = 'relevance';
    if (!newQuery && ws.sort === 'relevance') ws.sort = 'trend';
    ws.query = newQuery;
  }
  ws.started = true;
  ws.error = '';
  ws.page = more ? ws.page + 1 : 1;
  if (!more) ws.items = [];
  ws.loading = true;
  const token = (ws.token = Symbol('search'));
  if (state.view === 'workshop') rerenderKeepScroll();
  try {
    const res = await window.api.browse({
      query: ws.query,
      sort: ws.sort,
      days: ws.days,
      page: ws.page,
      version: settings().versionFilter ? versionNow() : '',
      tags: ws.tag ? [ws.tag] : []
    });
    if (token !== ws.token) return;
    const seen = new Set(ws.items.map((i) => i.id));
    ws.items.push(...res.items.filter((i) => !seen.has(i.id)));
    ws.total = res.total;
    ws.totalPages = res.totalPages;
  } catch (e) {
    if (token !== ws.token) return;
    ws.error = e.message;
  }
  ws.loading = false;
  if (state.view === 'workshop') rerenderKeepScroll();
}

async function openWorkshopModal(id) {
  const base = state.ws.items.find((i) => i.id === id)
    || state.suggestions && [...state.suggestions.essentials, ...state.suggestions.trending, ...state.suggestions.popular].find((i) => i.id === id)
    || state.collection?.items.find((i) => i.id === id);
  state.openWorkshopId = id;
  const modal = $('#modal');
  modal.className = 'modal';
  modal.innerHTML = workshopDetailHtml(base || { id, title: 'Wird geladen …', versions: [], tags: [] }, true);
  openModal();
  refreshIcons();
  const full = await safe(() => window.api.details(id));
  if (!full || state.openWorkshopId !== id) return;
  if (!full.author && base?.author) full.author = base.author;
  if (full.stars < 0 && base) Object.assign(full, { stars: base.stars, votes: base.votes });
  state.lastDetail = full;
  modal.innerHTML = workshopDetailHtml(full, false);
  refreshIcons();
}

function workshopDetailHtml(item, loading) {
  const v = versionNow();
  const fits = !v || !item.versions?.length || item.versions.includes(v);
  const installedMod = state.installedWs.get(item.id);
  const deps = (item.required || []).map((d) => {
    const inst = state.installedWs.get(d.id);
    const st = !inst ? 'miss' : inst.active ? 'ok' : 'inactive';
    return `<div class="dep ${st}">${icon(st === 'ok' ? 'circle-check-big' : 'circle-alert')}
      <div class="grow"><b>${h(d.name)}</b><br><small class="card-sub">${inst ? (inst.active ? 'Installiert & aktiv' : 'Installiert, nicht aktiv') : 'Wird automatisch mitinstalliert'}</small></div>
      <button class="btn btn-sm btn-ghost" data-action="openWorkshop" data-id="${d.id}">${icon('chevron-right')}</button></div>`;
  }).join('');
  const missingDeps = (item.required || []).filter((d) => !state.installedWs.has(d.id)).length;

  return `
    <div class="detail-hero">
      ${item.preview ? `<img class="bg" src="${h(item.preview)}" alt=""><img class="fg" src="${h(item.preview)}" alt="">` : ''}
      <button class="btn btn-icon detail-close" data-action="closeModal">${icon('x')}</button>
    </div>
    <div class="detail-body">
      <h2 class="detail-title">${h(item.title)}</h2>
      <div class="detail-author">${item.author ? 'von ' + h(item.author) : '&nbsp;'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${installedMod ? `<span class="chip chip-ok">${icon('check')}Installiert${installedMod.active ? ' & aktiv' : ''}</span>` : ''}
        ${(item.versions || []).map((x) => `<span class="chip ${x === v ? 'chip-accent' : ''}">${h(x)}</span>`).join('')}
        ${(item.tags || []).map((t) => `<span class="chip">${icon('tag')}${h(t)}</span>`).join('')}
      </div>
      <div class="detail-actions">
        ${installButton(item)}
        ${missingDeps && !installedMod ? `<span class="chip chip-accent" style="height:34px">${icon('link')}+ ${missingDeps} Abhängigkeit${missingDeps > 1 ? 'en' : ''}</span>` : ''}
        ${installedMod ? `<button class="btn" data-action="showInstalled" data-id="${item.id}">${icon('library')}In Bibliothek</button>` : ''}
        <button class="btn" data-action="openUrl" data-url="https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}">${icon('external-link')}Steam-Seite</button>
      </div>
      ${!fits ? `<div class="callout warn">${icon('triangle-alert')}<div class="grow"><b>Nicht für RimWorld ${h(v)} markiert</b><p>Unterstützte Versionen: ${h(item.versions.join(', '))}. Der Mod funktioniert evtl. nicht.</p></div></div>` : ''}
      ${item.requiredDlc?.length ? `<div class="callout warn">${icon('shield-alert')}<div class="grow"><b>Benötigt DLC: ${h(item.requiredDlc.join(', '))}</b><p>Stelle sicher, dass du diese Erweiterung(en) auch in deiner Epic-Version besitzt.</p></div></div>` : ''}
      <div class="detail-stats">
        <div class="detail-stat"><small>${icon('users')}Abonnenten</small><b>${fmtNum(item.subscriptions)}</b></div>
        <div class="detail-stat"><small>${icon('heart')}Favoriten</small><b>${fmtNum(item.favorited)}</b></div>
        <div class="detail-stat"><small>${icon('star')}Bewertung</small><b>${starsHtml(item.stars ?? -1) || '–'}</b></div>
        <div class="detail-stat"><small>${icon('hard-drive')}Größe</small><b>${fmtSize(item.size)}</b></div>
        <div class="detail-stat"><small>${icon('calendar')}Erstellt</small><b>${fmtDate(item.timeCreated)}</b></div>
        <div class="detail-stat"><small>${icon('clock')}Aktualisiert</small><b>${fmtDate(item.timeUpdated)}</b></div>
      </div>
      ${loading ? `<div class="empty-mini">${icon('loader-circle', 'spin')} Details werden geladen …</div>` : ''}
      ${deps ? `<div class="detail-section"><h4>${icon('link')}Benötigte Mods</h4><div class="dep-list">${deps}</div></div>` : ''}
      ${item.screenshots?.length ? `<div class="detail-section"><h4>${icon('image-off', '')}Screenshots</h4><div class="shots">${item.screenshots.map((s) => `<img src="${h(s)}?imw=400" data-action="zoom" data-src="${h(s)}" loading="lazy" alt="">`).join('')}</div></div>` : ''}
      ${item.description ? `<div class="detail-section"><h4>${icon('list')}Beschreibung</h4><div class="bb">${bbcode(item.description)}</div></div>` : ''}
    </div>`;
}

// ====================================================================
// Ansicht: Vorschläge
// ====================================================================
function viewSuggestions() {
  const s = state.suggestions;
  if (!s) {
    return `
      <div class="view-head"><div><h1>${icon('sparkles')}Vorschläge</h1><p>Empfehlungen passend zu deiner Installation</p></div></div>
      <div class="section"><div class="section-head"><h2>${icon('crown')}Bewährte Grundausstattung</h2></div><div class="grid">${skeletonCards(8)}</div></div>`;
  }
  const missing = s.missing.filter((m) => !state.installedWs.has(m.workshopId));
  const fresh = (list) => list.filter((i) => !state.installedWs.has(i.id));
  const section = (title, sub, ic, list) => list.length ? `
    <section class="section">
      <div class="section-head"><h2>${icon(ic)}${title}</h2><p>${sub}</p></div>
      <div class="grid">${list.map(workshopCard).join('')}</div>
    </section>` : '';
  return `
    <div class="view-head">
      <div><h1>${icon('sparkles')}Vorschläge</h1><p>Empfehlungen passend zu deiner Installation (RimWorld ${h(versionNow())})</p></div>
      <div class="view-actions"><button class="btn" data-action="reloadSuggestions" ${state.suggestionsLoading ? 'disabled' : ''}>${icon('rotate-ccw', state.suggestionsLoading ? 'spin' : '')}Aktualisieren</button></div>
    </div>
    ${missing.length ? `
      <section class="section">
        <div class="callout err">${icon('link')}<div class="grow"><b>${missing.length} fehlende Abhängigkeit${missing.length > 1 ? 'en' : ''}</b>
          <p>Diese Mods werden von deinen installierten Mods benötigt.</p></div>
          ${missing.some((m) => m.workshopId) ? `<button class="btn btn-primary" data-action="installMissing">${icon('download')}Alle installieren</button>` : ''}
        </div>
        <div class="list">${missing.map((m) => `
          <div class="row" ${m.workshopId ? `data-action="openWorkshop" data-id="${m.workshopId}"` : ''}>
            <div class="row-thumb">${m.item?.preview ? `<img src="${h(m.item.preview)}" alt="">` : icon('package')}</div>
            <div class="row-main"><div class="row-title">${h(m.item?.title || m.displayName)}</div>
            <div class="row-sub">Benötigt von: ${h(m.requiredBy.join(', '))}</div></div>
            ${m.workshopId ? installButton({ id: m.workshopId }, { small: true }) : `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(m.displayName)}">${icon('search')}Suchen</button>`}
          </div>`).join('')}</div>
      </section>` : ''}
    ${section('Bewährte Grundausstattung', 'Beliebte Qualitäts-Mods, die fast jeder nutzt', 'crown', fresh(s.essentials))}
    ${section('Im Trend diese Woche', 'Was die Community gerade abonniert', 'flame', fresh(s.trending))}
    ${section('Beliebteste aller Zeiten', 'Die meistabonnierten Mods für deine Version', 'trending-up', fresh(s.popular))}`;
}
afterRender.suggestions = () => {
  if (!state.suggestions && !state.suggestionsLoading) loadSuggestions();
};
async function loadSuggestions() {
  state.suggestionsLoading = true;
  if (state.view === 'suggestions') render();
  const s = await safe(() => window.api.suggestions());
  state.suggestionsLoading = false;
  if (s) state.suggestions = s;
  if (state.view === 'suggestions') rerenderKeepScroll();
}

// ====================================================================
// Ansicht: Updates
// ====================================================================
function viewUpdates() {
  const list = state.updates || [];
  let body;
  if (state.updatesLoading && !state.updates) {
    body = `<div class="empty">${icon('loader-circle', 'spin')}<p>Suche nach Updates …</p></div>`;
  } else if (!list.length) {
    body = `<div class="empty">${icon('circle-check-big')}<h3>Alles aktuell</h3><p>Alle Workshop-Mods sind auf dem neuesten Stand.</p></div>`;
  } else {
    body = `<div class="list">${list.map((u) => `
      <div class="row" data-action="openWorkshop" data-id="${u.id}">
        <div class="row-thumb">${u.preview ? `<img src="${h(u.preview)}" alt="">` : icon('package')}</div>
        <div class="row-main"><div class="row-title">${h(u.localName || u.title)}</div>
          <div class="row-sub">Installiert: ${fmtDate(u.localTime)} → Workshop: ${fmtDate(u.timeUpdated)} · ${fmtSize(u.size)}</div></div>
        ${installButton(u, { small: true })}
      </div>`).join('')}</div>`;
  }
  return `
    <div class="view-head">
      <div><h1>${icon('refresh-cw')}Updates</h1><p>Vergleicht deine Workshop-Mods mit der aktuellen Version im Steam Workshop</p></div>
      <div class="view-actions">
        <button class="btn" data-action="checkUpdates" ${state.updatesLoading ? 'disabled' : ''}>${icon('rotate-ccw', state.updatesLoading ? 'spin' : '')}Erneut prüfen</button>
        ${list.length ? `<button class="btn btn-primary" data-action="updateAll">${icon('download')}Alle aktualisieren (${list.length})</button>` : ''}
      </div>
    </div>
    ${body}
    <p class="card-sub" style="margin-top:16px">Hinweis: Bei Mods, die nicht über diese App installiert wurden, wird das Ordnerdatum zum Vergleich verwendet.</p>`;
}

// ====================================================================
// Ansicht: Collections
// ====================================================================
function viewCollections() {
  const c = state.collection;
  let body = '';
  if (state.collLoading) {
    body = `<div class="empty">${icon('loader-circle', 'spin')}<p>Collection wird geladen …</p></div>`;
  } else if (c) {
    const v = versionNow();
    const installed = c.items.filter((i) => state.installedWs.has(i.id)).length;
    const selectable = c.items.filter((i) => !state.installedWs.has(i.id));
    const selected = selectable.filter((i) => state.collSelected.has(i.id));
    body = `
      <section class="panel">
        <div class="coll-head">
          ${c.preview ? `<img src="${h(c.preview)}" alt="">` : ''}
          <div class="grow"><h3>${h(c.title)}</h3><span class="card-sub">${c.items.length} Mods · ${installed} bereits installiert</span></div>
          <button class="btn" data-action="collSelect" data-all="1">${icon('square-check')}Alle</button>
          <button class="btn" data-action="collSelect" data-all="0">${icon('square')}Keine</button>
          <button class="btn btn-primary" data-action="collInstall" ${selected.length ? '' : 'disabled'}>${icon('download')}${selected.length} installieren</button>
        </div>
        ${c.items.map((i) => {
          const inst = state.installedWs.has(i.id);
          const fits = !v || !i.versions.length || i.versions.includes(v);
          return `
          <div class="row" data-action="openWorkshop" data-id="${i.id}">
            <input type="checkbox" data-action="collToggle" data-id="${i.id}" ${inst ? 'checked disabled' : state.collSelected.has(i.id) ? 'checked' : ''}>
            <div class="row-thumb">${i.preview ? `<img src="${h(i.preview)}" loading="lazy" alt="">` : icon('package')}</div>
            <div class="row-main"><div class="row-title">${h(i.title)}</div><div class="row-sub">${fmtNum(i.subscriptions)} Abonnenten · ${fmtSize(i.size)}</div></div>
            <div class="row-chips">
              ${inst ? `<span class="chip chip-ok">${icon('check')}Installiert</span>` : ''}
              ${!fits ? `<span class="chip chip-warn" title="${h(i.versions.join(', '))}">${icon('triangle-alert')}${h(i.versions[0] || '?')}</span>` : `<span class="chip chip-accent">${h(v)}</span>`}
            </div>
          </div>`;
        }).join('')}
      </section>`;
  } else {
    body = `<div class="empty">${icon('layers')}<h3>Collection importieren</h3>
      <p>Füge den Link einer Steam-Workshop-Collection ein, z. B. ein Modpack eines Streamers. Alle enthaltenen Mods kannst du mit einem Klick installieren.</p></div>`;
  }
  return `
    <div class="view-head"><div><h1>${icon('layers')}Collections</h1><p>Ganze Modpacks aus dem Steam Workshop übernehmen</p></div></div>
    <div class="toolbar">
      <div class="search-box large" style="flex:1">${icon('link')}<input class="input" id="collInput" placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…" value="${h(state.collInput)}"></div>
      <button class="btn btn-primary" style="height:44px" data-action="collLoad">${icon('layers')}Laden</button>
    </div>
    ${body}`;
}
afterRender.collections = () => {
  $('#collInput')?.addEventListener('keydown', (e) => e.key === 'Enter' && loadCollection());
};
async function loadCollection() {
  state.collInput = $('#collInput').value.trim();
  if (!state.collInput) return;
  state.collLoading = true;
  render();
  const c = await safe(() => window.api.collection(state.collInput));
  state.collLoading = false;
  if (c) {
    state.collection = c;
    const v = versionNow();
    state.collSelected = new Set(c.items.filter((i) => !state.installedWs.has(i.id) && (!v || !i.versions.length || i.versions.includes(v))).map((i) => i.id));
  }
  render();
}

// ====================================================================
// Ansicht: Downloads
// ====================================================================
function viewDownloads() {
  const q = state.queue;
  const labels = { queued: 'Wartet', downloading: 'Wird heruntergeladen', installing: 'Wird installiert', done: 'Fertig', error: 'Fehler' };
  const finished = q.some((t) => t.state === 'done' || t.state === 'error');
  const busy = q.some((t) => ['queued', 'downloading', 'installing'].includes(t.state));
  return `
    <div class="view-head">
      <div><h1>${icon('download')}Downloads</h1><p>Mods werden über SteamCMD (offizielles Valve-Tool) aus dem Workshop geladen</p></div>
      <div class="view-actions">
        ${finished ? `<button class="btn" data-action="queueClear">${icon('check')}Erledigte entfernen</button>` : ''}
        ${busy ? `<button class="btn btn-danger" data-action="queueCancel">${icon('x')}Abbrechen</button>` : ''}
      </div>
    </div>
    ${state.status ? `<div class="callout">${icon('loader-circle', 'spin')}<div class="grow"><b>${h(state.status)}</b><p>Beim ersten Download wird SteamCMD einmalig eingerichtet.</p></div></div>` : ''}
    ${q.length ? `<section class="panel">${q.map((t) => {
      const pct = Math.round((t.progress || 0) * 100);
      const indet = t.state === 'downloading' && !t.progress || t.state === 'installing';
      return `
        <div class="dl-item">
          <div class="dl-thumb">${t.preview ? `<img src="${h(t.preview)}" alt="">` : ''}</div>
          <div class="dl-main">
            <div class="dl-title">${h(t.title)}
              ${t.isDependency ? `<span class="chip">${icon('link')}Abhängigkeit</span>` : ''}
              ${t.isUpdate ? `<span class="chip chip-accent">${icon('refresh-cw')}Update</span>` : ''}
            </div>
            ${['queued', 'downloading', 'installing'].includes(t.state) ? `<div class="progress ${indet ? 'indeterminate' : ''}"><div style="width:${t.state === 'queued' ? 0 : pct}%"></div></div>` : ''}
            <div class="dl-sub ${t.state === 'error' ? 'err' : ''}">${labels[t.state]}${t.state === 'downloading' && t.progress ? ` · ${pct} % von ${fmtSize(t.size)}` : t.size ? ` · ${fmtSize(t.size)}` : ''}${t.error ? ` – ${h(t.error)}` : ''}</div>
          </div>
          ${t.state === 'done' ? `<span class="chip chip-ok">${icon('check')}Installiert</span>` : ''}
          ${t.state === 'error' ? `<button class="btn btn-sm" data-action="retry" data-id="${t.id}">${icon('rotate-ccw')}Erneut</button>` : ''}
        </div>`;
    }).join('')}</section>`
    : `<div class="empty">${icon('download')}<h3>Keine Downloads</h3><p>Installierte Mods aus dem Workshop erscheinen hier mit ihrem Fortschritt.</p></div>`}`;
}

// ====================================================================
// Ansicht: Einstellungen
// ====================================================================
function viewSettings() {
  const s = settings();
  const themes = [
    ['rimworld', 'RimWorld', 'flame', ['#16130f', '#231e18', '#e3a33c', '#2b251e']],
    ['dark', 'Dunkel', 'moon', ['#111317', '#1b1f25', '#5b8cff', '#22272e']],
    ['light', 'Hell', 'sun', ['#f4f5f7', '#ffffff', '#3b6ef5', '#eceef2']]
  ];
  const toggle = (key, title, sub) => `
    <div class="setting"><div class="label"><b>${title}</b><small>${sub}</small></div>
      <button class="switch ${s[key] ? 'on' : ''}" data-action="setToggle" data-key="${key}"></button></div>`;
  const pathRow = (key, title, sub) => `
    <div class="setting"><div class="label"><b>${title}</b><small>${sub}</small></div>
      <div class="path-field"><input class="input" value="${h(s[key])}" readonly>
        <button class="btn btn-icon" data-action="pickPath" data-key="${key}" title="Ändern">${icon('folder')}</button>
        <button class="btn btn-icon" data-action="openPath" data-path="${h(s[key])}" title="Öffnen">${icon('external-link')}</button></div></div>`;
  return `
    <div class="view-head"><div><h1>${icon('settings')}Einstellungen</h1></div></div>
    <div class="settings">
      <div class="setting-card"><h3>${icon('sun')}Design</h3>
        <div class="themes">${themes.map(([k, l, i, c]) => `
          <button class="theme-opt ${s.theme === k ? 'active' : ''}" data-action="setTheme" data-theme="${k}">
            <div class="theme-prev" style="background:${c[0]}"><div class="sb" style="background:${c[1]}"></div>
              <div class="mn"><i style="background:${c[3]}"></i><i style="background:${c[2]}"></i><i style="background:${c[3]}"></i><i style="background:${c[3]}"></i></div></div>
            <div class="theme-name">${icon(i)}${l}${s.theme === k ? icon('check') : ''}</div>
          </button>`).join('')}</div>
      </div>
      <div class="setting-card"><h3>${icon('gamepad-2')}Spiel</h3>
        ${pathRow('gameDir', 'RimWorld-Ordner', state.ctx.gameFound ? `Gefunden · Version ${h(state.ctx.version.full)}` : 'Nicht gefunden – bitte auswählen')}
        ${pathRow('modsDir', 'Mods-Ordner', 'Hier werden neue Mods installiert')}
        ${pathRow('configDir', 'Config-Ordner', 'Enthält ModsConfig.xml mit der aktiven Mod-Liste')}
        <div class="setting"><div class="label"><b>Spiel starten über</b><small>Epic startet mit Overlay und Cloud-Saves</small></div>
          <div class="segmented">
            <button class="${s.launchVia === 'epic' ? 'active' : ''}" data-action="setLaunch" data-via="epic" ${s.epicAppName ? '' : 'disabled'}>${icon('store')}Epic Launcher</button>
            <button class="${s.launchVia !== 'epic' ? 'active' : ''}" data-action="setLaunch" data-via="exe">${icon('play')}Direkt</button>
          </div></div>
      </div>
      <div class="setting-card"><h3>${icon('wand-sparkles')}Verhalten</h3>
        ${toggle('autoDependencies', 'Abhängigkeiten automatisch installieren', 'Benötigte Mods (z. B. Harmony) werden mit heruntergeladen')}
        ${toggle('autoActivate', 'Neue Mods automatisch aktivieren', 'Nach der Installation direkt in die aktive Mod-Liste aufnehmen')}
        ${toggle('autoSortOnInstall', 'Ladereihenfolge automatisch sortieren', 'Beim Aktivieren und Installieren nach Abhängigkeiten sortieren')}
        ${toggle('versionFilter', 'Workshop nach Spielversion filtern', `Nur Mods anzeigen, die RimWorld ${h(versionNow())} unterstützen`)}
      </div>
      <div class="setting-card"><h3>${icon('download')}SteamCMD</h3>
        <div class="setting"><div class="label"><b>Status</b><small>${state.ctx.steamcmdReady ? 'Eingerichtet und bereit' : 'Wird beim ersten Download automatisch eingerichtet'}</small></div>
          ${state.ctx.steamcmdReady ? `<span class="chip chip-ok">${icon('check')}Bereit</span>` : `<button class="btn" data-action="setupSteamcmd">${icon('download')}Jetzt einrichten</button>`}</div>
        <div class="setting"><div class="label"><b>Download-Cache leeren</b><small>Entfernt unvollständige Downloads von SteamCMD</small></div>
          <button class="btn" data-action="clearCache">${icon('trash-2')}Leeren</button></div>
      </div>
      <div class="setting-card"><h3>${icon('info')}Über</h3>
        <div class="setting"><div class="label"><b>RimWorld Mod Library ${h(state.ctx.appVersion)}</b>
          <small>Mods stammen aus dem Steam Workshop und werden anonym über Valves SteamCMD geladen. Alle Mods gehören ihren jeweiligen Autoren – unterstütze sie mit einem Like auf Steam.</small></div></div>
      </div>
    </div>`;
}

// ====================================================================
// Installation
// ====================================================================
async function installWorkshop(ids, opts = {}) {
  const res = await safe(() => window.api.install(ids, opts));
  if (!res) return;
  const deps = res.dependencies.length ? ` (inkl. ${res.dependencies.length} Abhängigkeit${res.dependencies.length > 1 ? 'en' : ''})` : '';
  toast(`${res.count} Mod${res.count > 1 ? 's' : ''} zur Download-Warteschlange hinzugefügt${deps}`, 'info');
}

// ====================================================================
// Aktionen (Event-Delegation über data-action)
// ====================================================================
const actions = {
  nav: (d) => setView(d.view),
  openPath: (d) => d.path && window.api.open(d.path),
  openUrl: (d) => window.api.open(d.url),
  closeDrawer,
  closeModal,
  reloadLibrary: async () => {
    await loadLibrary();
    render();
    toast('Bibliothek neu eingelesen', 'success');
  },
  libFilter: (d) => {
    state.libFilter = d.filter;
    render();
  },
  libView: async (d) => {
    state.ctx.settings = await window.api.setSettings({ libraryView: d.mode });
    render();
  },
  openMod: (d) => {
    const mod = modByKey(d.key);
    if (mod) openModDrawer(mod);
  },
  toggleMod: (d) => toggleMod(d.pkg),
  activatePkg: (d) => toggleMod(d.pkg, true),
  autoSortNow: () => saveActive(state.lib.active, true, 'Ladereihenfolge sortiert'),
  uninstall: async (d) => {
    const mod = modByKey(d.key);
    if (!mod) return;
    const ok = await confirmDialog({
      title: `„${mod.name}“ entfernen?`,
      text: 'Der Mod-Ordner wird in den Papierkorb verschoben und aus der aktiven Liste entfernt.',
      ok: 'Entfernen',
      danger: true,
      iconName: 'trash-2'
    });
    if (!ok) return;
    const lib = await safe(() => window.api.uninstall(mod.path));
    if (!lib) return;
    closeDrawer();
    state.lo.dirty = false;
    await loadLibrary();
    state.updates = state.updates?.filter((u) => u.id !== mod.workshopId);
    updateBadges();
    render();
    toast(`„${mod.name}“ entfernt`, 'success');
  },

  // Ladereihenfolge
  loMove: (d) => {
    const list = [...state.lo.active];
    const i = list.indexOf(d.pkg);
    const j = i + Number(d.dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    loChanged(list);
  },
  loRemove: (d) => loChanged(state.lo.active.filter((p) => p !== d.pkg)),
  loAdd: (d) => {
    const list = state.lo.active.filter((p) => p !== d.pkg);
    const before = d.before ? list.indexOf(d.before) : -1;
    if (before >= 0) list.splice(before, 0, d.pkg);
    else list.push(d.pkg);
    loChanged(list);
  },
  loAutoSort: async () => {
    const res = await safe(() => window.api.sortPreview(state.lo.active));
    if (!res) return;
    state.lo.active = res.active;
    state.lo.issues = res.issues;
    state.lo.dirty = true;
    updateBadges();
    if (state.view !== 'loadorder') setView('loadorder');
    else rerenderKeepScroll();
    toast('Sortiert – prüfen und speichern', 'info');
  },
  loSave: async () => {
    if (await saveActive(state.lo.active, false)) toast('Ladereihenfolge gespeichert', 'success');
  },
  loDiscard: () => {
    state.lo = { ...state.lo, active: [...state.lib.active], issues: state.lib.issues, dirty: false };
    updateBadges();
    rerenderKeepScroll();
  },

  // Workshop
  wsSearch: () => wsSearch(),
  wsMore: () => wsSearch(true),
  wsSort: (d) => {
    state.ws.sort = d.sort;
    wsSearch();
  },
  wsTag: (d) => {
    state.ws.tag = d.tag;
    wsSearch();
  },
  wsVersion: async () => {
    state.ctx.settings = await window.api.setSettings({ versionFilter: !settings().versionFilter });
    state.suggestions = null;
    wsSearch();
  },
  openWorkshop: (d) => {
    closeDrawer();
    openWorkshopModal(d.id);
  },
  searchWorkshop: (d) => {
    closeDrawer();
    closeModal();
    state.ws.query = d.q;
    state.ws.sort = 'relevance';
    setView('workshop');
    wsSearch();
  },
  install: (d) => installWorkshop([d.id]),
  update: (d) => installWorkshop([d.id], { isUpdate: true }),
  updateAll: () => installWorkshop(state.updates.map((u) => u.id), { isUpdate: true }),
  installMissing: () => {
    const ids = state.suggestions.missing.map((m) => m.workshopId).filter((id) => id && !state.installedWs.has(id));
    installWorkshop(ids);
  },
  showInstalled: (d) => {
    const mod = state.installedWs.get(d.id);
    closeModal();
    if (mod) {
      setView('library');
      openModDrawer(mod);
    }
  },
  zoom: (d) => {
    const lb = $('#lightbox');
    lb.querySelector('img').src = d.src;
    lb.classList.add('open');
  },
  reloadSuggestions: () => loadSuggestions(),
  checkUpdates: () => checkUpdates(),

  // Collections
  collLoad: () => loadCollection(),
  collToggle: (d, el) => {
    if (el.checked) state.collSelected.add(d.id);
    else state.collSelected.delete(d.id);
    rerenderKeepScroll();
  },
  collSelect: (d) => {
    state.collSelected = d.all === '1' ? new Set(state.collection.items.filter((i) => !state.installedWs.has(i.id)).map((i) => i.id)) : new Set();
    rerenderKeepScroll();
  },
  collInstall: () => {
    const ids = state.collection.items.filter((i) => state.collSelected.has(i.id) && !state.installedWs.has(i.id)).map((i) => i.id);
    installWorkshop(ids);
    setView('downloads');
  },

  // Downloads
  queueClear: () => window.api.clearQueue(),
  queueCancel: () => window.api.cancelQueue(),
  retry: (d) => {
    const t = state.queue.find((x) => x.id === d.id);
    installWorkshop([d.id], { isUpdate: t?.isUpdate, withDeps: false });
  },

  // Einstellungen
  setTheme: async (d) => {
    document.documentElement.dataset.theme = d.theme;
    state.ctx.settings = await window.api.setSettings({ theme: d.theme });
    render();
  },
  setToggle: async (d) => {
    state.ctx.settings = await window.api.setSettings({ [d.key]: !settings()[d.key] });
    if (d.key === 'versionFilter') {
      state.ws.items = [];
      state.ws.started = false;
      state.suggestions = null;
    }
    render();
  },
  setLaunch: async (d) => {
    state.ctx.settings = await window.api.setSettings({ launchVia: d.via });
    render();
  },
  pickPath: async (d) => {
    const titles = { gameDir: 'RimWorld-Ordner wählen', modsDir: 'Mods-Ordner wählen', configDir: 'Config-Ordner wählen' };
    const dir = await window.api.pickFolder(titles[d.key]);
    if (!dir) return;
    const patch = { [d.key]: dir };
    if (d.key === 'gameDir') Object.assign(patch, { modsDir: '', epicAppName: '' });
    await window.api.setSettings(patch);
    await loadContext();
    state.lo.dirty = false;
    await loadLibrary();
    render();
    if (d.key === 'gameDir' && !state.ctx.gameFound) toast('In diesem Ordner wurde keine RimWorldWin64.exe gefunden', 'warning');
  },
  setupSteamcmd: async () => {
    await safe(() => window.api.ensureSteamcmd());
    await loadContext();
    render();
  },
  clearCache: async () => {
    await safe(() => window.api.clearSteamcmdCache());
    toast('Cache geleert', 'success');
  }
};

document.addEventListener('click', (e) => {
  const spoiler = e.target.closest('.spoiler');
  if (spoiler) spoiler.classList.add('shown');
  const el = e.target.closest('[data-action]');
  if (!el || !el.dataset.action) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName !== 'INPUT') e.preventDefault();
  e.stopPropagation();
  fn(el.dataset, el, e);
});

// Navigation
document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#drawerBackdrop').addEventListener('click', closeDrawer);
$('#modalBackdrop').addEventListener('click', (e) => e.target.id === 'modalBackdrop' && closeModal());
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('open'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#lightbox').classList.contains('open')) $('#lightbox').classList.remove('open');
    else if ($('#modalBackdrop').classList.contains('open')) closeModal();
    else closeDrawer();
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#globalSearch').focus();
  }
});
$('#globalSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  state.ws.query = q;
  state.ws.sort = q ? 'relevance' : 'trend';
  e.target.value = '';
  e.target.blur();
  closeDrawer();
  closeModal();
  setView('workshop');
  wsSearch(false);
});
$('#btnLaunch').addEventListener('click', async () => {
  if (state.lo.dirty) {
    const ok = await confirmDialog({ title: 'Ungespeicherte Ladereihenfolge', text: 'Die Änderungen an der Ladereihenfolge sind noch nicht gespeichert. Jetzt speichern und starten?', ok: 'Speichern & starten', iconName: 'save' });
    if (!ok) return;
    if (!(await saveActive(state.lo.active, false))) return;
  }
  const ok = await safe(() => window.api.launchGame());
  if (ok) toast('RimWorld wird gestartet …', 'success');
});

// Events aus dem Hauptprozess
window.api.on('queue:update', (tasks) => {
  state.queue = tasks;
  updateBadges();
  if (state.view === 'downloads') rerenderKeepScroll();
  else patchInstallButtons();
});
window.api.on('status', (msg) => {
  state.status = msg;
  $('#globalStatus').innerHTML = msg ? `${icon('loader-circle', 'spin')}${h(msg)}` : '';
  refreshIcons();
  if (state.view === 'downloads') rerenderKeepScroll();
});
window.api.on('toast', (t) => toast(t.text, t.type));
window.api.on('library:changed', async () => {
  await loadLibrary();
  if (state.updates) state.updates = state.updates.filter((u) => !state.queue.some((t) => t.id === u.id && t.state === 'done'));
  updateBadges();
  if (state.view !== 'downloads') rerenderKeepScroll();
  else patchInstallButtons();
  if ($('#modalBackdrop').classList.contains('open') && state.openWorkshopId && state.lastDetail?.id === state.openWorkshopId) {
    $('#modal').innerHTML = workshopDetailHtml(state.lastDetail, false);
    refreshIcons();
  }
  window.api.context().then((c) => (state.ctx = c));
});

// Start
(async function init() {
  refreshIcons();
  await loadContext();
  setView('library');
  await loadLibrary();
  render();
  state.queue = await window.api.queue();
  updateBadges();
  if (state.ctx.gameFound) checkUpdates(true);
})();
