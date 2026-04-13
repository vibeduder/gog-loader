/* global gogAPI */

let libraryGames = [];
let sizeCleanup = null;
let backupCleanup = null;
let rawGameSizes = {};        // gameId → raw bytes (total, all files)
let gameFileSelections = {};  // gameId → [fileId, ...] | null (null = all)
let gameCustomSizes = {};     // gameId → bytes for current selection (set when file picker saved)

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
  document.getElementById('backupFilter').addEventListener('change', filterGames);
  document.getElementById('btnSelectAll').addEventListener('click', () => selectAll(true));
  document.getElementById('btnDeselectAll').addEventListener('click', () => selectAll(false));
  document.getElementById('startBtn').addEventListener('click', onStartBackup);
  document.getElementById('btnChangeDir').addEventListener('click', onChangeDir);

  // Game grid — event delegation (registered once; grid.innerHTML is replaced on each load)
  document.getElementById('gameGrid').addEventListener('click', onGridClick);
  document.getElementById('gameGrid').addEventListener('change', updateSelection);

  // File picker modal
  document.getElementById('fpClose').addEventListener('click', closeFilePicker);
  document.getElementById('fpCancel').addEventListener('click', closeFilePicker);
  document.getElementById('fpSave').addEventListener('click', saveFilePicker);

  // Platform toggle buttons inside file picker (event delegation)
  document.getElementById('fpBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.fp-platform-btn');
    if (!btn) return;
    applyPlatformFilter(btn.dataset.platform);
  });
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

  rawGameSizes = {};
  gameFileSelections = {};
  gameCustomSizes = {};

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
  updateSelection();
  initThumbnails();
}

function renderGameCard(game) {
  const osData = `${game.worksOn?.Windows ? 'w' : ''}${game.worksOn?.Mac ? 'm' : ''}${game.worksOn?.Linux ? 'l' : ''}`;
  const backedBadge = game.backedUp
    ? `<span class="backed-badge${game.backedUp === 'partial' ? ' partial' : ''}">Backed up</span>`
    : '';
  return `
    <div class="game-card${game.backedUp ? ' backed-up' : ''}"
         data-id="${game.id}"
         data-title="${esc(game.title)}"
         data-os="${osData}"
         data-backed="${game.backedUp || 'none'}">
      ${backedBadge}
      <button class="gear-btn" data-gear="${game.id}" title="Select files">⚙</button>
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
  if (!card) return;
  if (e.target.dataset.gear != null) {
    showFilePicker(e.target.dataset.gear, card.dataset.title);
    return;
  }
  if (e.target.type === 'checkbox') return;
  const cb = card.querySelector('input[type=checkbox]');
  cb.checked = !cb.checked;
  updateSelection();
}

function updateSelection() {
  const cards = document.querySelectorAll('#gameGrid .game-card');
  let count = 0;
  let totalBytes = 0;
  cards.forEach((card) => {
    const cb = card.querySelector('input[type=checkbox]');
    card.classList.toggle('selected', cb.checked);
    if (cb.checked) {
      count++;
      const id = card.dataset.id;
      // Use custom computed size if the file picker was saved for this game,
      // otherwise fall back to the raw total size from the size stream.
      totalBytes += id in gameCustomSizes ? (gameCustomSizes[id] || 0) : (rawGameSizes[id] || 0);
    }
  });
  document.getElementById('selCount').textContent = `${count} selected`;
  document.getElementById('selSize').textContent = totalBytes > 0 ? `· ~${fmtBytes(totalBytes)}` : '';
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
  const backup = document.getElementById('backupFilter').value;
  document.querySelectorAll('#gameGrid .game-card').forEach((card) => {
    const titleMatch = !q || (card.dataset.title || '').toLowerCase().includes(q);
    const osMatch = !os || (card.dataset.os || '').includes(os);
    const b = card.dataset.backed || 'none';
    const backupMatch = !backup ||
      (backup === 'needs-backup' ? b === 'none' || b === 'partial' : b === backup);
    card.classList.toggle('filtered-out', !titleMatch || !osMatch || !backupMatch);
  });
}

function onSizeEvent(data) {
  if (data.gameId) {
    const el = document.getElementById(`size-${data.gameId}`);
    if (el) el.textContent = data.sizeLabel || 'Size unavailable';
    const wrap = document.getElementById(`size-wrap-${data.gameId}`);
    if (wrap) wrap.classList.remove('loading');
    rawGameSizes[data.gameId] = data.rawSize || 0;
    updateSelection();
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
    await gogAPI.startBackup(ids, gameFileSelections, 'all');
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

// ── File Picker ──

let fpCurrentGameId = null;
let fpCurrentDetails = null;

async function showFilePicker(gameId, title) {
  fpCurrentGameId = gameId;
  fpCurrentDetails = null;

  const modal = document.getElementById('filePickerModal');
  document.getElementById('fpTitle').textContent = title || 'Select files';
  document.getElementById('fpBody').innerHTML = '<div class="fp-loading">Loading file list…</div>';
  modal.classList.remove('hidden');

  try {
    fpCurrentDetails = await gogAPI.getGameDetails(Number(gameId));
    renderFilePicker(fpCurrentDetails, gameFileSelections[gameId]);

    // Auto-apply current platform on first open (no prior selection saved).
    if (!(gameId in gameFileSelections)) {
      const platform = getCurrentPlatform();
      if (platform !== 'all') {
        applyPlatformFilter(platform); // toggles button active + checks its installers
      }
    }
  } catch (err) {
    document.getElementById('fpBody').innerHTML =
      `<div class="fp-loading" style="color:#ef9a9a">Failed to load: ${escHTML(err.message || String(err))}</div>`;
  }
}

function getCurrentPlatform() {
  const p = (navigator.platform || '').toLowerCase();
  if (p.startsWith('win')) return 'win';
  if (p.startsWith('mac') || p.startsWith('iphone') || p.startsWith('ipad')) return 'mac';
  if (p.includes('linux')) return 'linux';
  return 'all';
}

function applyPlatformFilter(platform) {
  const osAliases = { win: ['windows'], mac: ['osx', 'mac'], linux: ['linux'] };

  if (platform === 'all') {
    // "All" is a shortcut: activate every platform button and check all installer items.
    document.querySelectorAll('#fpBody .fp-platform-btn:not([data-platform="all"])').forEach((b) =>
      b.classList.add('active'),
    );
    document.querySelectorAll('#fpBody .fp-item').forEach((item) => {
      const cb = item.querySelector('input[type=checkbox]');
      if (!cb) return;
      const section = item.closest('.fp-section');
      const sectionTitle = section?.querySelector('.fp-section-title')?.textContent?.toLowerCase();
      if (sectionTitle !== 'installers') return;
      cb.checked = true;
    });
    return;
  }

  // Toggle this platform's button on/off.
  const btn = document.querySelector(`#fpBody .fp-platform-btn[data-platform="${platform}"]`);
  const willBeActive = !btn?.classList.contains('active');
  if (btn) btn.classList.toggle('active', willBeActive);

  const matchOS = osAliases[platform] || [];
  document.querySelectorAll('#fpBody .fp-item').forEach((item) => {
    const cb = item.querySelector('input[type=checkbox]');
    if (!cb) return;
    const section = item.closest('.fp-section');
    const sectionTitle = section?.querySelector('.fp-section-title')?.textContent?.toLowerCase();
    if (sectionTitle !== 'installers') return; // Leave bonus content unchanged

    const itemOS = item.dataset.os || '';
    // Only affect items that match this platform (or have no OS tag).
    if (!itemOS || matchOS.includes(itemOS)) {
      cb.checked = willBeActive;
    }
  });
}

function renderFilePicker(details, currentSelection) {
  const osLabel = { windows: 'Win', osx: 'Mac', mac: 'Mac', linux: 'Linux' };
  const osCls = { windows: 'os-w', osx: 'os-m', mac: 'os-m', linux: 'os-l' };
  const backedUpFileIds = new Set((details.backedUpFileIds || []).map(String));

  function isChecked(fileIds) {
    if (!currentSelection) return true; // null = all selected
    return fileIds.some((id) => currentSelection.includes(String(id)));
  }

  function backupState(fileIds) {
    if (!backedUpFileIds.size || !fileIds?.length) return 'none';
    const backedCount = fileIds.filter((id) => backedUpFileIds.has(String(id))).length;
    if (backedCount === 0) return 'none';
    return backedCount === fileIds.length ? 'full' : 'partial';
  }
  const halfSvg = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M3 6h6" stroke="#ffb74d" stroke-width="2" stroke-linecap="round"/></svg>';
  const missSvg = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4" stroke="#757575" stroke-width="1.5"/></svg>';

  // Shows per-file breakdown for multi-file partial items so the user can see
  // exactly which files within an installer are downloaded vs missing.
  function fileBreakdown(fileIds, fileSizes) {
    if (!fileSizes || fileSizes.length <= 1) return '';
    const rows = fileSizes.map((sz, idx) => {
      const done = backedUpFileIds.has(String(fileIds[idx]));
      return `<div class="fp-file-row${done ? ' fp-file-row--done' : ''}">${done ? checkSvg : missSvg} ${fmtBytes(sz)}</div>`;
    });
    return `<div class="fp-file-list">${rows.join('')}</div>`;
  }

  const checkSvg = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#81c784" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Last backup banner
  let html = '';
  if (details.lastBackup) {
    const d = new Date(details.lastBackup);
    const label = isNaN(d) ? details.lastBackup : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    html += `<div class="fp-backed-bar">${checkSvg} Last backed up: ${escHTML(label)}</div>`;
  }

  // Platform quick-select buttons
  html += '<div class="fp-platform-bar">';
  html += '<span class="fp-platform-label">Platform:</span>';
  html += '<button class="fp-platform-btn" data-platform="win">Windows</button>';
  html += '<button class="fp-platform-btn" data-platform="mac">macOS</button>';
  html += '<button class="fp-platform-btn" data-platform="linux">Linux</button>';
  html += '<button class="fp-platform-btn" data-platform="all">All</button>';
  html += '</div>';

  if (details.installers.length > 0) {
    html += '<div class="fp-section"><div class="fp-section-title">Installers</div>';
    for (const inst of details.installers) {
      const os = (inst.os || '').toLowerCase();
      const badge = os
        ? `<span class="os-badge ${osCls[os] || ''}">${osLabel[os] || inst.os}</span>`
        : '';
      const lang = inst.language ? `${inst.language} · ` : '';
      const ver = inst.version ? `v${inst.version} · ` : '';
      const checked = isChecked(inst.fileIds) ? 'checked' : '';
      const ids = esc(inst.fileIds.join(','));
      const instState = backupState(inst.fileIds);
      const backedBadge = instState === 'full'
        ? `<div class="fp-item-backed">${checkSvg} backed up</div>`
        : instState === 'partial'
        ? `<div class="fp-item-backed fp-item-backed--partial">${halfSvg} partial</div>`
        : '';
      html += `<label class="fp-item${instState !== 'none' ? ' fp-item--' + instState : ''}" data-os="${esc(os)}">
        <input type="checkbox" ${checked} data-fileids="${ids}">
        ${badge}
        <div class="fp-item-info">
          <div class="fp-item-name">${lang}${ver}${fmtBytes(inst.totalSize)}</div>
          ${backedBadge}
          ${instState === 'partial' ? fileBreakdown(inst.fileIds, inst.fileSizes) : ''}
        </div>
      </label>`;
    }
    html += '</div>';
  }

  if (details.bonusContent.length > 0) {
    html += '<div class="fp-section"><div class="fp-section-title">Bonus content</div>';
    for (const bonus of details.bonusContent) {
      const checked = isChecked(bonus.fileIds) ? 'checked' : '';
      const ids = esc(bonus.fileIds.join(','));
      const bonusState = backupState(bonus.fileIds);
      const backedBadge = bonusState === 'full'
        ? `<div class="fp-item-backed">${checkSvg} backed up</div>`
        : bonusState === 'partial'
        ? `<div class="fp-item-backed fp-item-backed--partial">${halfSvg} partial</div>`
        : '';
      html += `<label class="fp-item${bonusState !== 'none' ? ' fp-item--' + bonusState : ''}">
        <input type="checkbox" ${checked} data-fileids="${ids}">
        <div class="fp-item-info">
          <div class="fp-item-name">${escHTML(bonus.name)}</div>
          <div class="fp-item-size">${fmtBytes(bonus.totalSize)}</div>
          ${backedBadge}
          ${bonusState === 'partial' ? fileBreakdown(bonus.fileIds, bonus.fileSizes) : ''}
        </div>
      </label>`;
    }
    html += '</div>';
  }

  if (!html) {
    html = '<div class="fp-loading">No downloadable files found.</div>';
  }

  document.getElementById('fpBody').innerHTML = html;
}

function saveFilePicker() {
  if (!fpCurrentGameId || !fpCurrentDetails) {
    closeFilePicker();
    return;
  }

  const checkboxes = document.querySelectorAll('#fpBody input[type=checkbox]');
  const selectedIds = new Set();
  checkboxes.forEach((cb) => {
    if (cb.checked && cb.dataset.fileids) {
      cb.dataset.fileids.split(',').filter(Boolean).forEach((id) => selectedIds.add(id));
    }
  });

  const allIds = [
    ...fpCurrentDetails.installers.flatMap((i) => i.fileIds.map(String)),
    ...fpCurrentDetails.bonusContent.flatMap((b) => b.fileIds.map(String)),
  ];

  // null means "all" — only store explicit selection if it differs from all
  const isAll = allIds.length > 0 && allIds.length === selectedIds.size && allIds.every((id) => selectedIds.has(id));
  gameFileSelections[fpCurrentGameId] = isAll ? null : [...selectedIds];

  // Compute the size for the current selection so updateSelection() can show it accurately.
  let selectedSize = 0;
  for (const inst of fpCurrentDetails.installers) {
    if (inst.fileIds.some((id) => selectedIds.has(String(id)))) {
      selectedSize += inst.totalSize || 0;
    }
  }
  for (const bonus of fpCurrentDetails.bonusContent) {
    if (bonus.fileIds.some((id) => selectedIds.has(String(id)))) {
      selectedSize += bonus.totalSize || 0;
    }
  }
  gameCustomSizes[fpCurrentGameId] = selectedSize;

  closeFilePicker();
  updateSelection();
}

function closeFilePicker() {
  document.getElementById('filePickerModal').classList.add('hidden');
  fpCurrentGameId = null;
  fpCurrentDetails = null;
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
