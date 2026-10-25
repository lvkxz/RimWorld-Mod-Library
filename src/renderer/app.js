/* global lucide, bbcode, escapeHtml, I18N */
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

const settings = () => state.ctx?.settings || {};
const lang = () => I18N.normalize(settings().language);
const t = (key, params) => I18N.translate(lang(), key, params);
const locale = () => I18N.locale(lang());

const fmtNum = (n) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const fmtInt = (n) => (n || 0).toLocaleString(locale());
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
function fmtSize(bytes) {
  if (!bytes) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(locale(), { maximumFractionDigits: n >= 100 || i === 0 ? 0 : 1 })} ${u[i]}`;
}
function starsHtml(rating) {
  if (rating < 0) return '';
  let out = `<span class="stars" title="${h(t('common.stars', { rating }))}">`;
  for (let i = 1; i <= 5; i++) out += icon('star', i <= rating ? '' : 'off');
  return out + '</span>';
}
const versionNow = () => state.ctx?.version?.short || '';
const by = (author) => t('common.by', { author });
const issueText = (issue) => t('issue.' + issue.code, issue.params);

// Feste Texte in index.html (data-i18n / data-i18n-placeholder) übersetzen.
function applyStaticTexts() {
  document.documentElement.lang = lang();
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  updateGameMeta();
}

function updateGameMeta() {
  if (!state.ctx) return;
  const v = state.ctx.version;
  $('#gameMeta').textContent = state.ctx.gameFound
    ? t('game.meta', { version: v.short || '?', source: state.ctx.settings.epicAppName ? 'Epic Games' : t('game.sourceLocal') })
    : t('game.notFound');
}

function toast(text, type = 'info') {
  const icons = { info: 'info', success: 'circle-check-big', warning: 'triangle-alert', error: 'circle-alert' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(icons[type] || 'info')}<span>${h(text)}</span>`;
  $('#toasts').appendChild(el);
  refreshIcons();
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 4200);
}

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || t('common.unknownError'), 'error');
    return undefined;
  }
}

// ====================================================================
// Dialoge
// ====================================================================
function confirmDialog({ title, text, list = [], ok = t('common.ok'), cancel = t('common.cancel'), danger = false, iconName = 'circle-alert' }) {
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
  applyStaticTexts();
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
  const busy = state.queue.filter((x) => ['queued', 'downloading', 'installing'].includes(x.state)).length;
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
  return state.queue.find((x) => x.id === id && ['queued', 'downloading', 'installing'].includes(x.state));
}

function installButton(item, { small = false } = {}) {
  const id = item.id;
  const sm = small ? 'btn-sm' : '';
  const task = queueTask(id);
  let inner;
  if (task) {
    const pct = task.state === 'downloading' && task.progress ? ` ${Math.round(task.progress * 100)} %` : '';
    const label = task.state === 'queued' ? t('common.waiting') : task.state === 'installing' ? t('common.installing') : t('common.downloading', { pct });
    inner = `<button class="btn ${sm}" disabled>${icon('loader-circle', 'spin')}${h(label)}</button>`;
  } else if (state.installedWs.has(id)) {
    const hasUpdate = state.updates?.some((u) => u.id === id);
    inner = hasUpdate
      ? `<button class="btn btn-primary ${sm}" data-action="update" data-id="${id}">${icon('refresh-cw')}${t('common.update')}</button>`
      : `<button class="btn btn-ok ${sm}" data-action="showInstalled" data-id="${id}">${icon('check')}${t('common.installed')}</button>`;
  } else {
    inner = `<button class="btn btn-primary ${sm}" data-action="install" data-id="${id}">${icon('download')}${t('common.install')}</button>`;
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
          <span>${installed ? `<span class="chip chip-ok">${icon('check')}${t('common.installed')}</span>` : ''}</span>
          <span>${fits ? '' : `<span class="chip chip-warn" title="${h(t('common.supports', { versions: item.versions.join(', ') }))}">${icon('triangle-alert')}${h(item.versions[0] || '?')}</span>`}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${h(item.title)}</div>
        <div class="card-sub">${item.author ? h(by(item.author)) : '&nbsp;'}</div>
        ${item.shortDescription ? `<div class="card-desc">${h(item.shortDescription)}</div>` : ''}
        <div class="card-meta">
          <span title="${h(t('common.subscribers'))}">${icon('users')}${fmtNum(item.subscriptions)}</span>
          ${starsHtml(item.stars)}
          <span title="${h(t('common.lastUpdated'))}">${icon('clock')}${fmtDate(item.timeUpdated)}</span>
        </div>
      </div>
      <div class="card-foot">
        <span class="grow">${item.versions.slice(0, 2).map((v) => `<span class="chip ${v === vNow ? 'chip-accent' : ''}">${h(v)}</span>`).join(' ')}</span>
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
  if (mod.official) return `<span class="chip chip-accent">${icon('crown')}${t('common.official')}</span>`;
  if (mod.workshopId) return `<span class="chip">${icon('store')}${t('common.workshop')}</span>`;
  return `<span class="chip">${icon('folder')}${t('common.local')}</span>`;
}

function issuesFor(pkg) {
  return state.lib?.issues?.[pkg] || [];
}

function issueChip(list) {
  if (!list.length) return '';
  const err = list.some((i) => i.level === 'error');
  return `<span class="chip ${err ? 'chip-err' : 'chip-warn'}" title="${h(list.map(issueText).join('\n'))}">${icon(err ? 'circle-alert' : 'triangle-alert')}${list.length}</span>`;
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
      <div class="view-head"><div><h1>${icon('library')}${t('lib.title')}</h1></div></div>
      <div class="callout err">${icon('circle-alert')}<div class="grow"><b>${t('lib.notFoundTitle')}</b>
      <p>${t('lib.notFoundText')}</p></div>
      <button class="btn btn-primary" data-action="nav" data-view="settings">${icon('settings')}${t('nav.settings')}</button></div>`;
  }
  if (!state.lib) return `<div class="empty">${icon('loader-circle', 'spin')}<p>${t('lib.loading')}</p></div>`;

  const mods = state.lib.mods;
  const local = mods.filter((m) => !m.official);
  const active = mods.filter((m) => m.active).length;
  const issues = issueCount(state.lib.issues);
  const list = filteredMods();
  const view = settings().libraryView || 'grid';

  const filters = [
    ['all', 'layout-grid'], ['active', 'circle-check-big'], ['inactive', 'ban'], ['issues', 'triangle-alert'], ['official', 'crown']
  ];

  let body;
  if (!local.length && state.libFilter === 'all' && !state.libQuery) {
    body = `
      <div class="empty">${icon('package')}<h3>${t('lib.emptyTitle')}</h3>
        <p>${t('lib.emptyText')}</p>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-primary" data-action="nav" data-view="suggestions">${icon('sparkles')}${t('lib.showSuggestions')}</button>
          <button class="btn" data-action="nav" data-view="workshop">${icon('compass')}${t('lib.browseWorkshop')}</button>
        </div>
      </div>
      <div class="section-head"><h2>${icon('crown')}${t('lib.officialContent')}</h2></div>
      <div class="grid">${mods.filter((m) => m.official).map(libCard).join('')}</div>`;
  } else if (!list.length) {
    body = `<div class="empty">${icon('search')}<h3>${t('lib.noResults')}</h3><p>${t('lib.noResultsText')}</p></div>`;
  } else if (view === 'list') {
    body = `<div class="list">${list.map(libRow).join('')}</div>`;
  } else {
    body = `<div class="grid">${list.map(libCard).join('')}</div>`;
  }

  return `
    <div class="view-head">
      <div><h1>${icon('library')}${t('lib.title')}</h1><p>${h(t('lib.subtitle', { version: versionNow() }))}</p></div>
      <div class="view-actions">
        <button class="btn" data-action="openPath" data-path="${h(settings().modsDir)}">${icon('folder-open')}${t('lib.modsFolder')}</button>
        <button class="btn btn-icon" data-action="reloadLibrary" title="${h(t('lib.rescan'))}">${icon('rotate-ccw')}</button>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat">${icon('package')}<div><b>${local.length}</b><small>${t('lib.statInstalled')}</small></div></div>
      <div class="stat ok">${icon('circle-check-big')}<div><b>${active}</b><small>${t('lib.statActive')}</small></div></div>
      <div class="stat ${issues ? 'warn' : 'ok'}">${icon(issues ? 'triangle-alert' : 'shield-alert')}<div><b>${issues}</b><small>${issues ? t('lib.statIssues') : t('lib.statNoIssues')}</small></div></div>
      <div class="stat">${icon('refresh-cw')}<div><b>${state.updates ? state.updates.length : '…'}</b><small>${t('lib.statUpdates')}</small></div></div>
    </div>
    ${!state.lib.configExists ? `<div class="callout">${icon('info')}<div class="grow"><b>${t('lib.neverStartedTitle')}</b><p>${t('lib.neverStartedText')}</p></div></div>` : ''}
    <div class="toolbar">
      <div class="search-box">${icon('search')}<input class="input" id="libSearch" placeholder="${h(t('lib.filterPlaceholder'))}" value="${h(state.libQuery)}"></div>
      <div class="segmented">${filters.map(([k, i]) => `<button class="${state.libFilter === k ? 'active' : ''}" data-action="libFilter" data-filter="${k}">${icon(i)}${t('lib.filter.' + k)}</button>`).join('')}</div>
      <span class="grow"></span>
      <div class="segmented">
        <button class="${view === 'grid' ? 'active' : ''}" data-action="libView" data-mode="grid" title="${h(t('lib.viewGrid'))}">${icon('layout-grid')}</button>
        <button class="${view === 'list' ? 'active' : ''}" data-action="libView" data-mode="list" title="${h(t('lib.viewList'))}">${icon('list')}</button>
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
  const title = locked ? t('lib.coreAlwaysActive') : mod.active ? t('common.deactivate') : t('common.activate');
  return `<button class="switch ${mod.active ? 'on' : ''}" data-action="toggleMod" data-pkg="${h(mod.packageId)}"
    title="${h(title)}" ${locked ? 'disabled' : ''}></button>`;
}

function libCard(mod) {
  const issues = issuesFor(mod.packageId);
  const vNow = versionNow();
  return `
    <article class="card ${mod.active ? '' : 'inactive'}" data-action="openMod" data-key="${h(mod.key)}">
      <div class="card-img">
        ${mod.previewUrl ? `<img src="${h(mod.previewUrl)}" loading="lazy" alt="">` : `<div class="placeholder">${icon('package')}</div>`}
        <div class="card-flags">
          <span>${mod.active ? `<span class="chip chip-ok">${icon('check')}${t('common.active')}</span>` : ''}</span>
          <span>${issueChip(issues)}${!mod.versionOk ? ` <span class="chip chip-warn" title="${h(t('common.notMarkedFor', { version: vNow }))}">${icon('triangle-alert')}${h(mod.supportedVersions.slice(-1)[0] || '')}</span>` : ''}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${h(mod.name)}</div>
        <div class="card-sub">${mod.author ? h(by(mod.author)) : h(mod.packageId)}</div>
        <div class="card-meta">${mod.supportedVersions.slice(-3).map((v) => `<span class="chip ${v === vNow ? 'chip-accent' : ''}">${h(v)}</span>`).join('')}</div>
      </div>
      <div class="card-foot">
        ${modSwitch(mod)}
        <span class="grow">${mod.active ? h(t('lib.loadPosition', { n: mod.loadIndex + 1 })) : t('common.inactive')}</span>
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
    const label = { ok: t('mod.depActive'), inactive: t('mod.depInactive'), miss: t('mod.depMissing') }[st];
    const ic = { ok: 'circle-check-big', inactive: 'circle-alert', miss: 'circle-alert' }[st];
    let btn = '';
    if (st === 'inactive') btn = `<button class="btn btn-sm" data-action="activatePkg" data-pkg="${h(d.packageId)}">${icon('plus')}${t('common.activate')}</button>`;
    if (st === 'miss' && d.workshopId) btn = installButton({ id: d.workshopId }, { small: true });
    if (st === 'miss' && !d.workshopId) btn = `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(d.displayName)}">${icon('search')}${t('common.search')}</button>`;
    return `<div class="dep ${st}">${icon(ic)}<div class="grow"><b>${h(d.displayName)}</b><br><small class="card-sub">${label}</small></div>${btn}</div>`;
  }).join('');

  openDrawer(`
    <div class="detail-hero">
      ${mod.previewUrl ? `<img class="bg" src="${h(mod.previewUrl)}" alt=""><img class="fg" src="${h(mod.previewUrl)}" alt="">` : `<div class="placeholder" style="position:absolute;inset:0;display:grid;place-items:center;color:var(--text-3)">${icon('package')}</div>`}
      <button class="btn btn-icon detail-close" data-action="closeDrawer">${icon('x')}</button>
    </div>
    <div class="detail-body">
      <h2 class="detail-title">${h(mod.name)}</h2>
      <div class="detail-author">${mod.author ? h(by(mod.author)) : ''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${sourceChip(mod)}
        ${mod.active ? `<span class="chip chip-ok">${icon('check')}${h(t('mod.activePosition', { n: mod.loadIndex + 1 }))}</span>` : `<span class="chip">${icon('ban')}${t('common.inactive')}</span>`}
        ${mod.supportedVersions.map((v) => `<span class="chip ${v === vNow ? 'chip-accent' : ''}">${h(v)}</span>`).join('')}
      </div>
      <div class="detail-actions">
        ${mod.packageId === 'ludeon.rimworld' ? '' : mod.active
          ? `<button class="btn" data-action="toggleMod" data-pkg="${h(mod.packageId)}">${icon('ban')}${t('common.deactivate')}</button>`
          : `<button class="btn btn-primary" data-action="toggleMod" data-pkg="${h(mod.packageId)}">${icon('circle-check-big')}${t('common.activate')}</button>`}
        <button class="btn" data-action="openPath" data-path="${h(mod.path)}">${icon('folder-open')}${t('mod.folder')}</button>
        ${mod.workshopId ? `<button class="btn" data-action="openWorkshop" data-id="${mod.workshopId}">${icon('store')}${t('mod.workshopDetails')}</button>` : ''}
        ${mod.workshopId && !mod.official ? `<button class="btn" data-action="update" data-id="${mod.workshopId}" title="${h(t('mod.redownloadTitle'))}">${icon('refresh-cw')}${t('mod.redownload')}</button>` : ''}
        ${mod.official ? '' : `<button class="btn btn-danger" data-action="uninstall" data-key="${h(mod.key)}">${icon('trash-2')}${t('mod.remove')}</button>`}
      </div>
      ${!mod.versionOk ? `<div class="callout warn">${icon('triangle-alert')}<div class="grow"><b>${h(t('mod.versionWarnTitle', { version: vNow }))}</b><p>${h(t('mod.versionWarnText', { versions: mod.supportedVersions.join(', ') }))}</p></div></div>` : ''}
      ${issues.length ? `<div class="detail-section"><h4>${icon('triangle-alert')}${t('mod.hints')}</h4><div class="dep-list">${issues.map(issueRow).join('')}</div></div>` : ''}
      ${mod.dependencies.length ? `<div class="detail-section"><h4>${icon('link')}${t('mod.dependencies')}</h4><div class="dep-list">${deps}</div></div>` : ''}
      <div class="detail-section"><h4>${icon('info')}${t('mod.details')}</h4>
        <dl class="kv">
          <dt>${t('mod.packageId')}</dt><dd><code>${h(mod.packageId)}</code></dd>
          ${mod.modVersion ? `<dt>${t('mod.modVersion')}</dt><dd>${h(mod.modVersion)}</dd>` : ''}
          ${mod.workshopId ? `<dt>${t('mod.workshopId')}</dt><dd><code>${h(mod.workshopId)}</code></dd>` : ''}
          <dt>${t('mod.folder')}</dt><dd><code>${h(mod.path)}</code></dd>
          ${mod.url ? `<dt>${t('mod.website')}</dt><dd><a href="${h(mod.url)}" target="_blank">${h(mod.url)}</a></dd>` : ''}
          ${mod.loadAfter.length ? `<dt>${t('mod.loadsAfter')}</dt><dd>${h(mod.loadAfter.join(', '))}</dd>` : ''}
          ${mod.loadBefore.length ? `<dt>${t('mod.loadsBefore')}</dt><dd>${h(mod.loadBefore.join(', '))}</dd>` : ''}
          ${mod.incompatibleWith.length ? `<dt>${t('mod.incompatible')}</dt><dd>${h(mod.incompatibleWith.join(', '))}</dd>` : ''}
        </dl>
      </div>
      ${mod.description ? `<div class="detail-section"><h4>${icon('list')}${t('common.description')}</h4><div class="bb bb-plain">${h(mod.description)}</div></div>` : ''}
    </div>`);
}

function issueRow(issue) {
  const err = issue.level === 'error';
  let btn = '';
  if (issue.fix?.type === 'activate') btn = `<button class="btn btn-sm" data-action="activatePkg" data-pkg="${h(issue.fix.packageId)}">${icon('plus')}${t('common.activate')}</button>`;
  if (issue.fix?.type === 'install' && issue.fix.workshopId) btn = installButton({ id: issue.fix.workshopId }, { small: true });
  if (issue.fix?.type === 'install' && !issue.fix.workshopId) btn = `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(issue.fix.name)}">${icon('search')}${t('common.search')}</button>`;
  if (issue.fix?.type === 'sort') btn = `<button class="btn btn-sm" data-action="autoSortNow">${icon('wand-sparkles')}${t('common.sort')}</button>`;
  return `<div class="dep ${err ? 'miss' : 'inactive'}">${icon(err ? 'circle-alert' : 'triangle-alert')}<div class="grow">${h(issueText(issue))}</div>${btn}</div>`;
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
    await saveActive(active, settings().autoSortOnInstall, add.length > 1 ? t('toast.activatedMany', { n: add.length }) : t('toast.activated', { name: mod.name }));
    const installable = missing.filter((d) => d.workshopId);
    if (missing.length) {
      const ok = await confirmDialog({
        title: t('dlg.missingDepsTitle'),
        text: t('dlg.missingDepsText', { name: mod.name }),
        list: missing.map((d) => d.displayName),
        ok: installable.length ? t('dlg.installNow') : t('common.ok'),
        iconName: 'link'
      });
      if (ok && installable.length) installWorkshop(installable.map((d) => d.workshopId));
    }
  } else {
    const dependents = state.lib.mods.filter((m) => m.active && m.dependencies.some((d) => d.packageId === pkg));
    if (dependents.length) {
      const ok = await confirmDialog({
        title: t('dlg.deactivateTitle', { name: mod.name }),
        text: t('dlg.deactivateText'),
        list: dependents.map((m) => m.name),
        ok: t('dlg.deactivateAnyway'),
        danger: true
      });
      if (!ok) return;
    }
    await saveActive(active.filter((id) => id !== pkg), false, t('toast.deactivated', { name: mod.name }));
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
        <span class="lo-name" data-action="${mod ? 'openMod' : ''}" data-key="${h(mod?.key || '')}">${h(mod?.name || pkg)}${mod?.official ? `<small>${t('common.official')}</small>` : ''}${!mod ? `<small>${t('lo.notInstalled')}</small>` : ''}</span>
        ${iss.length ? `<span class="lo-issue ${err ? 'err' : ''}" title="${h(iss.map(issueText).join('\n'))}">${icon(err ? 'circle-alert' : 'triangle-alert')}</span>` : ''}
        <span class="lo-actions">
          <button class="btn btn-ghost btn-sm btn-icon" data-action="loMove" data-pkg="${h(pkg)}" data-dir="-1" title="${h(t('lo.moveUp'))}">${icon('arrow-up')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-action="loMove" data-pkg="${h(pkg)}" data-dir="1" title="${h(t('lo.moveDown'))}">${icon('arrow-down')}</button>
          ${pkg === 'ludeon.rimworld' ? '' : `<button class="btn btn-ghost btn-sm btn-icon" data-action="loRemove" data-pkg="${h(pkg)}" title="${h(t('common.deactivate'))}">${icon('minus')}</button>`}
        </span>
      </div>`;
  }).join('');

  const inactiveRows = inactive.map((mod) => `
    <div class="lo-item" draggable="true" data-pkg="${h(mod.packageId)}" data-list="inactive">
      ${modThumb(mod, 'lo-thumb')}
      <span class="lo-name" data-action="openMod" data-key="${h(mod.key)}">${h(mod.name)}</span>
      ${!mod.versionOk ? `<span class="lo-issue" title="${h(t('common.notMarkedFor', { version: versionNow() }))}">${icon('triangle-alert')}</span>` : ''}
      <button class="btn btn-ghost btn-sm btn-icon" data-action="loAdd" data-pkg="${h(mod.packageId)}" title="${h(t('common.activate'))}">${icon('plus')}</button>
    </div>`).join('');

  return `
    <div class="view-head">
      <div><h1>${icon('list-ordered')}${t('lo.title')}</h1><p>${h(t('lo.subtitle'))}</p></div>
      <div class="view-actions">
        <button class="btn" data-action="loAutoSort">${icon('wand-sparkles')}${t('lo.autoSort')}</button>
        <button class="btn btn-primary" data-action="loSave" ${state.lo.dirty ? '' : 'disabled'}>${icon('save')}${t('common.save')}</button>
      </div>
    </div>
    <div class="lo-wrap">
      <section class="panel">
        <div class="panel-head"><h3>${icon('ban')}${t('common.inactive')}</h3><span class="count">${inactive.length}</span>
          <div class="search-box">${icon('search')}<input class="input" id="loSearch" placeholder="${h(t('lo.filter'))}" value="${h(state.lo.query)}"></div></div>
        <div class="panel-body" data-dropzone="inactive">${inactiveRows || `<div class="empty-mini">${t('lo.allActive')}</div>`}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>${icon('circle-check-big')}${t('common.active')}</h3><span class="count">${h(t('lo.activeCount', { n: state.lo.active.length }))}</span></div>
        <div class="panel-body" data-dropzone="active">${activeRows}</div>
      </section>
    </div>
    <section class="panel issues">
      <div class="panel-head"><h3>${icon(allIssues.length ? 'triangle-alert' : 'shield-alert')}${allIssues.length ? h(t('lo.issues', { n: allIssues.length })) : t('lo.noIssues')}</h3></div>
      ${allIssues.map((i) => {
        const mod = modByPkg(i.pkg);
        return `<div class="issue ${i.level === 'error' ? 'err' : ''}">${icon(i.level === 'error' ? 'circle-alert' : 'triangle-alert')}
          <div class="issue-text"><b>${h(mod?.name || i.pkg)}</b>: ${h(issueText(i))}</div>${issueFixButton(i)}</div>`;
      }).join('')}
    </section>
    ${state.lo.dirty ? `
      <div class="dirty-bar"><span class="grow">${icon('triangle-alert')}${t('lo.unsaved')}</span>
        <button class="btn" data-action="loDiscard">${icon('undo-2')}${t('common.discard')}</button>
        <button class="btn btn-primary" data-action="loSave">${icon('save')}${t('common.save')}</button></div>` : ''}`;
}

function issueFixButton(i) {
  if (i.fix?.type === 'activate') return `<button class="btn btn-sm" data-action="loAdd" data-pkg="${h(i.fix.packageId)}" data-before="${h(i.pkg)}">${icon('plus')}${t('common.activate')}</button>`;
  if (i.fix?.type === 'install' && i.fix.workshopId) return installButton({ id: i.fix.workshopId }, { small: true });
  if (i.fix?.type === 'install') return `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(i.fix.name)}">${icon('search')}${t('common.search')}</button>`;
  if (i.fix?.type === 'sort') return `<button class="btn btn-sm" data-action="loAutoSort">${icon('wand-sparkles')}${t('common.sort')}</button>`;
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
  const sorts = [['trend', 'trending-up'], ['popular', 'crown'], ['recent', 'sparkles'], ['updated', 'refresh-cw']];
  if (ws.query) sorts.unshift(['relevance', 'search']);
  const types = [['', 'all'], ['Mod', 'mods'], ['Translation', 'translations'], ['Scenario', 'scenarios']];
  const v = versionNow();
  let body;
  if (ws.error) {
    body = `<div class="empty">${icon('circle-alert')}<h3>${t('ws.errorTitle')}</h3><p>${h(ws.error)}</p>
      <button class="btn" data-action="wsSearch">${icon('rotate-ccw')}${t('ws.tryAgain')}</button></div>`;
  } else if (ws.loading && !ws.items.length) {
    body = `<div class="grid">${skeletonCards(12)}</div>`;
  } else if (!ws.items.length) {
    body = `<div class="empty">${icon('search')}<h3>${t('ws.nothingFound')}</h3><p>${t('ws.nothingFoundText')}</p></div>`;
  } else {
    body = `<div class="grid">${ws.items.map(workshopCard).join('')}${ws.loading ? skeletonCards(4) : ''}</div>
      ${ws.page < ws.totalPages && !ws.loading ? `<div class="load-more"><button class="btn" data-action="wsMore">${icon('plus')}${t('ws.loadMore')}</button></div>` : ''}`;
  }
  const subtitle = (ws.total ? t('ws.results', { n: fmtInt(ws.total) }) : t('ws.subtitle'))
    + (settings().versionFilter && v ? t('ws.forVersion', { version: v }) : '');
  return `
    <div class="view-head">
      <div><h1>${icon('compass')}Steam Workshop</h1><p>${h(subtitle)}</p></div>
    </div>
    <div class="toolbar">
      <div class="search-box large" style="flex:1">${icon('search')}<input class="input" id="wsQuery" placeholder="${h(t('ws.placeholder'))}" value="${h(ws.query)}"></div>
      <button class="btn btn-primary" style="height:44px" data-action="wsSearch">${icon('search')}${t('common.search')}</button>
    </div>
    <div class="toolbar">
      <div class="segmented">${sorts.map(([k, i]) => `<button class="${ws.sort === k ? 'active' : ''}" data-action="wsSort" data-sort="${k}">${icon(i)}${t('ws.sort.' + k)}</button>`).join('')}</div>
      ${ws.sort === 'trend' ? `<select class="select" id="wsDays">${[1, 7, 30, 90, 365].map((d) => `<option value="${d}" ${ws.days === d ? 'selected' : ''}>${t('ws.days.' + d)}</option>`).join('')}</select>` : ''}
      <span class="grow"></span>
      ${types.map(([tag, key]) => `<button class="chip-btn ${ws.tag === tag ? 'active' : ''}" data-action="wsTag" data-tag="${tag}">${t('ws.type.' + key)}</button>`).join('')}
      ${v ? `<button class="chip-btn ${settings().versionFilter ? 'active' : ''}" data-action="wsVersion" title="${h(t('ws.onlyVersionTitle'))}">${icon('filter')} ${h(t('ws.onlyVersion', { version: v }))}</button>` : ''}
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
  modal.innerHTML = workshopDetailHtml(base || { id, title: t('wd.loading'), versions: [], tags: [] }, true);
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
    const label = inst ? (inst.active ? t('wd.installedActive') : t('wd.installedInactive')) : t('wd.autoInstalled');
    return `<div class="dep ${st}">${icon(st === 'ok' ? 'circle-check-big' : 'circle-alert')}
      <div class="grow"><b>${h(d.name)}</b><br><small class="card-sub">${label}</small></div>
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
      <div class="detail-author">${item.author ? h(by(item.author)) : '&nbsp;'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${installedMod ? `<span class="chip chip-ok">${icon('check')}${installedMod.active ? t('wd.installedChipActive') : t('wd.installedChip')}</span>` : ''}
        ${(item.versions || []).map((x) => `<span class="chip ${x === v ? 'chip-accent' : ''}">${h(x)}</span>`).join('')}
        ${(item.tags || []).map((tag) => `<span class="chip">${icon('tag')}${h(tag)}</span>`).join('')}
      </div>
      <div class="detail-actions">
        ${installButton(item)}
        ${missingDeps && !installedMod ? `<span class="chip chip-accent" style="height:34px">${icon('link')}${h(t('wd.plusDeps', { n: missingDeps }))}</span>` : ''}
        ${installedMod ? `<button class="btn" data-action="showInstalled" data-id="${item.id}">${icon('library')}${t('wd.inLibrary')}</button>` : ''}
        <button class="btn" data-action="openUrl" data-url="https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}">${icon('external-link')}${t('wd.steamPage')}</button>
      </div>
      ${!fits ? `<div class="callout warn">${icon('triangle-alert')}<div class="grow"><b>${h(t('mod.versionWarnTitle', { version: v }))}</b><p>${h(t('wd.versionWarnText', { versions: item.versions.join(', ') }))}</p></div></div>` : ''}
      ${item.requiredDlc?.length ? `<div class="callout warn">${icon('shield-alert')}<div class="grow"><b>${h(t('wd.dlcTitle', { dlc: item.requiredDlc.join(', ') }))}</b><p>${t('wd.dlcText')}</p></div></div>` : ''}
      <div class="detail-stats">
        <div class="detail-stat"><small>${icon('users')}${t('common.subscribers')}</small><b>${fmtNum(item.subscriptions)}</b></div>
        <div class="detail-stat"><small>${icon('heart')}${t('wd.favorites')}</small><b>${fmtNum(item.favorited)}</b></div>
        <div class="detail-stat"><small>${icon('star')}${t('wd.rating')}</small><b>${starsHtml(item.stars ?? -1) || '–'}</b></div>
        <div class="detail-stat"><small>${icon('hard-drive')}${t('wd.size')}</small><b>${fmtSize(item.size)}</b></div>
        <div class="detail-stat"><small>${icon('calendar')}${t('wd.created')}</small><b>${fmtDate(item.timeCreated)}</b></div>
        <div class="detail-stat"><small>${icon('clock')}${t('wd.updated')}</small><b>${fmtDate(item.timeUpdated)}</b></div>
      </div>
      ${loading ? `<div class="empty-mini">${icon('loader-circle', 'spin')} ${t('wd.loadingDetails')}</div>` : ''}
      ${deps ? `<div class="detail-section"><h4>${icon('link')}${t('wd.requiredMods')}</h4><div class="dep-list">${deps}</div></div>` : ''}
      ${item.screenshots?.length ? `<div class="detail-section"><h4>${icon('image-off', '')}${t('wd.screenshots')}</h4><div class="shots">${item.screenshots.map((s) => `<img src="${h(s)}?imw=400" data-action="zoom" data-src="${h(s)}" loading="lazy" alt="">`).join('')}</div></div>` : ''}
      ${item.description ? `<div class="detail-section"><h4>${icon('list')}${t('common.description')}</h4><div class="bb">${bbcode(item.description)}</div></div>` : ''}
    </div>`;
}

// ====================================================================
// Ansicht: Vorschläge
// ====================================================================
function viewSuggestions() {
  const s = state.suggestions;
  if (!s) {
    return `
      <div class="view-head"><div><h1>${icon('sparkles')}${t('sg.title')}</h1><p>${t('sg.subtitle')}</p></div></div>
      <div class="section"><div class="section-head"><h2>${icon('crown')}${t('sg.essentials')}</h2></div><div class="grid">${skeletonCards(8)}</div></div>`;
  }
  const missing = s.missing.filter((m) => !state.installedWs.has(m.workshopId));
  const fresh = (list) => list.filter((i) => !state.installedWs.has(i.id));
  const section = (key, ic, list) => list.length ? `
    <section class="section">
      <div class="section-head"><h2>${icon(ic)}${t('sg.' + key)}</h2><p>${t('sg.' + key + 'Sub')}</p></div>
      <div class="grid">${list.map(workshopCard).join('')}</div>
    </section>` : '';
  return `
    <div class="view-head">
      <div><h1>${icon('sparkles')}${t('sg.title')}</h1><p>${h(t('sg.subtitleVersion', { version: versionNow() }))}</p></div>
      <div class="view-actions"><button class="btn" data-action="reloadSuggestions" ${state.suggestionsLoading ? 'disabled' : ''}>${icon('rotate-ccw', state.suggestionsLoading ? 'spin' : '')}${t('common.refresh')}</button></div>
    </div>
    ${missing.length ? `
      <section class="section">
        <div class="callout err">${icon('link')}<div class="grow"><b>${h(t('sg.missing', { n: missing.length }))}</b>
          <p>${t('sg.missingText')}</p></div>
          ${missing.some((m) => m.workshopId) ? `<button class="btn btn-primary" data-action="installMissing">${icon('download')}${t('sg.installAll')}</button>` : ''}
        </div>
        <div class="list">${missing.map((m) => `
          <div class="row" ${m.workshopId ? `data-action="openWorkshop" data-id="${m.workshopId}"` : ''}>
            <div class="row-thumb">${m.item?.preview ? `<img src="${h(m.item.preview)}" alt="">` : icon('package')}</div>
            <div class="row-main"><div class="row-title">${h(m.item?.title || m.displayName)}</div>
            <div class="row-sub">${h(t('sg.requiredBy', { names: m.requiredBy.join(', ') }))}</div></div>
            ${m.workshopId ? installButton({ id: m.workshopId }, { small: true }) : `<button class="btn btn-sm" data-action="searchWorkshop" data-q="${h(m.displayName)}">${icon('search')}${t('common.search')}</button>`}
          </div>`).join('')}</div>
      </section>` : ''}
    ${section('essentials', 'crown', fresh(s.essentials))}
    ${section('trending', 'flame', fresh(s.trending))}
    ${section('popular', 'trending-up', fresh(s.popular))}`;
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
    body = `<div class="empty">${icon('loader-circle', 'spin')}<p>${t('up.searching')}</p></div>`;
  } else if (!list.length) {
    body = `<div class="empty">${icon('circle-check-big')}<h3>${t('up.allCurrent')}</h3><p>${t('up.allCurrentText')}</p></div>`;
  } else {
    body = `<div class="list">${list.map((u) => `
      <div class="row" data-action="openWorkshop" data-id="${u.id}">
        <div class="row-thumb">${u.preview ? `<img src="${h(u.preview)}" alt="">` : icon('package')}</div>
        <div class="row-main"><div class="row-title">${h(u.localName || u.title)}</div>
          <div class="row-sub">${h(t('up.row', { local: fmtDate(u.localTime), remote: fmtDate(u.timeUpdated), size: fmtSize(u.size) }))}</div></div>
        ${installButton(u, { small: true })}
      </div>`).join('')}</div>`;
  }
  return `
    <div class="view-head">
      <div><h1>${icon('refresh-cw')}${t('nav.updates')}</h1><p>${t('up.subtitle')}</p></div>
      <div class="view-actions">
        <button class="btn" data-action="checkUpdates" ${state.updatesLoading ? 'disabled' : ''}>${icon('rotate-ccw', state.updatesLoading ? 'spin' : '')}${t('up.checkAgain')}</button>
        ${list.length ? `<button class="btn btn-primary" data-action="updateAll">${icon('download')}${h(t('up.updateAll', { n: list.length }))}</button>` : ''}
      </div>
    </div>
    ${body}
    <p class="card-sub" style="margin-top:16px">${t('up.note')}</p>`;
}

// ====================================================================
// Ansicht: Collections
// ====================================================================
function viewCollections() {
  const c = state.collection;
  let body = '';
  if (state.collLoading) {
    body = `<div class="empty">${icon('loader-circle', 'spin')}<p>${t('co.loading')}</p></div>`;
  } else if (c) {
    const v = versionNow();
    const installed = c.items.filter((i) => state.installedWs.has(i.id)).length;
    const selectable = c.items.filter((i) => !state.installedWs.has(i.id));
    const selected = selectable.filter((i) => state.collSelected.has(i.id));
    body = `
      <section class="panel">
        <div class="coll-head">
          ${c.preview ? `<img src="${h(c.preview)}" alt="">` : ''}
          <div class="grow"><h3>${h(c.title)}</h3><span class="card-sub">${h(t('co.summary', { n: c.items.length, installed }))}</span></div>
          <button class="btn" data-action="collSelect" data-all="1">${icon('square-check')}${t('co.all')}</button>
          <button class="btn" data-action="collSelect" data-all="0">${icon('square')}${t('co.none')}</button>
          <button class="btn btn-primary" data-action="collInstall" ${selected.length ? '' : 'disabled'}>${icon('download')}${h(t('co.installN', { n: selected.length }))}</button>
        </div>
        ${c.items.map((i) => {
          const inst = state.installedWs.has(i.id);
          const fits = !v || !i.versions.length || i.versions.includes(v);
          return `
          <div class="row" data-action="openWorkshop" data-id="${i.id}">
            <input type="checkbox" data-action="collToggle" data-id="${i.id}" ${inst ? 'checked disabled' : state.collSelected.has(i.id) ? 'checked' : ''}>
            <div class="row-thumb">${i.preview ? `<img src="${h(i.preview)}" loading="lazy" alt="">` : icon('package')}</div>
            <div class="row-main"><div class="row-title">${h(i.title)}</div><div class="row-sub">${h(t('co.subs', { n: fmtNum(i.subscriptions), size: fmtSize(i.size) }))}</div></div>
            <div class="row-chips">
              ${inst ? `<span class="chip chip-ok">${icon('check')}${t('common.installed')}</span>` : ''}
              ${!fits ? `<span class="chip chip-warn" title="${h(i.versions.join(', '))}">${icon('triangle-alert')}${h(i.versions[0] || '?')}</span>` : `<span class="chip chip-accent">${h(v)}</span>`}
            </div>
          </div>`;
        }).join('')}
      </section>`;
  } else {
    body = `<div class="empty">${icon('layers')}<h3>${t('co.emptyTitle')}</h3>
      <p>${t('co.emptyText')}</p></div>`;
  }
  return `
    <div class="view-head"><div><h1>${icon('layers')}${t('nav.collections')}</h1><p>${t('co.subtitle')}</p></div></div>
    <div class="toolbar">
      <div class="search-box large" style="flex:1">${icon('link')}<input class="input" id="collInput" placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…" value="${h(state.collInput)}"></div>
      <button class="btn btn-primary" style="height:44px" data-action="collLoad">${icon('layers')}${t('co.load')}</button>
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
  const finished = q.some((x) => x.state === 'done' || x.state === 'error');
  const busy = q.some((x) => ['queued', 'downloading', 'installing'].includes(x.state));
  return `
    <div class="view-head">
      <div><h1>${icon('download')}${t('nav.downloads')}</h1><p>${t('dl.subtitle')}</p></div>
      <div class="view-actions">
        ${finished ? `<button class="btn" data-action="queueClear">${icon('check')}${t('dl.clearDone')}</button>` : ''}
        ${busy ? `<button class="btn btn-danger" data-action="queueCancel">${icon('x')}${t('dl.cancel')}</button>` : ''}
      </div>
    </div>
    ${state.status ? `<div class="callout">${icon('loader-circle', 'spin')}<div class="grow"><b>${h(state.status)}</b><p>${t('dl.firstSetup')}</p></div></div>` : ''}
    ${q.length ? `<section class="panel">${q.map((task) => {
      const pct = Math.round((task.progress || 0) * 100);
      const indet = task.state === 'downloading' && !task.progress || task.state === 'installing';
      const detail = task.state === 'downloading' && task.progress
        ? ` · ${t('dl.progress', { pct, size: fmtSize(task.size) })}`
        : task.size ? ` · ${fmtSize(task.size)}` : '';
      return `
        <div class="dl-item">
          <div class="dl-thumb">${task.preview ? `<img src="${h(task.preview)}" alt="">` : ''}</div>
          <div class="dl-main">
            <div class="dl-title">${h(task.title)}
              ${task.isDependency ? `<span class="chip">${icon('link')}${t('dl.dependency')}</span>` : ''}
              ${task.isUpdate ? `<span class="chip chip-accent">${icon('refresh-cw')}${t('common.update')}</span>` : ''}
            </div>
            ${['queued', 'downloading', 'installing'].includes(task.state) ? `<div class="progress ${indet ? 'indeterminate' : ''}"><div style="width:${task.state === 'queued' ? 0 : pct}%"></div></div>` : ''}
            <div class="dl-sub ${task.state === 'error' ? 'err' : ''}">${t('dl.state.' + task.state)}${h(detail)}${task.error ? ` – ${h(task.error)}` : ''}</div>
          </div>
          ${task.state === 'done' ? `<span class="chip chip-ok">${icon('check')}${t('common.installed')}</span>` : ''}
          ${task.state === 'error' ? `<button class="btn btn-sm" data-action="retry" data-id="${task.id}">${icon('rotate-ccw')}${t('common.retry')}</button>` : ''}
        </div>`;
    }).join('')}</section>`
    : `<div class="empty">${icon('download')}<h3>${t('dl.emptyTitle')}</h3><p>${t('dl.emptyText')}</p></div>`}`;
}

// ====================================================================
// Ansicht: Einstellungen
// ====================================================================
function viewSettings() {
  const s = settings();
  const themes = [
    ['rimworld', 'flame', ['#16130f', '#231e18', '#e3a33c', '#2b251e']],
    ['dark', 'moon', ['#111317', '#1b1f25', '#5b8cff', '#22272e']],
    ['light', 'sun', ['#f4f5f7', '#ffffff', '#3b6ef5', '#eceef2']]
  ];
  const toggle = (key, titleKey, sub) => `
    <div class="setting"><div class="label"><b>${t(titleKey)}</b><small>${h(sub)}</small></div>
      <button class="switch ${s[key] ? 'on' : ''}" data-action="setToggle" data-key="${key}"></button></div>`;
  const pathRow = (key, title, sub) => `
    <div class="setting"><div class="label"><b>${title}</b><small>${h(sub)}</small></div>
      <div class="path-field"><input class="input" value="${h(s[key])}" readonly>
        <button class="btn btn-icon" data-action="pickPath" data-key="${key}" title="${h(t('st.change'))}">${icon('folder')}</button>
        <button class="btn btn-icon" data-action="openPath" data-path="${h(s[key])}" title="${h(t('st.open'))}">${icon('external-link')}</button></div></div>`;
  return `
    <div class="view-head"><div><h1>${icon('settings')}${t('st.title')}</h1></div></div>
    <div class="settings">
      <div class="setting-card"><h3>${icon('languages')}${t('st.language')}</h3>
        <div class="setting"><div class="label"><b>${t('st.languageLabel')}</b><small>${t('st.languageSub')}</small></div>
          <div class="segmented">${I18N.LANGUAGES.map((l) => `<button class="${lang() === l.code ? 'active' : ''}" data-action="setLanguage" data-lang="${l.code}">${h(l.name)}</button>`).join('')}</div></div>
      </div>
      <div class="setting-card"><h3>${icon('sun')}${t('st.design')}</h3>
        <div class="themes">${themes.map(([k, i, c]) => `
          <button class="theme-opt ${s.theme === k ? 'active' : ''}" data-action="setTheme" data-theme="${k}">
            <div class="theme-prev" style="background:${c[0]}"><div class="sb" style="background:${c[1]}"></div>
              <div class="mn"><i style="background:${c[3]}"></i><i style="background:${c[2]}"></i><i style="background:${c[3]}"></i><i style="background:${c[3]}"></i></div></div>
            <div class="theme-name">${icon(i)}${t('st.theme.' + k)}${s.theme === k ? icon('check') : ''}</div>
          </button>`).join('')}</div>
      </div>
      <div class="setting-card"><h3>${icon('gamepad-2')}${t('st.game')}</h3>
        ${pathRow('gameDir', t('st.gameDir'), state.ctx.gameFound ? t('st.gameFound', { version: state.ctx.version.full }) : t('st.gameNotFound'))}
        ${pathRow('modsDir', t('st.modsDir'), t('st.modsDirSub'))}
        ${pathRow('configDir', t('st.configDir'), t('st.configDirSub'))}
        <div class="setting"><div class="label"><b>${t('st.launchVia')}</b><small>${t('st.launchViaSub')}</small></div>
          <div class="segmented">
            <button class="${s.launchVia === 'epic' ? 'active' : ''}" data-action="setLaunch" data-via="epic" ${s.epicAppName ? '' : 'disabled'}>${icon('store')}Epic Launcher</button>
            <button class="${s.launchVia !== 'epic' ? 'active' : ''}" data-action="setLaunch" data-via="exe">${icon('play')}${t('st.direct')}</button>
          </div></div>
      </div>
      <div class="setting-card"><h3>${icon('wand-sparkles')}${t('st.behavior')}</h3>
        ${toggle('autoDependencies', 'st.autoDeps', t('st.autoDepsSub'))}
        ${toggle('autoActivate', 'st.autoActivate', t('st.autoActivateSub'))}
        ${toggle('autoSortOnInstall', 'st.autoSort', t('st.autoSortSub'))}
        ${toggle('versionFilter', 'st.versionFilter', t('st.versionFilterSub', { version: versionNow() }))}
      </div>
      <div class="setting-card"><h3>${icon('download')}SteamCMD</h3>
        <div class="setting"><div class="label"><b>${t('st.status')}</b><small>${state.ctx.steamcmdReady ? t('st.ready') : t('st.notReady')}</small></div>
          ${state.ctx.steamcmdReady ? `<span class="chip chip-ok">${icon('check')}${t('st.readyChip')}</span>` : `<button class="btn" data-action="setupSteamcmd">${icon('download')}${t('st.setupNow')}</button>`}</div>
        <div class="setting"><div class="label"><b>${t('st.clearCache')}</b><small>${t('st.clearCacheSub')}</small></div>
          <button class="btn" data-action="clearCache">${icon('trash-2')}${t('st.clear')}</button></div>
      </div>
      <div class="setting-card"><h3>${icon('info')}${t('st.about')}</h3>
        <div class="setting"><div class="label"><b>RimWorld Mod Library ${h(state.ctx.appVersion)}</b>
          <small>${t('st.aboutText')}</small></div></div>
      </div>
    </div>`;
}

// ====================================================================
// Installation
// ====================================================================
async function installWorkshop(ids, opts = {}) {
  const res = await safe(() => window.api.install(ids, opts));
  if (!res) return;
  toast(t('toast.queued', { n: res.count, deps: res.dependencies.length }), 'info');
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
    toast(t('toast.rescanned'), 'success');
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
  autoSortNow: () => saveActive(state.lib.active, true, t('toast.sorted')),
  uninstall: async (d) => {
    const mod = modByKey(d.key);
    if (!mod) return;
    const ok = await confirmDialog({
      title: t('dlg.removeTitle', { name: mod.name }),
      text: t('dlg.removeText'),
      ok: t('dlg.remove'),
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
    toast(t('toast.removed', { name: mod.name }), 'success');
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
    toast(t('toast.sortedReview'), 'info');
  },
  loSave: async () => {
    if (await saveActive(state.lo.active, false)) toast(t('toast.loSaved'), 'success');
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
    const task = state.queue.find((x) => x.id === d.id);
    installWorkshop([d.id], { isUpdate: task?.isUpdate, withDeps: false });
  },

  // Einstellungen
  setLanguage: async (d) => {
    state.ctx.settings = await window.api.setSettings({ language: d.lang });
    applyStaticTexts();
    render();
  },
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
    const dir = await window.api.pickFolder(t('st.pick.' + d.key));
    if (!dir) return;
    const patch = { [d.key]: dir };
    if (d.key === 'gameDir') Object.assign(patch, { modsDir: '', epicAppName: '' });
    await window.api.setSettings(patch);
    await loadContext();
    state.lo.dirty = false;
    await loadLibrary();
    render();
    if (d.key === 'gameDir' && !state.ctx.gameFound) toast(t('toast.noExe'), 'warning');
  },
  setupSteamcmd: async () => {
    await safe(() => window.api.ensureSteamcmd());
    await loadContext();
    render();
  },
  clearCache: async () => {
    await safe(() => window.api.clearSteamcmdCache());
    toast(t('toast.cacheCleared'), 'success');
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
    const ok = await confirmDialog({ title: t('dlg.unsavedTitle'), text: t('dlg.unsavedText'), ok: t('dlg.saveAndLaunch'), iconName: 'save' });
    if (!ok) return;
    if (!(await saveActive(state.lo.active, false))) return;
  }
  const ok = await safe(() => window.api.launchGame());
  if (ok) toast(t('toast.launching'), 'success');
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
window.api.on('toast', (msg) => toast(msg.text, msg.type));
window.api.on('library:changed', async () => {
  await loadLibrary();
  if (state.updates) state.updates = state.updates.filter((u) => !state.queue.some((x) => x.id === u.id && x.state === 'done'));
  updateBadges();
  if (state.view !== 'downloads') rerenderKeepScroll();
  else patchInstallButtons();
  if (state.drawerMod && $('#drawer').classList.contains('open')) {
    const m = modByKey(state.drawerMod);
    if (m) {
      const top = $('#drawer').scrollTop;
      openModDrawer(m);
      $('#drawer').scrollTop = top;
    } else closeDrawer();
  }
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
