/* global gogAPI */

let libraryGames = [];
let sizeCleanup = null;
let backupCleanup = null;

// ── Initialization ──

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindNavigation();
  const auth = await gogAPI.getAuthState();
  await showHome(auth);
}

// ── Navigation ──

function bindNavigation() {
  const nav = (view) => (e) => {
    e.preventDefault();
    navigate(view);
  };
  document.getElementById('homeLink').addEventListener('click', nav('home'));
  document.getElementById('btnLogout').addEventListener('click', onLogout);
  document.getElementById('btnLogin').addEventListener('click', onLoginClick);
  document.getElementById('btnViewLibrary').addEventListener('click', nav('library'));
  document.getElementById('loginCancel').addEventListener('click', nav('home'));
  document.getElementById('errorBack').addEventListener('click', nav('home'));

  document.getElementById('authForm').addEventListener('submit', onAuthSubmit);
  document.getElementById('searchInput').addEventListener('input', filterGames);
  document.getElementById('osFilter').addEventListener('change', filterGames);
  document.getElementById('btnSelectAll').addEventListener('click', () => selectAll(true));
  document.getElementById('btnDeselectAll').addEventListener('click', () => selectAll(false));
  document.getElementById('startBtn').addEventListener('click', onStartBackup);
  document.getElementById('btnChangeDir').addEventListener('click', onChangeDir);
}

async function navigate(view, data) {
  // Tear down listeners from previous view.
  if (sizeCleanup) {
    sizeCleanup();
    sizeCleanup = null;
  }

  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');

  switch (view) {
    case 'home':
      await showHome();
      break;
    case 'login':
      await showLogin();
      break;
    case 'library':
      await showLibrary();
      break;
    case 'progress':
      showProgress(data);
      break;
    case 'error':
      document.getElementById('errorMessage').textContent = data || 'Unknown error';
      break;
  }
}

// ── Home ──

async function showHome(authOverride) {
  const auth = authOverride !== undefined ? authOverride : await gogAPI.getAuthState();
  document.getElementById('authBadge').classList.toggle('hidden', !auth);
  document.getElementById('btnLogout').classList.toggle('hidden', !auth);
  document.getElementById('homeAuth').classList.toggle('hidden', !auth);
  document.getElementById('homeUnauth').classList.toggle('hidden', !!auth);
}

// ── Login ──

async function onLoginClick(e) {
  if (e) e.preventDefault();
  try {
    const result = await gogAPI.openAuthWindow();
    if (result?.success) {
      navigate('library');
      return;
    }
    // Auth window was closed or failed — show manual fallback
    if (result?.error && result.error !== 'Login window was closed') {
      navigate('login');
      const errEl = document.getElementById('loginError');
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      return;
    }
    // User closed the window — just show manual fallback
    navigate('login');
  } catch (err) {
    navigate('login');
    const errEl = document.getElementById('loginError');
    errEl.textContent = err.message || String(err);
    errEl.classList.remove('hidden');
  }
}

async function showLogin() {
  document.getElementById('loginError').classList.add('hidden');
  document.getElementById('authInput').value = '';
  document.getElementById('authInput').focus();
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('authInput').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');

  try {
    await gogAPI.submitAuth(input);
    navigate('library');
  } catch (err) {
    errEl.textContent = err.message || String(err);
    errEl.classList.remove('hidden');
  }
}

// ── Library ──

async function showLibrary() {
  const auth = await gogAPI.getAuthState();
  if (!auth) {
    navigate('home');
    return;
  }
  document.getElementById('authBadge').classList.remove('hidden');
  document.getElementById('btnLogout').classList.remove('hidden');

  // Settings
  try {
    const s = await gogAPI.getSettings();
    document.getElementById('gamesDirLabel').textContent = s.gamesDir;
  } catch {
    /* ignore */
  }

  const grid = document.getElementById('gameGrid');
  const loading = document.getElementById('libraryLoading');
  const sizeLoader = document.getElementById('sizeLoader');

  grid.innerHTML = '';
  loading.classList.remove('hidden');
  sizeLoader.classList.add('hidden');

  try {
    libraryGames = await gogAPI.getLibrary();
  } catch (err) {
    loading.classList.add('hidden');
    navigate('error', 'Failed to load library: ' + (err.message || err));
    return;
  }

  loading.classList.add('hidden');
  document.getElementById('totalGames').textContent = `${libraryGames.length} games in library`;
  document.getElementById('runningNotice').classList.add('hidden');
  renderGameGrid(libraryGames);

  // Stream sizes
  if (libraryGames.length > 0) {
    sizeLoader.classList.remove('hidden');
    sizeLoader.classList.remove('complete');
    document.getElementById('sizeLoaderTitle').textContent = 'Loading game sizes…';
    document.getElementById('sizeLoaderSub').textContent = `0 / ${libraryGames.length} processed`;
    document.getElementById('sizeProgressBar').style.width = '0%';

    sizeCleanup = gogAPI.onSizeEvent(onSizeEvent);
    gogAPI.streamLibrarySizes(libraryGames.map((g) => g.id));
  }
}

function renderGameGrid(games) {
  const grid = document.getElementById('gameGrid');
  grid.innerHTML = games.map(renderGameCard).join('');

  // Event delegation for card clicks and checkbox changes
  grid.addEventListener('click', onGridClick);
  grid.addEventListener('change', updateSelection);

  updateSelection();
  initThumbnails();
}

function renderGameCard(game) {
  const osData = `${game.worksOn?.Windows ? 'w' : ''}${game.worksOn?.Mac ? 'm' : ''}${game.worksOn?.Linux ? 'l' : ''}`;
  return `
    <div class="game-card${game.backedUp ? ' backed-up' : ''}"
         data-id="${game.id}"
         data-title="${esc(game.title)}"
         data-os="${osData}">
      ${game.backedUp ? '<span class="backed-badge">Backed up</span>' : ''}
      <input type="checkbox" value="${game.id}">
      <div class="game-thumb${!game.thumbnailURL ? ' ready error' : ''}" data-thumb="${esc(game.thumbnailURL || '')}">
        <img alt="${esc(game.title)} cover" decoding="async" loading="lazy">
        <span class="game-thumb-fallback">${game.thumbnailURL ? 'Loading' : 'No image'}</span>
      </div>
      <div class="game-info">
        <div class="game-title" title="${esc(game.title)}">${escHTML(game.title)}</div>
        <div class="game-size loading" id="size-wrap-${game.id}">
          <span class="inline-spinner"></span>
          <span id="size-${game.id}">Calculating…</span>
        </div>
        <div class="game-meta">
          ${game.worksOn?.Windows ? '<span class="os-badge os-w">Win</span>' : ''}
          ${game.worksOn?.Mac ? '<span class="os-badge os-m">Mac</span>' : ''}
          ${game.worksOn?.Linux ? '<span class="os-badge os-l">Linux</span>' : ''}
        </div>
      </div>
    </div>`;
}

function onGridClick(e) {
  const card = e.target.closest('.game-card');
  if (!card || e.target.type === 'checkbox') return;
  const cb = card.querySelector('input[type=checkbox]');
  cb.checked = !cb.checked;
  updateSelection();
}

function updateSelection() {
  const cards = document.querySelectorAll('#gameGrid .game-card');
  let count = 0;
  cards.forEach((card) => {
    const cb = card.querySelector('input[type=checkbox]');
    card.classList.toggle('selected', cb.checked);
    if (cb.checked) count++;
  });
  document.getElementById('selCount').textContent = `${count} selected`;
  document.getElementById('startBtn').disabled = count === 0;
}

function selectAll(state) {
  document.querySelectorAll('#gameGrid .game-card:not(.filtered-out) input[type=checkbox]').forEach(
    (cb) => {
      cb.checked = state;
    },
  );
  updateSelection();
}

function filterGames() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const os = document.getElementById('osFilter').value;
  document.querySelectorAll('#gameGrid .game-card').forEach((card) => {
    const titleMatch = !q || (card.dataset.title || '').toLowerCase().includes(q);
    const osMatch = !os || (card.dataset.os || '').includes(os);
    card.classList.toggle('filtered-out', !titleMatch || !osMatch);
  });
}

function onSizeEvent(data) {
  if (data.gameId) {
    const el = document.getElementById(`size-${data.gameId}`);
    if (el) el.textContent = data.sizeLabel || 'Size unavailable';
    const wrap = document.getElementById(`size-wrap-${data.gameId}`);
    if (wrap) wrap.classList.remove('loading');
  }

  const loader = document.getElementById('sizeLoader');
  const total = data.total || libraryGames.length || 1;
  const completed = data.completed || 0;
  const pct = total ? (completed / total) * 100 : 100;
  document.getElementById('sizeProgressBar').style.width = `${pct}%`;
  document.getElementById('sizeLoaderSub').textContent = `${completed} / ${total} processed`;

  if (data.done) {
    document.getElementById('sizeLoaderTitle').textContent = 'Game sizes loaded';
    loader.classList.add('complete');
    setTimeout(() => loader.classList.add('hidden'), 1200);
    if (sizeCleanup) {
      sizeCleanup();
      sizeCleanup = null;
    }
  }
  if (data.error) {
    document.getElementById('sizeLoaderTitle').textContent = 'Some game sizes could not be loaded';
    document.getElementById('sizeLoaderSub').textContent = data.error;
    loader.classList.add('complete');
  }
}

async function onChangeDir() {
  const dir = await gogAPI.selectDirectory();
  if (!dir) return;
  await gogAPI.setGamesDir(dir);
  document.getElementById('gamesDirLabel').textContent = dir;
}

// ── Start Backup ──

async function onStartBackup() {
  const checked = document.querySelectorAll('#gameGrid input[type=checkbox]:checked');
  const ids = Array.from(checked).map((cb) => Number(cb.value));
  if (ids.length === 0) return;

  try {
    await gogAPI.startBackup(ids);
    navigate('progress', { count: ids.length });
  } catch (err) {
    navigate('error', err.message || String(err));
  }
}

// ── Progress ──

function showProgress(data) {
  const count = data?.count || '?';
  document.getElementById('progressTitle').textContent = `Backup Progress – ${count} game(s)`;
  document.getElementById('gameBar').style.width = '0%';
  document.getElementById('fileBar').style.width = '0%';
  document.getElementById('gameLabel').textContent = 'Initializing…';
  document.getElementById('gameCounter').textContent = '';
  document.getElementById('fileLabel').textContent = '–';
  document.getElementById('fileSize').textContent = '';
  document.getElementById('noticeArea').innerHTML = '';
  document.getElementById('logArea').innerHTML = '';
  document.getElementById('doneArea').innerHTML = '';

  let lastGame = '';

  if (backupCleanup) backupCleanup();
  backupCleanup = gogAPI.onBackupEvent((ev) => {
    if (ev.type === 'progress') {
      if (ev.totalGames > 0) {
        const pct = (((ev.gameIndex - 1) / ev.totalGames) * 100).toFixed(1);
        document.getElementById('gameBar').style.width = `${pct}%`;
        document.getElementById('gameLabel').textContent = ev.gameName || 'Working…';
        document.getElementById('gameCounter').textContent = `${ev.gameIndex} / ${ev.totalGames}`;
      }
      if (ev.totalBytes > 0 && ev.bytes > 0) {
        const fp = ((ev.bytes / ev.totalBytes) * 100).toFixed(1);
        document.getElementById('fileBar').style.width = `${fp}%`;
        document.getElementById('fileLabel').textContent = ev.fileName || '';
        document.getElementById('fileSize').textContent = `${fmtBytes(ev.bytes)} / ${fmtBytes(ev.totalBytes)} (${fp}%)`;
      }
      if (ev.gameName && ev.gameName !== lastGame) {
        logMsg(`▶ ${ev.gameName}`, 'info');
        lastGame = ev.gameName;
      }
      if (ev.bytes === 0 && ev.fileName) {
        logMsg(`  ↓ ${ev.fileName}`, 'info');
      }
    } else if (ev.type === 'done') {
      document.getElementById('gameBar').style.width = '100%';
      document.getElementById('fileBar').style.width = '100%';
      document.getElementById('gameLabel').textContent = 'Complete';
      logMsg(`✓ ${ev.message}`, 'ok');
      document.getElementById('doneArea').innerHTML =
        `<div class="notice notice-ok">✓ ${escHTML(ev.message)}</div>` +
        `<a class="btn-back" id="backToLibrary">Back to Library</a>`;
      document.getElementById('backToLibrary').addEventListener('click', (e) => {
        e.preventDefault();
        navigate('library');
      });
      if (backupCleanup) {
        backupCleanup();
        backupCleanup = null;
      }
    } else if (ev.type === 'error') {
      logMsg(`✗ ${ev.message}`, 'err');
      document.getElementById('noticeArea').innerHTML = `<div class="notice notice-err">⚠ ${escHTML(ev.message)}</div>`;
    }
  });
}

async function onLogout() {
  await gogAPI.logout();
  navigate('home');
}

function logMsg(msg, cls) {
  const logEl = document.getElementById('logArea');
  const d = document.createElement('div');
  d.className = cls || 'info';
  d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Thumbnails ──

function initThumbnails() {
  const thumbs = document.querySelectorAll('#gameGrid .game-thumb');
  if (!thumbs.length) return;

  if (!('IntersectionObserver' in window)) {
    thumbs.forEach(loadThumbnail);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        loadThumbnail(entry.target);
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '240px 0px' },
  );

  thumbs.forEach((thumb) => observer.observe(thumb));
}

function loadThumbnail(thumb) {
  if (!thumb || thumb.dataset.loaded === '1') return;
  thumb.dataset.loaded = '1';

  const src = thumb.dataset.thumb;
  if (!src) {
    thumb.classList.add('ready', 'error');
    return;
  }

  const img = thumb.querySelector('img');
  if (!img) {
    thumb.classList.add('ready', 'error');
    return;
  }

  img.onload = () => thumb.classList.add('ready');
  img.onerror = () => thumb.classList.add('ready', 'error');
  img.src = src;
}

// ── Helpers ──

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(1)} ${u[i]}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escHTML(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
