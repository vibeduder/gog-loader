const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gogAPI', {
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),
  getAuthURL: () => ipcRenderer.invoke('get-auth-url'),
  openAuthWindow: () => ipcRenderer.invoke('open-auth-window'),
  submitAuth: (input) => ipcRenderer.invoke('submit-auth', input),
  getLibrary: () => ipcRenderer.invoke('get-library'),
  streamLibrarySizes: (gameIds) => ipcRenderer.invoke('stream-library-sizes', gameIds),
  getGameDetails: (id) => ipcRenderer.invoke('get-game-details', id),
  startBackup: (ids, fileSelections, platform) =>
    ipcRenderer.invoke('start-backup', { ids, fileSelections, platform }),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  logout: () => ipcRenderer.invoke('logout'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setGamesDir: (dir) => ipcRenderer.invoke('set-games-dir', dir),

  onBackupEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('backup-event', listener);
    return () => ipcRenderer.removeListener('backup-event', listener);
  },

  onSizeEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('size-event', listener);
    return () => ipcRenderer.removeListener('size-event', listener);
  },
});
