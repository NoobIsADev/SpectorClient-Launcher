'use strict';
// Source and mocked-renderer regression tests for v1.6.58 Logs redesign.
// Node-only: no Electron runtime, network, or third-party dependencies needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8');
const html = read('src/logs.html');
const css = read('src/logs.css');
const logs = read('src/logs.js');
const main = read('src/main.js');
const inApp = read('src/index.html');
const pkg = JSON.parse(read('package.json'));
assert.ok(Number(pkg.version.split('.').at(-1)) >= 58, 'v1.6.58 Logs redesign must be retained in future versions');
assert.equal(pkg.main, 'src/main.js');
assert.match(pkg.scripts.start, /^electron\s/);
assert.ok(!/tauri/i.test(JSON.stringify(pkg.scripts)));
assert.ok(pkg.scripts['verify:ui'].includes('verify-v1658.js'));

for (const id of [
  'autoScroll', 'clearBtn', 'logSearch', 'logOutput', 'totalCount', 'visibleCount',
  'warningCount', 'errorCount', 'streamState'
]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `Expected exactly one #${id}`);
}
for (const source of ['all', 'launcher', 'game', 'updater', 'debug']) {
  assert.ok(html.includes(`data-source="${source}"`));
}
for (const level of ['all', 'info', 'warn', 'error', 'debug']) {
  assert.ok(html.includes(`data-level="${level}"`));
}
for (const theme of ['classic', 'classic-pink', 'crimson', 'prince']) {
  if (theme !== 'classic') assert.ok(css.includes(`data-theme="${theme}"`));
}
assert.ok(!html.includes('assets/spector-logo.png'), 'Corner logo removed to match redesigned header');
assert.ok(html.includes('Console output') && html.includes('brand-wordmark'));
assert.ok(css.includes('.log-row') && css.includes('@media (max-width: 760px)'));
assert.ok(css.includes('--accent: #98ddff'));
assert.ok(inApp.includes('refinements-v1658.css') && inApp.includes('embedded-log-card'));
assert.ok(main.includes("logWindow.loadFile(path.join(__dirname, 'logs.html'))"), 'Detached window still uses redesigned page');
assert.ok(main.includes("logWindow.on('close', (event) => {"), 'Hide-during-launch safeguard must remain');
assert.ok(main.includes('logWindow.hide();'));
for (const token of ['window.launcher.onGameLog(append)', 'window.launcher.onLogsCleared(', 'window.launcher.clearLogs()', 'window.launcher.onThemeChanged(', 'window.launcher.getLogHistory()', 'window.launcher.getSettings()']) {
  assert.ok(logs.includes(token), `Log integration must remain: ${token}`);
}

class FakeClassList {
  constructor() { this.classes = new Set(); }
  toggle(name, state) { if (state) this.classes.add(name); else this.classes.delete(name); }
}
class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 80;
  }
  addEventListener(type, cb) { this.listeners[type] = cb; }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { this.listeners.click(); }
  change() { this.listeners.change(); }
  input() { this.listeners.input(); }
  querySelector(selector) {
    if (selector === '.log-empty' && this.innerHTML.includes('class="log-empty"')) {
      return { remove: () => { this.innerHTML = this.innerHTML.replace(/<div class="log-empty">[\s\S]*?<\/div>/, ''); } };
    }
    return null;
  }
  insertAdjacentHTML(_, content) { this.innerHTML += content; }
}

async function test() {
  const ids = new Map();
  const element = (id) => { if (!ids.has(id)) ids.set(id, new FakeElement(id)); return ids.get(id); };
  const sources = ['all', 'launcher', 'game', 'updater', 'debug'].map(value => {
    const e = new FakeElement(`source-${value}`); e.dataset.source = value; return e;
  });
  const levels = ['all', 'info', 'warn', 'error', 'debug'].map(value => {
    const e = new FakeElement(`level-${value}`); e.dataset.level = value; return e;
  });
  element('autoScroll').checked = true;
  const callbacks = {};
  const launcher = {
    onGameLog: (cb) => { callbacks.append = cb; },
    onLogsCleared: (cb) => { callbacks.clear = cb; },
    onThemeChanged: (cb) => { callbacks.theme = cb; },
    clearLogs: () => { callbacks.clear(); return Promise.resolve(); },
    getSettings: () => Promise.resolve({ theme: 'classic' }),
    getLogHistory: () => Promise.resolve([
      { id: 'one', type: 'launcher', level: 'info', line: 'Starting Minecraft 26.3', at: 10000 },
      { id: 'two', type: 'game', level: 'error', line: 'Connection failed', at: 15000 }
    ])
  };
  const ctx = vm.createContext({
    console, Date, String, Set, Number, Array,
    document: {
      documentElement: { dataset: {} },
      getElementById: element,
      querySelectorAll: (selector) => selector === '[data-source]' ? sources : selector === '[data-level]' ? levels : []
    },
    window: { launcher }
  });
  vm.runInContext(logs, ctx, { filename: 'logs.js' });
  await new Promise(setImmediate);
  assert.equal(element('totalCount').textContent, '2');
  assert.equal(element('visibleCount').textContent, '2');
  assert.equal(element('errorCount').textContent, '1');
  assert.equal(ctx.document.documentElement.dataset.theme, 'classic');
  levels[3].click();
  assert.equal(element('visibleCount').textContent, '1');
  assert.equal(levels[3].attributes['aria-pressed'], 'true');
  assert.equal(levels[0].attributes['aria-pressed'], 'false');
  sources[1].click();
  assert.equal(element('visibleCount').textContent, '0');
  sources[0].click();
  element('logSearch').value = 'connection';
  element('logSearch').input();
  assert.equal(element('visibleCount').textContent, '1');
  element('logSearch').value = '';
  element('logSearch').input();
  callbacks.theme('prince');
  assert.equal(ctx.document.documentElement.dataset.theme, 'prince');
  callbacks.theme('unexpected');
  assert.equal(ctx.document.documentElement.dataset.theme, 'classic');
  levels[0].click(); // Reset the severity filter before testing injected output.
  callbacks.append({ id: 'new', type: 'game', line: '<script>alert("not executed")</script>', at: 20000 });
  assert.equal(element('totalCount').textContent, '3');
  assert.ok(element('logOutput').innerHTML.includes('&lt;script&gt;'), 'Log lines remain HTML-escaped');
  element('clearBtn').click();
  assert.equal(element('totalCount').textContent, '0');
  assert.equal(element('errorCount').textContent, '0');
  assert.ok(element('logOutput').innerHTML.includes('No logs yet.'));
  console.log('[v1.6.58] PASS: Log UI hooks, theme updates, filter/clear/autoscroll controls, output escaping, platform and launch safeguards');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
