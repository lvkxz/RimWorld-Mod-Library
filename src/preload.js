const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

contextBridge.exposeInMainWorld('api', {
  context: () => call('app:context'),
  setSettings: (partial) => call('settings:set', partial),
  pickFolder: (title) => call('dialog:folder', title),

  library: () => call('library:state'),
  saveActive: (active, opts) => call('library:save', active, opts),
  sortPreview: (active) => call('library:sortPreview', active),
  analyze: (active) => call('library:analyze', active),
  uninstall: (modPath) => call('library:uninstall', modPath),
  checkUpdates: () => call('library:checkUpdates'),
  open: (target) => call('shell:open', target),

  browse: (params) => call('workshop:browse', params),
  details: (id) => call('workshop:details', id),
  detailsMany: (ids) => call('workshop:detailsMany', ids),
  collection: (input) => call('workshop:collection', input),
  suggestions: () => call('workshop:suggestions'),

  install: (ids, opts) => call('install:enqueue', ids, opts),
  queue: () => call('install:queue'),
  cancelQueue: () => call('install:cancel'),
  clearQueue: () => call('install:clear'),

  ensureSteamcmd: () => call('steamcmd:ensure'),
  clearSteamcmdCache: () => call('steamcmd:clearCache'),
  launchGame: () => call('game:launch'),

  on: (channel, fn) => {
    const allowed = ['queue:update', 'status', 'toast', 'library:changed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
