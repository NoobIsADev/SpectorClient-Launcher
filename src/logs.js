const VALID_THEMES = new Set(['classic', 'classic-pink', 'crimson', 'prince']);

function applyLogTheme(theme) {
  document.documentElement.dataset.theme = VALID_THEMES.has(theme) ? theme : 'classic';
}

const output = document.getElementById('logOutput');
const autoScroll = document.getElementById('autoScroll');
const clearBtn = document.getElementById('clearBtn');

function append(entry) {
  if (output.textContent === 'No logs yet.') output.textContent = '';
  output.textContent += `[${entry.type || 'launcher'}] ${entry.line || ''}\n`;
  if (autoScroll.checked) output.scrollTop = output.scrollHeight;
}

window.launcher.onGameLog(append);
window.launcher.onLogsCleared(() => { output.textContent = 'No logs yet.'; });

clearBtn.addEventListener('click', () => window.launcher.clearLogs());
window.launcher.onThemeChanged((theme) => applyLogTheme(theme));

(async () => {
  try {
    const settings = await window.launcher.getSettings();
    const theme = VALID_THEMES.has(settings?.theme) ? settings.theme : 'classic';
    applyLogTheme(theme);

    const history = await window.launcher.getLogHistory();
    if (Array.isArray(history) && history.length) {
      output.textContent = '';
      history.forEach(append);
    }
  } catch (error) {
    output.textContent = `Could not load logs: ${error.message}`;
  }
})();
