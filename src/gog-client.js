const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const AUTH_BASE = 'https://auth.gog.com';
const EMBED_BASE = 'https://embed.gog.com';
const API_BASE = 'https://api.gog.com';
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

class GogClient {
  constructor(tokenFile) {
    this.tokenFile = tokenFile;
    this.token = null;
    this.refreshPromise = null;
  }

  static authURL() {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      layout: 'client2',
    });
    return `${AUTH_BASE}/auth?${params}`;
  }

  isAuthenticated() {
    if (!this.token || !this.token.access_token) return false;
    if (!this.token.expires_at) return true;
    return Date.now() < new Date(this.token.expires_at).getTime() - 30000;
  }

  async loadToken() {
    const data = await fsp.readFile(this.tokenFile, 'utf8');
    this.token = JSON.parse(data);

    await this.ensureValidToken();
  }

  async setToken(t) {
    if (!t.refresh_token && this.token?.refresh_token) {
      t.refresh_token = this.token.refresh_token;
    }
    if (!t.expires_at && t.expires_in) {
      t.expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
    }
    this.token = t;
    await this._persistToken();
  }

  async _persistToken() {
    await fsp.mkdir(path.dirname(this.tokenFile), { recursive: true });
    await fsp.writeFile(this.tokenFile, JSON.stringify(this.token, null, 2), { mode: 0o600 });
  }

  async exchangeCode(code) {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });
    await this._fetchToken(params);
  }

  async refreshToken() {
    if (!this.token?.refresh_token) throw new Error('no refresh token available');
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: this.token.refresh_token,
    });
    await this._fetchToken(params);
  }

  async ensureValidToken({ forceRefresh = false } = {}) {
    if (!this.token?.access_token) return;
    if (!forceRefresh && this.isAuthenticated()) return;
    if (!this.token.refresh_token) {
      if (forceRefresh) throw new Error('no refresh token available');
      return;
    }
    await this._refreshTokenSingleFlight();
  }

  async _refreshTokenSingleFlight() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async _fetchToken(params) {
    const resp = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`token request failed (${resp.status}): ${body}`);
    }
    const t = await resp.json();
    await this.setToken(t);
  }

  async resolveUserIDToken(rawURL) {
    let code = null;
    let currentURL = rawURL;

    for (let i = 0; i < 15; i++) {
      const resp = await fetch(currentURL, {
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      const location = resp.headers.get('location');
      if (!location) break;

      const u = new URL(location, currentURL);
      const c = u.searchParams.get('code');
      if (c) {
        code = c;
        break;
      }
      currentURL = u.href;
    }

    if (!code) {
      throw new Error(
        'GOG did not issue an authorization code via HTTP redirect. ' +
          'Let the GOG page fully load in your browser, then copy the final URL.',
      );
    }
    return code;
  }

  async getLibrary() {
    const all = [];
    for (let page = 1; ; page++) {
      const url = `${EMBED_BASE}/account/getFilteredProducts?mediaType=1&sortBy=title&page=${page}`;
      const result = await this._getJSON(url);
      all.push(...(result.products || []));
      if (page >= (result.totalPages || 1)) break;
    }
    return all;
  }

  async getProductDetails(id) {
    const url = `${API_BASE}/products/${id}?expand=downloads&locale=en-US`;
    return this._getJSON(url);
  }

  async resolveDownlink(downlink) {
    const resp = await this._fetchAuthed(downlink, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });

    let cdnURL;
    if ([301, 302, 307, 308].includes(resp.status)) {
      cdnURL = resp.headers.get('location');
    } else if (resp.ok) {
      const result = await resp.json();
      cdnURL = result.downlink;
    } else {
      const body = await resp.text();
      throw Object.assign(new Error(`downlink HTTP ${resp.status}: ${body}`), {
        statusCode: resp.status,
      });
    }

    if (!cdnURL) throw new Error('empty CDN URL from downlink');
    return { url: cdnURL, filename: filenameFromURL(cdnURL) };
  }

  /**
   * Downloads a CDN URL to a file path, optionally resuming from offset.
   * Returns { bytesWritten, totalSize }.
   */
  async downloadToFile(cdnURL, filePath, offset, onProgress) {
    const headers = {};
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    const resp = await fetch(cdnURL, { headers });

    let totalSize = 0;

    if (offset > 0) {
      if (resp.status === 206) {
        const cr = resp.headers.get('content-range');
        if (cr) {
          const m = cr.match(/bytes\s+(\d+)-\d+\/(\d+|\*)/);
          if (m) {
            const start = parseInt(m[1]);
            if (start !== offset) {
              throw new Error('unexpected content range');
            }
            if (m[2] !== '*') totalSize = parseInt(m[2]);
          }
        }
      } else if (resp.status === 200) {
        const err = new Error('range not supported');
        err.code = 'RANGE_NOT_SUPPORTED';
        throw err;
      } else {
        throw Object.assign(new Error(`download HTTP ${resp.status}`), {
          statusCode: resp.status,
        });
      }
    } else if (!resp.ok) {
      throw Object.assign(new Error(`download HTTP ${resp.status}`), {
        statusCode: resp.status,
      });
    }

    if (!totalSize) {
      const cl = resp.headers.get('content-length');
      if (cl) totalSize = offset + parseInt(cl);
    }

    if (onProgress) onProgress(offset, totalSize);

    let bytesWritten = 0;
    const progressTransform = new Transform({
      transform(chunk, _encoding, callback) {
        bytesWritten += chunk.length;
        if (onProgress) onProgress(offset + bytesWritten, totalSize);
        callback(null, chunk);
      },
    });

    const nodeStream = Readable.fromWeb(resp.body);
    const ws = fs.createWriteStream(filePath, { flags: offset > 0 ? 'a' : 'w' });

    await pipeline(nodeStream, progressTransform, ws);

    return { bytesWritten, totalSize };
  }

  async _getJSON(url) {
    const resp = await this._fetchAuthed(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return resp.json();
  }

  async _fetchAuthed(url, options = {}, allowRefreshRetry = true) {
    await this.ensureValidToken();

    const resp = await fetch(url, this._withAuthHeaders(options));
    if (allowRefreshRetry && isAuthFailure(resp) && this.token?.refresh_token) {
      await this.ensureValidToken({ forceRefresh: true });
      return fetch(url, this._withAuthHeaders(options));
    }
    return resp;
  }

  _withAuthHeaders(options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.token?.access_token) {
      headers.Authorization = `Bearer ${this.token.access_token}`;
    }
    return { ...options, headers };
  }
}

function isAuthFailure(resp) {
  return resp.status === 401 || resp.status === 403;
}

function filenameFromURL(rawURL) {
  const u = new URL(rawURL);
  let name = path.posix.basename(u.pathname);
  if (!name || name === '.' || name === '/') {
    throw new Error(`could not extract filename from ${rawURL}`);
  }
  return decodeURIComponent(name);
}

module.exports = { GogClient };
