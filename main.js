const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { GogClient } = require('./src/gog-client');
const { BackupManager, totalDownloadSize } = require('./src/backup-manager');

let mainWindow;
let client;
let manager;
let settings;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const tokenPath = path.join(app.getPath('userData'), '.gog-token.json');

// ── Settings ──

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = { gamesDir: path.join(app.getPath('documents'), 'GOG Games') };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ── Window ──

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1a1a2e',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function initManager() {
  manager = new BackupManager(settings.gamesDir, client);
  manager.on('event', (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backup-event', evt);
    }
  });
}

// ── App lifecycle ──

app.whenReady().then(() => {
  loadSettings();
  fs.mkdirSync(settings.gamesDir, { recursive: true });

  client = new GogClient(tokenPath);
  client.loadToken().catch(() => console.log('No saved token, login required'));

  initManager();
  registerIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC handlers ──

function registerIPC() {
  ipcMain.handle('get-auth-state', () => client.isAuthenticated());

  ipcMain.handle('get-auth-url', () => GogClient.authURL());

  // Opens GOG login in a child BrowserWindow and intercepts the OAuth redirect.
  ipcMain.handle('open-auth-window', () => {
    return new Promise((resolve) => {
      let resolved = false;

      const authWin = new BrowserWindow({
        width: 800,
        height: 700,
        parent: mainWindow,
        modal: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        if (!authWin.isDestroyed()) authWin.close();
        resolve(result);
      };

      const checkURL = (url) => {
        try {
          const u = new URL(url);
          if (u.hostname === 'embed.gog.com' && u.pathname === '/on_login_success') {
            const code = u.searchParams.get('code');
            if (code) {
              client
                .exchangeCode(code)
                .then(() => finish({ success: true }))
                .catch((err) => finish({ error: err.message }));
              return true;
            }
          }
        } catch {
          /* ignore invalid URLs */
        }
        return false;
      };

      authWin.webContents.on('will-redirect', (event, url) => {
        if (checkURL(url)) event.preventDefault();
      });

      authWin.webContents.on('will-navigate', (_event, url) => {
        checkURL(url);
      });

      authWin.webContents.on('did-navigate', (_event, url) => {
        checkURL(url);
      });

      authWin.on('closed', () => {
        finish({ error: 'Login window was closed' });
      });

      authWin.loadURL(GogClient.authURL());
    });
  });

  ipcMain.handle('submit-auth', async (_event, raw) => {
    raw = String(raw || '').trim();
    if (!raw) throw new Error('Please paste a GOG URL, authorization code, or Authorization header.');

    const bearer = extractBearerToken(raw);
    if (bearer) {
      await client.setToken({ access_token: bearer, token_type: 'Bearer' });
      return { success: true };
    }

    let code;
    if (raw.includes('user_id_token=')) {
      code = await client.resolveUserIDToken(raw);
    } else {
      code = extractCode(raw);
      if (!code) {
        throw new Error(
          'No bearer token or authorization code found in the pasted text. ' +
            'Make sure you copied the full URL, code, or Authorization header.',
        );
      }
    }

    await client.exchangeCode(code);
    return { success: true };
  });

  ipcMain.handle('get-library', async () => {
    const products = await client.getLibrary();
    const games = products.filter((p) => p.isGame);
    return games.map((p) => {
      const status = manager.gameBackupStatus(p.title);
      return {
        ...p,
        backedUp: status ? (status.partial ? 'partial' : 'full') : false,
        thumbnailURL: buildThumbnailURL(p.image),
      };
    });
  });

  ipcMain.handle('get-game-details', async (_event, id) => {
    const details = await client.getProductDetails(id);
    const backupStatus = manager.gameBackupStatus(details.title || '');
    const backedUpFileIds = await resolveBackedUpFileIds(details, backupStatus);
    return {
      installers: (details.downloads?.installers || []).map((inst) => ({
        os: inst.os || '',
        language: inst.language_full || inst.language || '',
        version: inst.version || '',
        totalSize: inst.total_size || 0,
        fileIds: (inst.files || []).map((f) => f.id),
        fileSizes: (inst.files || []).map((f) => f.size || 0),
      })),
      bonusContent: (details.downloads?.bonus_content || []).map((bonus) => ({
        name: bonus.name || bonus.type || 'Bonus content',
        type: bonus.type || '',
        totalSize: bonus.total_size || 0,
        fileIds: (bonus.files || []).map((f) => f.id),
        fileSizes: (bonus.files || []).map((f) => f.size || 0),
      })),
      backedUpFileIds,
      lastBackup: backupStatus?.last_backup || null,
    };
  });

  ipcMain.handle('stream-library-sizes', async (_event, gameIds) => {
    if (!Array.isArray(gameIds)) return;
    let completed = 0;
    const total = gameIds.length;
    const BATCH = 6;

    for (let i = 0; i < total; i += BATCH) {
      const batch = gameIds.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (id) => {
          let sizeLabel = 'Size unavailable';
          let rawSize = 0;
          try {
            const details = await client.getProductDetails(id);
            rawSize = totalDownloadSize(details);
            sizeLabel = formatBytes(rawSize);
          } catch {
            /* keep default label */
          }
          completed++;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('size-event', {
              gameId: id,
              sizeLabel,
              rawSize,
              completed,
              total,
            });
          }
        }),
      );
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('size-event', { done: true, completed: total, total });
    }
  });

  ipcMain.handle('start-backup', (_event, { ids, fileSelections, platform } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('no games selected');
    if (!client.isAuthenticated()) throw new Error('not authenticated');
    const validIds = ids.filter((id) => typeof id === 'number' && Number.isFinite(id));
    if (validIds.length === 0) throw new Error('no valid game IDs');
    manager.startBackup(validIds, fileSelections || {}, platform || 'all');
    return { started: true, count: validIds.length };
  });

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Games Backup Directory',
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('logout', async () => {
    client.token = null;
    const fs = require('node:fs');
    try { fs.unlinkSync(tokenPath); } catch { /* ignore */ }
    return true;
  });

  ipcMain.handle('get-settings', () => ({ gamesDir: settings.gamesDir }));

  ipcMain.handle('set-games-dir', (_event, dir) => {
    if (typeof dir !== 'string' || !dir) throw new Error('invalid directory');
    settings.gamesDir = dir;
    saveSettings();
    fs.mkdirSync(dir, { recursive: true });
    initManager();
    return true;
  });
}

// ── Helpers ──

function extractBearerToken(raw) {
  raw = raw.trim();
  if (!raw) return '';
  if (raw.toLowerCase().startsWith('authorization:')) {
    raw = raw.slice('authorization:'.length).trim();
  }
  if (raw.toLowerCase().startsWith('bearer ')) {
    const token = raw.slice('bearer '.length).trim();
    if (token) return token;
  }
  return '';
}

async function resolveBackedUpFileIds(details, backupStatus) {
  if (!backupStatus) return [];

  const storedIds = Array.isArray(backupStatus.file_ids) ? backupStatus.file_ids : [];
  if (storedIds.length > 0) {
    return [...new Set(storedIds.map(String))];
  }

  const storedFiles = Array.isArray(backupStatus.files) ? backupStatus.files : [];
  if (storedFiles.length === 0) return [];

  const backedUpFiles = new Set(storedFiles.map(String));
  const entries = collectDownloadEntries(details);
  const matchedIds = await Promise.all(
    entries.map(async (entry) => {
      const link = await client.resolveDownlink(entry.downlink);
      return backedUpFiles.has(link.filename) ? String(entry.id) : null;
    }),
  );

  return [...new Set(matchedIds.filter(Boolean))];
}

function collectDownloadEntries(product) {
  const entries = [];
  for (const inst of product.downloads?.installers || []) {
    for (const file of inst.files || []) entries.push(file);
  }
  for (const bonus of product.downloads?.bonus_content || []) {
    for (const file of bonus.files || []) entries.push(file);
  }
  return entries;
}

function extractCode(raw) {
  raw = raw.trim();
  if (!raw || extractBearerToken(raw)) return '';
  if (raw.startsWith('http')) {
    try {
      const u = new URL(raw);
      const code = u.searchParams.get('code');
      if (code) return code;
    } catch {
      /* not a valid URL */
    }
  }
  return raw;
}

function buildThumbnailURL(raw) {
  if (!raw) return '';
  let src = raw.trim();
  if (src.startsWith('//')) src = 'https:' + src;

  try {
    const u = new URL(src);
    const host = u.hostname.toLowerCase();
    if (
      host !== 'static.gog.com' &&
      host !== 'gog-statics.com' &&
      host !== 'images.gog.com' &&
      !host.endsWith('.gog-statics.com')
    ) {
      return '';
    }

    const lp = u.pathname.toLowerCase();
    if (!/\.(jpg|jpeg|png|webp|gif|avif)$/.test(lp)) {
      const base = path.posix.basename(u.pathname);
      if (/_product_tile_|_product_card_|_bg_crop_|_av/.test(base)) {
        u.pathname += '.webp';
      } else {
        u.pathname += '_product_tile_116.webp';
      }
    }

    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let i = -1;
  let b = bytes;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < units.length - 1);
  return `${b.toFixed(1)} ${units[i]}`;
}
