const $ = (id) => document.getElementById(id);

let settings = null;
let clientInfo = null;
let currentAuthUrl = '';
let launching = false;
let gameRunning = false;
let stoppingGame = false;
let installedMods = [];
let modStatuses = {};
let lastSearchResults = [];
let modBrowseLoaded = false;
let modSearchPage = 1;
let modSearchTotalPages = 1;
let modSearchTotal = 0;
let modSearchPageSize = 24;
let modSearchQuery = '';
let toastTimer = null;
let skinViewer = null;
let skinLoadSerial = 0;


// ---------------------------------------------------------
// SpectorClient UI sound engine
// Uses Web Audio so the launcher does not need bundled .wav/.mp3 files.
// ---------------------------------------------------------
let uiAudioContext = null;
let lastHoverSoundAt = 0;
let lastGameSoundState = '';

function soundEnabled() {
  return settings?.soundsEnabled !== false && Number(settings?.soundVolume ?? 42) > 0;
}

function soundLevel(multiplier = 1) {
  const raw = Math.max(0, Math.min(100, Number(settings?.soundVolume ?? 42))) / 100;
  return raw * 0.11 * multiplier;
}

function getAudioContext() {
  if (!soundEnabled()) return null;
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!uiAudioContext) uiAudioContext = new AudioCtx();
  if (uiAudioContext.state === 'suspended') uiAudioContext.resume().catch(() => {});
  return uiAudioContext;
}

function synthTone(ctx, frequency, start, duration, volume, type = 'sine') {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + Math.min(0.012, duration * 0.28));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.01);
}

function playUiSound(name = 'click') {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime + 0.004;
  const patterns = {
    hover: [
      [780, 0.000, 0.026, 0.34, 'sine'],
      [980, 0.018, 0.022, 0.18, 'sine']
    ],
    click: [
      [470, 0.000, 0.040, 0.62, 'triangle'],
      [690, 0.026, 0.045, 0.42, 'sine']
    ],
    play: [
      [330, 0.000, 0.060, 0.64, 'triangle'],
      [520, 0.048, 0.075, 0.72, 'triangle'],
      [760, 0.110, 0.110, 0.56, 'sine']
    ],
    stop: [
      [520, 0.000, 0.052, 0.62, 'triangle'],
      [310, 0.040, 0.095, 0.58, 'triangle']
    ],
    success: [
      [523, 0.000, 0.060, 0.54, 'sine'],
      [659, 0.052, 0.070, 0.60, 'sine'],
      [784, 0.112, 0.100, 0.66, 'sine']
    ],
    error: [
      [260, 0.000, 0.070, 0.70, 'square'],
      [185, 0.058, 0.120, 0.52, 'triangle']
    ],
    install: [
      [410, 0.000, 0.050, 0.46, 'triangle'],
      [610, 0.042, 0.065, 0.56, 'triangle'],
      [820, 0.095, 0.075, 0.46, 'sine']
    ],
    theme: [
      [440, 0.000, 0.045, 0.44, 'sine'],
      [700, 0.038, 0.070, 0.56, 'sine']
    ]
  };
  const pattern = patterns[name] || patterns.click;
  for (const [freq, offset, dur, strength, type] of pattern) {
    synthTone(ctx, freq, now + offset, dur, soundLevel(strength), type);
  }
}

function syncSoundUi() {
  const enabled = settings?.soundsEnabled !== false;
  const volume = Math.max(0, Math.min(100, Number(settings?.soundVolume ?? 42)));
  if ($('soundsEnabled')) $('soundsEnabled').checked = enabled;
  if ($('soundVolume')) $('soundVolume').value = String(volume);
  if ($('soundVolumeValue')) $('soundVolumeValue').textContent = `${Math.round(volume)}%`;
  if ($('soundVolume')) $('soundVolume').disabled = !enabled;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function showToast(message, timeout = 2600) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), timeout);
}

function selectedAccount() {
  return settings?.accounts?.find((a) => a.id === settings.selectedAccountId) || null;
}

function skinHeadUrl(account, size = 80) {
  return account?.uuid ? `https://mc-heads.net/avatar/${encodeURIComponent(account.uuid)}/${size}` : '';
}

function skinBodyUrl(account) {
  return account?.uuid ? `https://mc-heads.net/body/${encodeURIComponent(account.uuid)}/260` : '';
}

function ensureSkinViewer() {
  if (skinViewer) return skinViewer;
  const canvas = $('skinViewerCanvas');
  const lib = globalThis.skinview3d;
  if (!canvas || !lib?.SkinViewer) return null;

  skinViewer = new lib.SkinViewer({
    canvas,
    width: 320,
    height: 400,
    alpha: true
  });
  skinViewer.controls.enableRotate = true;
  skinViewer.controls.enableZoom = false;
  skinViewer.controls.enablePan = false;
  skinViewer.zoom = 0.82;
  skinViewer.fov = 55;
  skinViewer.autoRotate = false;
  skinViewer.renderer.setClearColor(0x000000, 0);
  return skinViewer;
}

async function loadInteractiveSkin(account) {
  const viewer = ensureSkinViewer();
  if (!viewer || !account) return false;
  const serial = ++skinLoadSerial;
  try {
    const dataUrl = await window.launcher.getSkinData(account.id);
    if (serial !== skinLoadSerial || !dataUrl) return false;
    await viewer.loadSkin(dataUrl);
    if (serial !== skinLoadSerial) return false;
    viewer.controls.enableRotate = true;
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDownloads(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  document.querySelectorAll('.rail-btn[data-view]').forEach((button) => button.classList.remove('active'));
  const view = $(`view-${name}`);
  if (!view) return;
  view.classList.add('active');
  const nav = document.querySelector(`.rail-btn[data-view="${name}"]`);
  if (nav) nav.classList.add('active');
  $('accountDropdown').classList.add('hidden');

  if (name === 'mods') {
    refreshInstalledMods();
    if (!modBrowseLoaded) {
      modBrowseLoaded = true;
      searchMods('');
    }
  }
}

document.querySelectorAll('.rail-btn[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    showView(button.dataset.view);
  });
});

function renderTopAccount() {
  const account = selectedAccount();
  $('topAccountName').textContent = account?.name || 'Sign in';
  const old = $('topAccountAvatar');
  if (account) {
    const img = document.createElement('img');
    img.id = 'topAccountAvatar';
    img.className = 'tiny-avatar';
    img.src = skinHeadUrl(account, 64);
    img.alt = account.name;
    img.onerror = () => {
      const fallback = document.createElement('span');
      fallback.id = 'topAccountAvatar';
      fallback.className = 'tiny-avatar placeholder';
      fallback.textContent = account.name.slice(0, 1).toUpperCase();
      img.replaceWith(fallback);
    };
    old.replaceWith(img);
  } else if (!old.classList.contains('placeholder')) {
    const fallback = document.createElement('span');
    fallback.id = 'topAccountAvatar';
    fallback.className = 'tiny-avatar placeholder';
    fallback.textContent = '?';
    old.replaceWith(fallback);
  } else {
    old.textContent = '?';
  }
}

async function renderPlayer() {
  const account = selectedAccount();
  $('homeAccountName').textContent = account?.name || 'No account selected';
  const canvas = $('skinViewerCanvas');
  const fallback = $('playerSkinFallback');
  const hint = $('skinDragHint');
  const placeholder = $('skinPlaceholder');

  skinLoadSerial += 1;
  canvas.classList.add('hidden');
  hint.classList.add('hidden');
  fallback.classList.add('hidden');
  fallback.removeAttribute('src');

  if (!account) {
    placeholder.classList.remove('hidden');
    return;
  }

  placeholder.classList.add('hidden');
  const loaded = await loadInteractiveSkin(account);
  if (loaded && selectedAccount()?.id === account.id) {
    canvas.classList.remove('hidden');
    hint.classList.remove('hidden');
    return;
  }

  // Fallback only if the local 3D viewer cannot load.
  fallback.classList.remove('hidden');
  fallback.src = skinBodyUrl(account);
  fallback.alt = `${account.name}'s Minecraft skin`;
  fallback.onerror = () => {
    fallback.classList.add('hidden');
    placeholder.classList.remove('hidden');
    placeholder.querySelector('span').textContent = account.name.slice(0, 1).toUpperCase();
    placeholder.querySelector('small').textContent = 'SKIN PREVIEW UNAVAILABLE';
  };
}

function renderAccountDropdown() {
  const drop = $('accountDropdown');
  const accounts = settings?.accounts || [];
  if (!accounts.length) {
    drop.innerHTML = `
      <div class="account-drop-item" id="quickAddAccount">
        <span class="tiny-avatar placeholder">+</span>
        <div><b>Add Microsoft account</b><small>Sign in to Minecraft Java</small></div>
      </div>`;
    $('quickAddAccount').addEventListener('click', startAddAccount);
    return;
  }

  drop.innerHTML = accounts.map((account) => `
    <button class="account-drop-item ${account.id === settings.selectedAccountId ? 'selected' : ''}" data-account-id="${escapeHtml(account.id)}">
      <img class="tiny-avatar" src="${skinHeadUrl(account, 64)}" alt="" />
      <div><b>${escapeHtml(account.name)}</b><small>${account.id === settings.selectedAccountId ? 'Selected' : 'Switch account'}</small></div>
    </button>
  `).join('') + `<button id="manageAccountsBtn" class="account-drop-manage">MANAGE ACCOUNTS</button>`;

  drop.querySelectorAll('[data-account-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.launcher.selectAccount(button.dataset.accountId);
        settings.selectedAccountId = button.dataset.accountId;
        renderAllAccountUI();
        drop.classList.add('hidden');
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  $('manageAccountsBtn').addEventListener('click', () => showView('accounts'));
}

function renderAccounts() {
  const list = $('accountsList');
  if (!settings?.accounts?.length) {
    list.innerHTML = `<div class="empty-state compact-empty"><div><b>No Microsoft accounts yet</b><span>Use “Add Microsoft account” to sign in.</span></div></div>`;
    return;
  }

  list.innerHTML = settings.accounts.map((account) => `
    <div class="account-card ${account.id === settings.selectedAccountId ? 'selected' : ''}">
      <div class="account-card-top">
        <img class="account-avatar" src="${skinHeadUrl(account, 96)}" alt="" />
        <div><h3>${escapeHtml(account.name)}</h3><p>${escapeHtml(account.uuid)}</p></div>
      </div>
      <div class="account-actions">
        <button class="secondary-btn select-account" data-id="${escapeHtml(account.id)}">${account.id === settings.selectedAccountId ? 'Selected' : 'Use account'}</button>
        <button class="danger-btn remove-account" data-id="${escapeHtml(account.id)}">Remove</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.select-account').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.launcher.selectAccount(button.dataset.id);
        settings.selectedAccountId = button.dataset.id;
        renderAllAccountUI();
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  list.querySelectorAll('.remove-account').forEach((button) => {
    button.addEventListener('click', async () => {
      const account = settings.accounts.find((a) => a.id === button.dataset.id);
      if (!window.confirm(`Remove ${account?.name || 'this account'} from SpectorClient?`)) return;
      try {
        settings = await window.launcher.removeAccount(button.dataset.id);
        renderAllAccountUI();
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

function renderAllAccountUI() {
  renderTopAccount();
  renderPlayer();
  renderAccounts();
  renderAccountDropdown();
  updatePlayState();
}

const THEME_NAMES = { classic: 'Classic', 'classic-pink': 'Classic Pink', crimson: 'Crimson', prince: 'Prince' };

function normalizeTheme(value) {
  return Object.prototype.hasOwnProperty.call(THEME_NAMES, value) ? value : 'classic';
}

function applyTheme(themeValue = settings?.theme) {
  const theme = normalizeTheme(themeValue);
  document.documentElement.dataset.theme = theme;

  if ($('themeNameValue')) $('themeNameValue').textContent = THEME_NAMES[theme];
  document.querySelectorAll('[data-theme-option]').forEach((button) => {
    const selected = button.dataset.themeOption === theme;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  });

  return theme;
}

function applyAppearanceSettings() {
  const animations = settings?.animationsEnabled !== false;
  applyTheme(settings?.theme);
  // v1.4.2+: the launcher is intentionally 100% opaque.
  document.documentElement.style.setProperty('--background-opacity', '1');
  document.body.classList.remove('full-transparency');
  document.body.classList.toggle('no-animations', !animations);
  if ($('animationsEnabled')) $('animationsEnabled').checked = animations;
  syncSoundUi();
}

function syncScaleUi(scale) {
  const value = Math.round((Number(scale) || 1) * 100);
  if ($('uiScale')) $('uiScale').value = String(value);
  if ($('uiScaleValue')) $('uiScaleValue').textContent = `${value}%`;
}

function fillSettings() {
  ['minRamGb', 'maxRamGb', 'javaPath', 'width', 'height'].forEach((id) => {
    $(id).value = settings?.[id] ?? '';
  });
  $('fullscreen').checked = Boolean(settings?.fullscreen);
  $('closeLauncherOnStart').checked = Boolean(settings?.closeLauncherOnStart);
  $('serverAddress').value = settings?.serverAddress || '';
  $('gameDirectory').textContent = clientInfo?.gameDirectory || settings?.gameDirectory || '%APPDATA%\\spectorclient';
  syncScaleUi(settings?.uiScale || 1);
  applyAppearanceSettings();
}

function collectSettings() {
  return {
    ...settings,
    minRamGb: Number($('minRamGb').value),
    maxRamGb: Number($('maxRamGb').value),
    javaPath: $('javaPath').value.trim(),
    width: Number($('width').value),
    height: Number($('height').value),
    fullscreen: $('fullscreen').checked,
    closeLauncherOnStart: $('closeLauncherOnStart').checked,
    logsPopout: true,
    serverAddress: $('serverAddress').value.trim(),
    uiScale: Number($('uiScale').value) / 100,
    animationsEnabled: $('animationsEnabled').checked,
    soundsEnabled: $('soundsEnabled').checked,
    soundVolume: Number($('soundVolume').value),
    theme: normalizeTheme(settings?.theme)
  };
}

function updatePlayState() {
  const account = selectedAccount();
  const button = $('playBtn');
  const icon = button.querySelector('.play-icon');
  const label = button.querySelector('b');

  button.classList.toggle('stop-state', gameRunning || stoppingGame);

  if (gameRunning) {
    button.disabled = stoppingGame;
    icon.textContent = stoppingGame ? '■' : '■';
    label.textContent = stoppingGame ? 'STOPPING…' : 'STOP';
    $('playSubtext').textContent = stoppingGame
      ? 'Closing Minecraft…'
      : `Minecraft 26.2 is running${account ? ` • ${account.name}` : ''}`;
    return;
  }

  button.disabled = launching || !account;
  icon.textContent = launching ? '…' : '▶';
  label.textContent = launching ? 'STARTING…' : 'PLAY';
  $('playSubtext').textContent = account
    ? (launching ? 'Preparing Minecraft 26.2…' : `Minecraft 26.2 • ${account.name}`)
    : 'Sign in with Microsoft first';
}

async function saveSettings(showStatus = true) {
  const next = collectSettings();
  if (!Number.isFinite(next.minRamGb) || !Number.isFinite(next.maxRamGb)) throw new Error('RAM values must be numbers.');
  if (next.maxRamGb < next.minRamGb) throw new Error('Maximum RAM must be at least the minimum RAM.');
  settings = await window.launcher.saveSettings(next);
  applyAppearanceSettings();
  syncScaleUi(settings.uiScale || 1);
  renderAllAccountUI();
  if (showStatus) showToast('Settings saved.');
}


async function startAddAccount() {
  try {
    $('accountDropdown').classList.add('hidden');
    $('authModal').classList.remove('hidden');
    $('authMessage').textContent = 'Starting Microsoft sign-in…';
    $('authCode').classList.add('hidden');
    $('openAuthLinkBtn').classList.add('hidden');
    await window.launcher.addAccount();
    settings = await window.launcher.getSettings();
    renderAllAccountUI();
    $('authModal').classList.add('hidden');
    showToast(`Signed in as ${selectedAccount()?.name || 'Microsoft account'}.`);
  } catch (error) {
    $('authMessage').textContent = error.message;
  }
}

function installedProjectIds() {
  return new Set(installedMods.filter((m) => m.projectId).map((m) => m.projectId));
}

async function refreshModStatuses(projectIds) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  if (!ids.length) return;
  try {
    const latest = await window.launcher.getModStatuses(ids);
    modStatuses = { ...modStatuses, ...(latest || {}) };
  } catch (error) {
    console.warn('Could not check Modrinth update status:', error);
  }
}

function updateButtonForInstalledMod(mod) {
  if (!mod.projectId) return '';
  const status = modStatuses[mod.projectId];
  if (status && !status.error && status.installed && !status.updateAvailable) {
    return `<button class="update-mod-btn is-installed" disabled>Installed</button>`;
  }
  const label = status?.updateAvailable ? 'Update' : 'Update';
  return `<button class="update-mod-btn" data-project-id="${escapeHtml(mod.projectId)}" data-title="${escapeHtml(mod.title)}">${label}</button>`;
}

function renderInstalledMods() {
  const host = $('installedMods');
  $('installedCount').textContent = `${installedMods.length} mod${installedMods.length === 1 ? '' : 's'}`;
  if (!installedMods.length) {
    host.innerHTML = `<div class="empty-state"><div><b>No mods installed yet</b><span>Core client files will appear after “Check files” or your first launch.</span></div></div>`;
    return;
  }

  host.innerHTML = installedMods.map((mod) => {
    const icon = mod.iconUrl
      ? `<img class="mod-icon" src="${escapeHtml(mod.iconUrl)}" alt="" />`
      : `<div class="mod-icon">${escapeHtml((mod.title || mod.filename).slice(0, 1).toUpperCase())}</div>`;
    const tags = `${mod.core ? '<span class="core-pill">CORE</span>' : ''}${mod.dependency ? '<span class="dep-pill">DEPENDENCY</span>' : ''}`;
    const detail = [mod.versionNumber, formatBytes(mod.size), mod.filename].filter(Boolean).join(' • ');
    let actions = '<span class="core-pill">REQUIRED</span>';
    if (!mod.core) {
      const update = updateButtonForInstalledMod(mod);
      actions = `<div class="installed-mod-actions">${update}<button class="remove-mod-btn" data-filename="${escapeHtml(mod.filename)}">Remove</button></div>`;
    }
    return `
      <div class="installed-mod">
        ${icon}
        <div class="installed-mod-copy"><b>${escapeHtml(mod.title)}${tags}</b><small>${escapeHtml(detail)}</small></div>
        ${actions}
      </div>`;
  }).join('');

  host.querySelectorAll('.update-mod-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const projectId = button.dataset.projectId;
      const title = button.dataset.title || 'mod';
      button.disabled = true;
      button.textContent = 'Updating…';
      $('modManagerStatus').textContent = `Updating ${title} and all required dependencies…`;
      try {
        const result = await window.launcher.installMod(projectId);
        installedMods = result.mods || await window.launcher.listMods();
        await refreshModStatuses(installedMods.filter((mod) => mod.projectId).map((mod) => mod.projectId));
        renderInstalledMods();
        renderSearchResults();
        const label = result.action === 'verified' ? 'already up to date' : 'updated';
        $('modManagerStatus').textContent = `${result.installed?.title || title} ${label}; required dependencies checked.`;
        showToast(`${result.installed?.title || title} ${label}.`);
      } catch (error) {
        $('modManagerStatus').textContent = `Update failed: ${error.message}`;
        renderInstalledMods();
      }
    });
  });

  host.querySelectorAll('.remove-mod-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${button.dataset.filename}?`)) return;
      button.disabled = true;
      try {
        installedMods = await window.launcher.removeMod(button.dataset.filename);
        renderInstalledMods();
        renderSearchResults();
        $('modManagerStatus').textContent = 'Mod removed.';
      } catch (error) {
        $('modManagerStatus').textContent = error.message;
        button.disabled = false;
      }
    });
  });
}

async function refreshInstalledMods() {
  try {
    installedMods = await window.launcher.listMods();
    await refreshModStatuses(installedMods.filter((mod) => mod.projectId && !mod.core).map((mod) => mod.projectId));
    renderInstalledMods();
    renderSearchResults();
  } catch (error) {
    $('installedMods').innerHTML = `<div class="empty-state"><div><b>Could not read the mods folder</b><span>${escapeHtml(error.message)}</span></div></div>`;
  }
}

function buildPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 2, current - 1, current, current + 1, current + 2]);
  return [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
}

function renderModPagination() {
  const host = $('modPagination');
  if (!host) return;
  if (modSearchTotalPages <= 1 || !modSearchTotal) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const pages = buildPageNumbers(modSearchPage, modSearchTotalPages);
  let previousPage = 0;
  const pageButtons = pages.map((page) => {
    const gap = previousPage && page - previousPage > 1 ? '<span class="page-gap">…</span>' : '';
    previousPage = page;
    return `${gap}<button class="mod-page-number${page === modSearchPage ? ' active' : ''}" data-page="${page}" ${page === modSearchPage ? 'disabled' : ''}>${page}</button>`;
  }).join('');

  host.innerHTML = `
    <button class="mod-page-nav" data-page="${modSearchPage - 1}" ${modSearchPage <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <div class="mod-page-numbers">${pageButtons}</div>
    <span class="mod-page-summary">Page ${modSearchPage} of ${modSearchTotalPages}</span>
    <button class="mod-page-nav" data-page="${modSearchPage + 1}" ${modSearchPage >= modSearchTotalPages ? 'disabled' : ''}>Next ›</button>`;
  host.classList.remove('hidden');

  host.querySelectorAll('button[data-page]:not(:disabled)').forEach((button) => {
    button.addEventListener('click', () => searchMods(modSearchQuery, Number(button.dataset.page) || 1, false));
  });
}

function renderSearchResults() {
  const host = $('modSearchResults');
  if (!lastSearchResults.length) {
    host.innerHTML = `<div class="empty-state compact-empty"><div><b>No results on this page</b><span>Try another search or page.</span></div></div>`;
    renderModPagination();
    return;
  }

  const installed = installedProjectIds();
  const hasFabricApi = installedMods.some((mod) => mod.filename.toLowerCase().startsWith('fabric-api-'));

  host.innerHTML = lastSearchResults.map((mod) => {
    const isInstalled = installed.has(mod.projectId) || (mod.slug === 'fabric-api' && hasFabricApi);
    const status = modStatuses[mod.projectId];
    const updateAvailable = Boolean(isInstalled && status?.updateAvailable);
    const installedCurrent = Boolean(isInstalled && status?.installedVersionId && status?.latestVersionId && status.installedVersionId === status.latestVersionId);
    const actionLabel = installedCurrent ? 'Installed' : isInstalled ? 'Update' : 'Install';
    const actionClass = installedCurrent ? ' is-installed' : isInstalled ? ' is-update' : '';
    const icon = mod.iconUrl
      ? `<img class="mod-icon" src="${escapeHtml(mod.iconUrl)}" alt="" />`
      : `<div class="mod-icon">${escapeHtml(mod.title.slice(0, 1).toUpperCase())}</div>`;
    return `
      <article class="mod-card">
        ${icon}
        <div class="mod-card-main">
          <div class="mod-card-title-line"><h4>${escapeHtml(mod.title)}</h4><span class="mod-card-author">by ${escapeHtml(mod.author)}</span></div>
          <p>${escapeHtml(mod.description)}</p>
          <div class="mod-card-foot">
            <span class="downloads">↓ ${formatDownloads(mod.downloads)} downloads</span>
            <div class="mod-actions">
              <button class="mod-page-btn" data-slug="${escapeHtml(mod.slug)}">Page</button>
              <button class="install-mod-btn${actionClass}" data-project-id="${escapeHtml(mod.projectId)}" data-installed="${isInstalled ? 'true' : 'false'}" ${installedCurrent ? 'disabled' : ''}>${actionLabel}</button>
            </div>
          </div>
        </div>
      </article>`;
  }).join('');

  host.querySelectorAll('.mod-page-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const slug = encodeURIComponent(button.dataset.slug || '');
      if (slug) window.launcher.openExternal(`https://modrinth.com/mod/${slug}`);
    });
  });

  host.querySelectorAll('.install-mod-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const projectId = button.dataset.projectId;
      const mod = lastSearchResults.find((item) => item.projectId === projectId);
      const wasInstalled = button.dataset.installed === 'true';
      button.disabled = true;
      button.textContent = wasInstalled ? 'Updating…' : 'Installing…';
      $('modManagerStatus').textContent = `${wasInstalled ? 'Updating' : 'Installing'} ${mod?.title || 'mod'} and all required dependencies…`;
      try {
        const result = await window.launcher.installMod(projectId);
        installedMods = result.mods || await window.launcher.listMods();
        await refreshModStatuses(installedMods.filter((item) => item.projectId).map((item) => item.projectId));
        renderInstalledMods();
        renderSearchResults();
        const verb = result.action === 'updated' ? 'updated' : result.action === 'verified' ? 'already up to date' : 'installed';
        $('modManagerStatus').textContent = `${result.installed?.title || mod?.title || 'Mod'} ${verb}; required dependencies checked.`;
        showToast(`${result.installed?.title || mod?.title || 'Mod'} ${verb}.`);
      } catch (error) {
        $('modManagerStatus').textContent = `${wasInstalled ? 'Update' : 'Install'} failed: ${error.message}`;
        renderSearchResults();
      }
    });
  });

  renderModPagination();
}

async function searchMods(query = $('modSearchInput').value, page = 1, resetOnQueryChange = true) {
  const q = String(query || '').trim();
  const queryChanged = q !== modSearchQuery;
  if (resetOnQueryChange && queryChanged) page = 1;
  modSearchQuery = q;
  modSearchPage = Math.max(1, Number.parseInt(page, 10) || 1);

  $('modSearchBtn').disabled = true;
  $('modManagerStatus').textContent = q
    ? `Searching Modrinth for “${q}” — page ${modSearchPage}…`
    : `Loading popular Fabric 26.2 mods — page ${modSearchPage}…`;
  $('modSearchResults').innerHTML = `<div class="empty-state compact-empty"><div><b>Loading Modrinth…</b><span>Filtering for Fabric + Minecraft 26.2.</span></div></div>`;
  $('modPagination').classList.add('hidden');
  try {
    const result = await window.launcher.searchMods(q, modSearchPage);
    lastSearchResults = Array.isArray(result) ? result : (result?.items || []);
    modSearchTotal = Array.isArray(result) ? lastSearchResults.length : Number(result?.total || 0);
    modSearchTotalPages = Array.isArray(result) ? 1 : Math.max(1, Number(result?.totalPages || 1));
    modSearchPageSize = Array.isArray(result) ? Math.max(1, lastSearchResults.length) : Math.max(1, Number(result?.pageSize || 24));
    modSearchPage = Array.isArray(result) ? 1 : Math.max(1, Number(result?.page || modSearchPage));
    await refreshModStatuses(lastSearchResults.map((mod) => mod.projectId));
    renderSearchResults();
    const startIndex = modSearchTotal ? ((modSearchPage - 1) * modSearchPageSize) + 1 : 0;
    const endIndex = Math.min(modSearchTotal, startIndex + lastSearchResults.length - 1);
    $('modManagerStatus').textContent = modSearchTotal
      ? `Showing ${startIndex}–${endIndex} of ${modSearchTotal} compatible mods.`
      : 'No compatible mods found.';
  } catch (error) {
    lastSearchResults = [];
    modSearchTotal = 0;
    modSearchTotalPages = 1;
    $('modSearchResults').innerHTML = `<div class="empty-state compact-empty"><div><b>Modrinth search failed</b><span>${escapeHtml(error.message)}</span></div></div>`;
    $('modPagination').classList.add('hidden');
    $('modManagerStatus').textContent = error.message;
  } finally {
    $('modSearchBtn').disabled = false;
  }
}


// Global subtle UI feedback. Hover is throttled so moving across a dense mod list
// never becomes noisy. More important actions get distinct cues.
document.addEventListener('mouseover', (event) => {
  const target = event.target.closest('button, .account-switcher, .rail-btn');
  if (!target || target.disabled || target.contains(event.relatedTarget)) return;
  const now = performance.now();
  if (now - lastHoverSoundAt < 75) return;
  lastHoverSoundAt = now;
  playUiSound('hover');
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, .account-switcher');
  if (!target || target.disabled) return;
  if (target.id === 'playBtn') {
    playUiSound(gameRunning ? 'stop' : 'play');
    return;
  }
  if (target.matches('[data-theme-option]')) return; // dedicated theme cue above
  if (target.matches('.install-mod-btn, .update-mod-btn')) {
    playUiSound('install');
    return;
  }
  if (target.matches('.remove-mod-btn')) {
    playUiSound('stop');
    return;
  }
  playUiSound('click');
});

// Top account switcher
$('accountSwitcher').addEventListener('click', (event) => {
  event.stopPropagation();
  renderAccountDropdown();
  $('accountDropdown').classList.toggle('hidden');
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.account-switch-wrap')) $('accountDropdown').classList.add('hidden');
});

// Window controls
$('minimizeBtn').addEventListener('click', () => window.launcher.windowControl('minimize'));
$('maximizeBtn').addEventListener('click', () => window.launcher.windowControl('maximize'));
$('closeBtn').addEventListener('click', () => window.launcher.windowControl('close'));
window.launcher.onWindowMaximized((maximized) => { $('maximizeBtn').textContent = maximized ? '❐' : '□'; });
window.launcher.onUiScale((data) => {
  if (!settings) return;
  const preferred = Number(data.preferredScale ?? data.scale) || 1;
  settings.uiScale = preferred;
  syncScaleUi(preferred);

  if (data.autoFitted) {
    showToast(`Auto-fit: ${data.percent}% (preferred ${data.preferredPercent}%)`, 1300);
  } else {
    showToast(`Launcher scale: ${data.percent}%`, 1100);
  }
});

// Home
$('versionBtn').addEventListener('click', () => showToast('SpectorClient is currently locked to Minecraft 26.2 + Fabric.'));
$('playBtn').addEventListener('click', async () => {
  if (gameRunning) {
    try {
      stoppingGame = true;
      updatePlayState();
      $('status').textContent = 'Stopping SpectorClient…';
      await window.launcher.stopGame();
    } catch (error) {
      stoppingGame = false;
      $('status').textContent = `Stop failed: ${error.message}`;
      updatePlayState();
    }
    return;
  }

  try {
    await saveSettings(false);
    launching = true;
    updatePlayState();
    $('status').textContent = 'Preparing SpectorClient…';
    await window.launcher.launchGame(collectSettings());
  } catch (error) {
    $('status').textContent = `Launch failed: ${error.message}`;
    launching = false;
    gameRunning = false;
    stoppingGame = false;
    updatePlayState();
  }
});

// Accounts
$('addAccountBtn').addEventListener('click', startAddAccount);
$('closeAuthModalBtn').addEventListener('click', () => $('authModal').classList.add('hidden'));
$('openAuthLinkBtn').addEventListener('click', () => currentAuthUrl && window.launcher.openExternal(currentAuthUrl));

// Mods
$('openModsFolderBtn').addEventListener('click', () => window.launcher.openModsFolder());
$('refreshModsBtn').addEventListener('click', refreshInstalledMods);
$('modSearchBtn').addEventListener('click', () => searchMods($('modSearchInput').value, 1));
$('modSearchInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchMods($('modSearchInput').value, 1);
});

// Settings / misc
$('saveSettingsBtn').addEventListener('click', async () => {
  try { await saveSettings(); }
  catch (error) { showToast(error.message); }
});
document.querySelectorAll('[data-theme-option]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!settings) return;
    const theme = normalizeTheme(button.dataset.themeOption);
    settings.theme = theme;
    applyAppearanceSettings();
    playUiSound('theme');
    try {
      // Theme selection is immediate and persistent so detached windows never
      // lag behind the main launcher preview.
      settings = await window.launcher.setTheme(theme);
      applyAppearanceSettings();
    } catch (error) {
      showToast(`Could not save theme: ${error.message}`);
    }
  });
});

$('animationsEnabled').addEventListener('change', () => {
  settings.animationsEnabled = $('animationsEnabled').checked;
  applyAppearanceSettings();
});

$('soundsEnabled').addEventListener('change', () => {
  settings.soundsEnabled = $('soundsEnabled').checked;
  syncSoundUi();
  if (settings.soundsEnabled) playUiSound('success');
});
$('soundVolume').addEventListener('input', () => {
  settings.soundVolume = Number($('soundVolume').value);
  $('soundVolumeValue').textContent = `${$('soundVolume').value}%`;
});
$('soundVolume').addEventListener('change', () => playUiSound('click'));
$('uiScale').addEventListener('input', () => {
  $('uiScaleValue').textContent = `${$('uiScale').value}%`;
});
$('chooseJavaBtn').addEventListener('click', async () => {
  const selected = await window.launcher.chooseJava();
  if (selected) $('javaPath').value = selected;
});
$('openClientFolderBtn').addEventListener('click', () => window.launcher.openClientFolder());
$('openFolderRailBtn').addEventListener('click', () => window.launcher.openClientFolder());
$('clearLogsBtn').addEventListener('click', async () => { await window.launcher.clearLogs(); });
$('newsHomeBtn').addEventListener('click', () => showView('home'));

window.launcher.onAuthCode((data) => {
  currentAuthUrl = data.directVerificationUri || data.verificationUri;
  $('authModal').classList.remove('hidden');
  $('authMessage').textContent = data.message || 'Microsoft sign-in opened in your browser. Sign in and continue.';
  if (data.userCode) {
    $('authCode').textContent = data.userCode;
    $('authCode').classList.remove('hidden');
  }
  $('openAuthLinkBtn').textContent = 'Open Microsoft sign-in';
  $('openAuthLinkBtn').classList.remove('hidden');
});

window.launcher.onAuthState((data) => {
  if (data.state === 'complete') {
    $('authMessage').textContent = `Signed in as ${data.account.name}.`;
    playUiSound('success');
  }
  if (data.state === 'error') {
    $('authMessage').textContent = data.message;
    playUiSound('error');
  }
});

window.launcher.onInstallState((data) => {
  // File preparation is intentionally silent on the Home screen.
  // Game state below still surfaces launch failures and running status.
  if (data?.step === 'Error' && $('status')) {
    $('status').textContent = data.message || 'Client setup failed.';
    playUiSound('error');
  }
});

window.launcher.onModInstallState((data) => {
  $('modManagerStatus').textContent = data.text || data.state || 'Installing mod…';
});

window.launcher.onGameState((data) => {
  $('status').textContent = data.text || data.state;

  if (data.state !== lastGameSoundState) {
    if (data.state === 'running') playUiSound('success');
    if (data.state === 'error') playUiSound('error');
    if (data.state === 'stopped' && lastGameSoundState === 'stopping') playUiSound('click');
    lastGameSoundState = data.state;
  }

  if (data.state === 'running') {
    launching = false;
    stoppingGame = false;
    gameRunning = true;
    updatePlayState();
    return;
  }

  if (data.state === 'stopping') {
    launching = false;
    stoppingGame = true;
    gameRunning = true;
    updatePlayState();
    return;
  }

  if (['stopped', 'error'].includes(data.state)) {
    launching = false;
    stoppingGame = false;
    gameRunning = false;
    updatePlayState();
    return;
  }

  if (['installing', 'authenticating', 'launching'].includes(data.state)) {
    launching = true;
    stoppingGame = false;
    gameRunning = false;
    updatePlayState();
  }
});

window.launcher.onUpdateState((data) => {
  if (!data?.state) return;
  if (data.state === 'available') showToast(data.text || 'A SpectorClient update is available and downloading.', 3600);
  if (data.state === 'waiting-for-game') {
    showToast(data.text || 'Update ready. It will install automatically when Minecraft closes.', 6000);
  }
  if (data.state === 'downloaded') {
    playUiSound('success');
    showToast(data.text || 'Launcher update downloaded. Installing now…', 4200);
  }
  if (data.state === 'installing-update') {
    playUiSound('success');
    showToast(data.text || 'Installing SpectorClient update now…', 4200);
  }
  if (data.state === 'retrying') showToast(data.text || 'Update check will retry automatically.', 3600);
  if (data.state === 'error') {
    playUiSound('error');
    showToast(data.text || 'Could not check for launcher updates. Retrying automatically.', 4200);
  }
});

window.launcher.onGameLog((data) => {
  const output = $('logOutput');
  if (output.textContent === 'No logs yet.') output.textContent = '';
  output.textContent += `[${data.type}] ${data.line}\n`;
  output.scrollTop = output.scrollHeight;
});
window.launcher.onLogsCleared(() => {
  $('logOutput').textContent = 'No logs yet.';
});

(async function init() {
  try {
    const [loadedSettings, loadedClientInfo, gameStatus, logHistory] = await Promise.all([
      window.launcher.getSettings(),
      window.launcher.getClientInfo(),
      window.launcher.getGameStatus(),
      window.launcher.getLogHistory()
    ]);
    settings = loadedSettings;
    clientInfo = loadedClientInfo;
    gameRunning = Boolean(gameStatus?.running);
    stoppingGame = false;
    fillSettings();
    renderAllAccountUI();
    if (Array.isArray(logHistory) && logHistory.length) {
      $('logOutput').textContent = logHistory.map((entry) => `[${entry.type || 'launcher'}] ${entry.line || ''}`).join('\n') + '\n';
    }
    await refreshInstalledMods();
  } catch (error) {
    $('status').textContent = `Startup error: ${error.message}`;
  }
})();
