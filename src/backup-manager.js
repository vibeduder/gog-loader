const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_DOWNLOAD_ATTEMPTS = 4;
const BASE_RETRY_DELAY = 2000;

class BackupManager extends EventEmitter {
  constructor(dir, client) {
    super();
    this.dir = dir;
    this.client = client;
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  cacheDir(name) {
    return path.join(this.dir, '.cache', name);
  }

  gameBackupStatus(title) {
    const statusFile = path.join(this.dir, sanitizeName(title), '.backup-status.json');
    try {
      return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    } catch {
      return null;
    }
  }

  startBackup(productIDs, fileSelections = {}, platform = 'all') {
    if (this.running) throw new Error('backup already running');
    this.running = true;
    this._run(productIDs, fileSelections, platform)
      .catch((err) => {
        this.emit('event', { type: 'error', message: err.message });
      })
      .finally(() => {
        this.running = false;
      });
  }

  async _run(productIDs, fileSelections, platform) {
    const total = productIDs.length;

    for (let i = 0; i < total; i++) {
      const id = productIDs[i];
      try {
        const details = await this.client.getProductDetails(id);
        await this._backupGame(details, i + 1, total, fileSelections[id] ?? null, platform);
      } catch (err) {
        console.error(`product ${id} details:`, err);
        this.emit('event', {
          type: 'error',
          gameIndex: i + 1,
          totalGames: total,
          message: `Failed to get details for product ${id}: ${err.message}`,
        });
      }
    }

    this.emit('event', {
      type: 'done',
      message: `Backup complete (${total} games)`,
    });
  }

  async _backupGame(product, gameIdx, totalGames, selectedFileIds, platform) {
    const gameDir = path.join(this.dir, sanitizeName(product.title));
    await fsp.mkdir(gameDir, { recursive: true });

    const existingStatus = this.gameBackupStatus(product.title);
    const knownSizes = {};
    if (existingStatus?.file_sizes) {
      Object.assign(knownSizes, existingStatus.file_sizes);
    }

    const files = [];
    for (const inst of product.downloads?.installers || []) {
      if (platform && platform !== 'all') {
        const instOS = (inst.os || '').toLowerCase();
        const wantWin = platform === 'win' && instOS === 'windows';
        const wantMac = platform === 'mac' && (instOS === 'osx' || instOS === 'mac');
        const wantLinux = platform === 'linux' && instOS === 'linux';
        if (!wantWin && !wantMac && !wantLinux) continue;
      }
      for (const f of inst.files || []) {
        files.push({ file: f, totalSize: inst.total_size || 0 });
      }
    }
    for (const bonus of product.downloads?.bonus_content || []) {
      for (const f of bonus.files || []) {
        files.push({ file: f, totalSize: bonus.total_size || 0 });
      }
    }

    // Apply per-game file selection filter.
    // Normalize IDs to strings on both sides — the renderer stores them as strings
    // (split from dataset.fileids) while the API may return numbers.
    const selectionSet = selectedFileIds != null ? new Set(selectedFileIds.map(String)) : null;
    const allFileIds = files.map((f) => String(f.file.id));
    const filteredFiles =
      selectionSet != null
        ? files.filter((f) => selectionSet.has(String(f.file.id)))
        : files;

    const isPartial =
      selectionSet != null && !allFileIds.every((id) => selectionSet.has(id));

    const totalFiles = filteredFiles.length;
    const downloadedFiles = [];
    const downloadedFileIds = [];
    const finalSizes = {};

    for (let fi = 0; fi < totalFiles; fi++) {
      const entry = filteredFiles[fi].file;

      const link = await this._retry('resolve downlink', String(entry.id), () =>
        this.client.resolveDownlink(entry.downlink),
      );

      const destPath = path.join(gameDir, link.filename);

      // Skip if file already exists with a known-good size.
      try {
        const info = await fsp.stat(destPath);
        if (this._isKnownGoodFile(link.filename, info.size, entry.size, knownSizes)) {
          console.log(`skip existing ${link.filename}`);
          downloadedFiles.push(link.filename);
          downloadedFileIds.push(String(entry.id));
          finalSizes[link.filename] = info.size;
          continue;
        }
      } catch {
        /* file doesn't exist – proceed to download */
      }

      this.emit('event', {
        type: 'progress',
        gameIndex: gameIdx,
        totalGames,
        gameName: product.title,
        fileIndex: fi + 1,
        totalFiles,
        fileName: link.filename,
        bytes: 0,
        totalBytes: entry.size || 0,
      });

      const actualSize = await this._retry('download', link.filename, () =>
        this._downloadFile(link.url, destPath, entry.size, (downloaded, total) => {
          if (downloaded === 0) return; // explicit bytes:0 emit above already covers this
          this.emit('event', {
            type: 'progress',
            gameIndex: gameIdx,
            totalGames,
            gameName: product.title,
            fileIndex: fi + 1,
            totalFiles,
            fileName: link.filename,
            bytes: downloaded,
            totalBytes: total || entry.size || 0,
          });
        }),
      );

      downloadedFiles.push(link.filename);
      downloadedFileIds.push(String(entry.id));
      finalSizes[link.filename] = actualSize;
    }

    await this._writeStatus(gameDir, downloadedFiles, downloadedFileIds, finalSizes, isPartial);
  }

  async _downloadFile(cdnURL, destPath, expectedSize, onProgress) {
    const partPath = destPath + '.part';
    let offset = 0;

    try {
      const stat = await fsp.stat(partPath);
      if (expectedSize > 0 && stat.size === expectedSize) {
        await fsp.rename(partPath, destPath);
        if (onProgress) onProgress(expectedSize, expectedSize);
        return expectedSize;
      }
      if (expectedSize > 0 && stat.size > expectedSize) {
        await fsp.unlink(partPath);
      } else {
        offset = stat.size;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    try {
      const result = await this.client.downloadToFile(cdnURL, partPath, offset, onProgress);

      const stat = await fsp.stat(partPath);
      let verifiedSize = expectedSize;
      if (result.totalSize > 0) verifiedSize = result.totalSize;
      if (verifiedSize > 0 && stat.size !== verifiedSize) {
        throw new Error(`size mismatch: got ${stat.size}, want ${verifiedSize}`);
      }

      await fsp.rename(partPath, destPath);
      return stat.size;
    } catch (err) {
      if (err.code === 'RANGE_NOT_SUPPORTED' && offset > 0) {
        await fsp.unlink(partPath).catch(() => {});
        return this._downloadFile(cdnURL, destPath, expectedSize, onProgress);
      }
      throw err;
    }
  }

  _isKnownGoodFile(name, actualSize, expectedSize, knownSizes) {
    if (expectedSize > 0 && actualSize === expectedSize) return true;
    const known = knownSizes[name];
    if (known > 0 && known === actualSize) return true;
    return false;
  }

  async _retry(action, name, fn) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_DOWNLOAD_ATTEMPTS || !isRetryable(err)) break;
        const delay = attempt * BASE_RETRY_DELAY;
        console.log(
          `${action} retry ${attempt}/${MAX_DOWNLOAD_ATTEMPTS - 1} for ${name}: ${err.message}`,
        );
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  async _writeStatus(gameDir, files, fileIds, fileSizes, partial = false) {
    const status = {
      last_backup: new Date().toISOString(),
      files,
      file_ids: fileIds,
      file_sizes: fileSizes,
      ...(partial ? { partial: true } : {}),
    };
    await fsp.writeFile(
      path.join(gameDir, '.backup-status.json'),
      JSON.stringify(status, null, 2),
    );
  }
}

function sanitizeName(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isRetryable(err) {
  if (err.statusCode) {
    return [408, 429, 500, 502, 503, 504].includes(err.statusCode);
  }
  if (err.code) {
    return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes(
      err.code,
    );
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function totalDownloadSize(product) {
  let total = 0;
  for (const inst of product.downloads?.installers || []) {
    for (const file of inst.files || []) total += file.size || 0;
  }
  for (const bonus of product.downloads?.bonus_content || []) {
    for (const file of bonus.files || []) total += file.size || 0;
  }
  return total;
}

module.exports = { BackupManager, totalDownloadSize, sanitizeName };
