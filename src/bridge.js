// Verbindung zum Rust-Backend: stellt window.api bereit (Befehle in src-tauri/src/main.rs), übersetzt Texte des
// Backends und kümmert sich ums Fenster (eigene Fensterknöpfe, Ziehbereich, keine Browser-Kürzel).
// Wird vor app.js geladen.
(() => {
  if (window.api) return;

  const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const appWindow = () => window.__TAURI__.window.getCurrentWindow();
  let language = 'en';

  // Rust schickt übersetzbare Texte als { $t: key, p: params, fallback? } – übersetzt wird hier mit shared/i18n.js.
  const tx = (v) => {
    if (!v || typeof v !== 'object' || typeof v.$t !== 'string') return v;
    if (v.fallback !== undefined && !I18N.has(v.$t)) return v.fallback;
    const params = {};
    for (const [k, x] of Object.entries(v.p || {})) params[k] = tx(x);
    return I18N.translate(language, v.$t, params);
  };
  const remember = (settings) => {
    if (settings && settings.language) language = I18N.normalize(settings.language);
    return settings;
  };
  const tasks = (list) => list.map((t) => ({ ...t, error: tx(t.error) }));
  // Offizielle Inhalte zuerst, dann lokale Mods nach Name (localeCompare).
  const library = (state) => {
    const official = state.mods.filter((m) => m.official);
    const local = state.mods.filter((m) => !m.official).sort((a, b) => a.name.localeCompare(b.name));
    return { ...state, mods: [...official, ...local] };
  };

  const call = async (cmd, args, map = (x) => x) => {
    let res;
    try {
      res = await invoke(cmd, args);
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : tx(e) || String(e));
    }
    return map(res);
  };

  window.api = {
    context: () => call('app_context', {}, (c) => (remember(c.settings), c)),
    about: () => call('app_about'),
    checkRelease: () => call('app_check_release'),
    openDoc: (name) => call('app_open_doc', { name }),
    copyText: (text) => call('app_copy', { text }),
    setSettings: (partial) => call('settings_set', { partial }, remember),
    pickFolder: (title) => call('dialog_folder', { title }),

    library: () => call('library_state', {}, library),
    saveActive: (active, opts) => call('library_save', { active, opts }, library),
    sortPreview: (active) => call('library_sort_preview', { active }),
    analyze: (active) => call('library_analyze', { active }),
    uninstall: (modPath) => call('library_uninstall', { modPath }, library),
    checkUpdates: () => call('library_check_updates'),
    open: (target) => call('shell_open', { target }),

    browse: (params) => call('workshop_browse', { params }),
    details: (id) => call('workshop_details', { id }),
    detailsMany: (ids) => call('workshop_details_many', { ids }),
    collection: (input) => call('workshop_collection', { input }),
    suggestions: () => call('workshop_suggestions'),

    install: (ids, opts) => call('install_enqueue', { ids, opts }),
    queue: () => call('install_queue', {}, tasks),
    cancelQueue: () => call('install_cancel'),
    clearQueue: () => call('install_clear'),

    ensureSteamcmd: () => call('steamcmd_ensure'),
    clearSteamcmdCache: () => call('steamcmd_clear_cache'),
    launchGame: () => call('game_launch'),

    on: (channel, fn) => {
      const map = {
        'queue:update': tasks,
        status: tx,
        toast: (msg) => ({ ...msg, text: tx(msg.text) }),
        'library:changed': () => undefined
      };
      if (!map[channel]) return;
      window.__TAURI__.event.listen(channel, (e) => fn(map[channel](e.payload)));
    }
  };

  // ---------- Links im Standardbrowser öffnen ----------
  const external = (url) => /^(https?:|steam:)/i.test(url || '');
  window.open = (url) => {
    if (external(String(url))) invoke('shell_open', { target: String(url) });
    return null;
  };
  const onLink = (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || (e.type === 'auxclick' && e.button !== 1)) return;
    if (external(a.href)) {
      e.preventDefault();
      invoke('shell_open', { target: a.href });
    }
  };
  document.addEventListener('click', onLink, true);
  document.addEventListener('auxclick', onLink, true);

  // ---------- Kein Browser-Verhalten (Kontextmenü, Neuladen, Suchen, Drucken) ----------
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const blocked =
      ['f3', 'f5', 'f7', 'browserback', 'browserforward', 'browserrefresh'].includes(key) ||
      (ctrl && ['r', 'f', 'g', 'p', 'u', 's', 'o', 'j', 'h', 'd'].includes(key)) ||
      (e.altKey && ['arrowleft', 'arrowright'].includes(key));
    if (blocked) e.preventDefault();
  }, true);

  // ---------- Ziehbereich (-webkit-app-region: drag) ----------
  const region = (el) => {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      const style = getComputedStyle(el);
      const r = style.getPropertyValue('-webkit-app-region') || style.webkitAppRegion || style.getPropertyValue('app-region');
      if (r === 'drag' || r === 'no-drag') return r;
    }
    return 'none';
  };
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || region(e.target) !== 'drag') return;
    e.preventDefault();
    if (e.detail === 2) appWindow().toggleMaximize();
    else appWindow().startDragging();
  }, true);
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (region(e.target) === 'drag') invoke('win_system_menu');
  }, true);

  // ---------- Fensterknöpfe (wie die nativen Windows-Titelleistenknöpfe, Höhe 40 px) ----------
  // Pixelgenau an nativen Knöpfen ausgemessen: 45 px breite Knöpfe mit 1 px Abstand,
  // Hover 17 % / gedrückt 33 % der Symbolfarbe, Schließen #e81123 / 60 %, scharfe 1-px-Symbole.
  const TITLEBAR = {
    light: { color: '#f4f5f7', symbol: '#3b3f46' },
    dark: { color: '#14161a', symbol: '#c9ccd2' },
    rimworld: { color: '#16130f', symbol: '#d8c9ad' }
  };
  const svg = (w, body) =>
    `<svg width="${w}" height="10" viewBox="0 0 ${w} 10" fill="none" stroke="currentColor" stroke-width="1">${body}</svg>`;
  const GLYPH = {
    minimize: svg(10, '<path d="M0 4.5H10" shape-rendering="crispEdges"/>'),
    maximize: svg(10, '<rect x="0.5" y="0.5" width="9" height="9" rx="1"/>'),
    restore: svg(11, '<rect x="0.5" y="2.5" width="7" height="7" rx="1"/><path d="M2 0.5H8.5A2 2 0 0 1 10.5 2.5V7.5"/>'),
    close: svg(10, '<path d="M0 0L10 10M10 0L0 10" shape-rendering="crispEdges"/>')
  };
  const css = `
    .tauri-wco {
      position: fixed; top: 0; right: 0; height: 40px; display: flex; gap: 1px;
      background: var(--wco-color); z-index: 2147483647; user-select: none;
    }
    .tauri-wco button {
      position: relative; width: 45px; height: 40px; padding: 0; border: 0; border-radius: 0; outline: none;
      box-shadow: none; background: transparent; color: var(--wco-symbol); cursor: default;
    }
    .tauri-wco svg { position: absolute; left: 17px; top: 15px; display: block; }
    .tauri-wco button:hover { background: color-mix(in srgb, var(--wco-symbol) 17%, var(--wco-color)); }
    .tauri-wco button:active { background: color-mix(in srgb, var(--wco-symbol) 33%, var(--wco-color)); }
    .tauri-wco button.close:hover { background: #e81123; color: #fff; }
    .tauri-wco button.close:active { background: color-mix(in srgb, #e81123 60%, var(--wco-color)); color: #fff; }
  `;

  function mountControls() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'tauri-wco';
    const button = (cls, glyph, onClick) => {
      const b = document.createElement('button');
      b.className = cls;
      b.tabIndex = -1;
      b.innerHTML = glyph;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
      return b;
    };
    button('minimize', GLYPH.minimize, () => appWindow().minimize());
    const max = button('maximize', GLYPH.maximize, () => appWindow().toggleMaximize());
    button('close', GLYPH.close, () => appWindow().close());
    document.body.appendChild(bar);

    // Snap-Layouts von Windows 11 nach kurzem Verweilen auf "Maximieren".
    let timer;
    max.addEventListener('mouseenter', () => {
      timer = setTimeout(() => appWindow().setFocus().then(() => invoke('win_snap_overlay')), 620);
    });
    max.addEventListener('mouseleave', () => clearTimeout(timer));
    max.addEventListener('mousedown', () => clearTimeout(timer));

    const syncMax = () => appWindow().isMaximized().then((m) => (max.innerHTML = m ? GLYPH.restore : GLYPH.maximize));
    appWindow().onResized(syncMax);
    syncMax();

    const syncTheme = () => {
      const colors = TITLEBAR[document.documentElement.dataset.theme] || TITLEBAR.rimworld;
      bar.style.setProperty('--wco-color', colors.color);
      bar.style.setProperty('--wco-symbol', colors.symbol);
    };
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    syncTheme();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountControls);
  else mountControls();
})();
