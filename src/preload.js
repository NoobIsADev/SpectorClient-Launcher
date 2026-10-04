const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  setTheme: (theme) => ipcRenderer.invoke('appearance:set-theme', theme),
  getClientInfo: () => ipcRenderer.invoke('client:info'),
  prepareClient: (gameVersion) => ipcRenderer.invoke('client:prepare', gameVersion),

  addAccount: () => ipcRenderer.invoke('account:add'),
  selectAccount: (id) => ipcRenderer.invoke('account:select', id),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  getSkinData: (id) => ipcRenderer.invoke('account:skin-data', id),

  listMods: (gameVersion) => ipcRenderer.invoke('mods:list', gameVersion),
  searchMods: (gameVersion, query, page = 1) => ipcRenderer.invoke('mods:search', gameVersion, query, page),
  getModStatuses: (gameVersion, projectIds) => ipcRenderer.invoke('mods:statuses', gameVersion, projectIds),
  installMod: (gameVersion, projectId) => ipcRenderer.invoke('mods:install', gameVersion, projectId),
  removeMod: (gameVersion, filename) => ipcRenderer.invoke('mods:remove', gameVersion, filename),

  chooseJava: (major = 25) => ipcRenderer.invoke('dialog:choose-java', major),
  openClientFolder: () => ipcRenderer.invoke('folder:open-client'),
  openModsFolder: (gameVersion) => ipcRenderer.invoke('folder:open-mods', gameVersion),
  launchGame: (options) => ipcRenderer.invoke('game:launch', options),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  getGameStatus: () => ipcRenderer.invoke('game:get-status'),
  openLogsWindow: (theme) => ipcRenderer.invoke('logs:open', theme),
  getLogHistory: () => ipcRenderer.invoke('logs:get-history'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),

  onAuthCode: (callback) => ipcRenderer.on('auth-code', (_event, data) => callback(data)),
  onAuthState: (callback) => ipcRenderer.on('auth-state', (_event, data) => callback(data)),
  onInstallState: (callback) => ipcRenderer.on('install-state', (_event, data) => callback(data)),
  onModInstallState: (callback) => ipcRenderer.on('mod-install-state', (_event, data) => callback(data)),
  onGameState: (callback) => ipcRenderer.on('game-state', (_event, data) => callback(data)),
  onGameLog: (callback) => ipcRenderer.on('game-log', (_event, data) => callback(data)),
  onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', (_event, state) => callback(state)),
  onUiScale: (callback) => ipcRenderer.on('ui-scale', (_event, data) => callback(data)),
  onLogsCleared: (callback) => ipcRenderer.on('logs-cleared', () => callback()),
  onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (_event, theme) => callback(theme)),
  onUpdateState: (callback) => ipcRenderer.on('update-state', (_event, data) => callback(data))
});
