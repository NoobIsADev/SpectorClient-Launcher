const VALID_THEMES = new Set(['classic', 'classic-pink', 'crimson', 'prince']);

function applyLogTheme(theme) {
  document.documentElement.dataset.theme = VALID_THEMES.has(theme) ? theme : 'classic';
}

const output = document.getElementById('logOutput');
const autoScroll = document.getElementById('autoScroll');
const clearBtn = document.getElementById('clearBtn');
const searchInput = document.getElementById('logSearch');
const totalCount = document.getElementById('totalCount');
const visibleCount = document.getElementById('visibleCount');
const warningCount = document.getElementById('warningCount');
const errorCount = document.getElementById('errorCount');
const streamState = document.getElementById('streamState');

let entries = [];
let sourceFilter = 'all';
let levelFilter = 'all';
let searchQuery = '';

function inferLevel(entry) {
  if (entry?.level) return String(entry.level).toLowerCase();
  const line = String(entry?.line || '').toLowerCase();
  if (/\b(error|failed|failure|exception|fatal|crash|unable to|could not)\b/.test(line)) return 'error';
  if (/\b(warn|warning|retry|deprecated|waiting for|fallback)\b/.test(line)) return 'warn';
  if (String(entry?.type || '').toLowerCase() === 'debug') return 'debug';
  return 'info';
}

function normalizeEntry(entry, index = 0) {
  const at = Number(entry?.at || Date.now());
  return {
    id: String(entry?.id || `${at}-${index}`),
    type: String(entry?.type || 'launcher').toLowerCase(),
    level: inferLevel(entry),
    line: String(entry?.line || ''),
    at,
    iso: String(entry?.iso || new Date(at).toISOString())
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function timeParts(timestamp) {
  const d = new Date(Number(timestamp || Date.now()));
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
}

function levelLabel(level) {
  if (level === 'warn') return 'WARN';
  if (level === 'error') return 'ERROR';
  if (level === 'debug') return 'DEBUG';
  return 'INFO';
}

function sourceLabel(type) {
  const map = { launcher: 'LAUNCHER', game: 'GAME', updater: 'UPDATER', debug: 'DEBUG' };
  return map[type] || String(type || 'launcher').toUpperCase();
}

function matches(entry) {
  if (sourceFilter !== 'all' && entry.type !== sourceFilter) return false;
  if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
  if (searchQuery && !entry.line.toLowerCase().includes(searchQuery)) return false;
  return true;
}

function renderSummary(visible) {
  totalCount.textContent = String(entries.length);
  visibleCount.textContent = String(visible.length);
  warningCount.textContent = String(entries.filter((entry) => entry.level === 'warn').length);
  errorCount.textContent = String(entries.filter((entry) => entry.level === 'error').length);
  streamState.textContent = 'Live';
}

function entryHtml(entry) {
  return `<article class="log-row level-${escapeHtml(entry.level)}" data-log-id="${escapeHtml(entry.id)}">
    <div class="log-meta">
      <time title="${escapeHtml(entry.iso)}">${escapeHtml(timeParts(entry.at))}</time>
      <span class="log-source source-${escapeHtml(entry.type)}">${escapeHtml(sourceLabel(entry.type))}</span>
      <span class="log-level level-${escapeHtml(entry.level)}">${escapeHtml(levelLabel(entry.level))}</span>
    </div>
    <div class="log-message">${escapeHtml(entry.line)}</div>
  </article>`;
}

function render({ preserveBottom = true } = {}) {
  const wasNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
  const visible = entries.filter(matches);
  renderSummary(visible);

  if (!visible.length) {
    output.innerHTML = `<div class="log-empty">${entries.length ? 'No logs match the current filters.' : 'No logs yet.'}</div>`;
  } else {
    output.innerHTML = visible.map(entryHtml).join('');
  }

  if (autoScroll.checked && (preserveBottom || wasNearBottom)) output.scrollTop = output.scrollHeight;
}

function updateSummaryOnly() {
  const visible = entries.filter(matches);
  renderSummary(visible);
  return visible;
}

function append(entry) {
  const normalized = normalizeEntry(entry, entries.length);
  entries.push(normalized);
  if (entries.length > 2500) {
    entries = entries.slice(-2500);
    render();
    return;
  }

  const visible = updateSummaryOnly();
  if (!matches(normalized)) {
    if (!visible.length) output.innerHTML = '<div class="log-empty">No logs match the current filters.</div>';
    return;
  }

  const empty = output.querySelector('.log-empty');
  if (empty) empty.remove();
  output.insertAdjacentHTML('beforeend', entryHtml(normalized));
  if (autoScroll.checked) output.scrollTop = output.scrollHeight;
}

window.launcher.onGameLog(append);
window.launcher.onLogsCleared(() => {
  entries = [];
  render();
});

clearBtn.addEventListener('click', () => window.launcher.clearLogs());
window.launcher.onThemeChanged((theme) => applyLogTheme(theme));

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  render({ preserveBottom: false });
});

document.querySelectorAll('[data-source]').forEach((button) => {
  button.addEventListener('click', () => {
    sourceFilter = button.dataset.source || 'all';
    document.querySelectorAll('[data-source]').forEach((item) => item.classList.toggle('active', item === button));
    render({ preserveBottom: false });
  });
});

document.querySelectorAll('[data-level]').forEach((button) => {
  button.addEventListener('click', () => {
    levelFilter = button.dataset.level || 'all';
    document.querySelectorAll('[data-level]').forEach((item) => item.classList.toggle('active', item === button));
    render({ preserveBottom: false });
  });
});

autoScroll.addEventListener('change', () => {
  if (autoScroll.checked) output.scrollTop = output.scrollHeight;
});

(async () => {
  try {
    const settings = await window.launcher.getSettings();
    const theme = VALID_THEMES.has(settings?.theme) ? settings.theme : 'classic';
    applyLogTheme(theme);

    const history = await window.launcher.getLogHistory();
    entries = Array.isArray(history) ? history.map(normalizeEntry) : [];
    render();
  } catch (error) {
    output.innerHTML = `<div class="log-empty log-error">Could not load logs: ${escapeHtml(error.message)}</div>`;
  }
})();
