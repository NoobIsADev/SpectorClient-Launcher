// Focused regression tests for the Logs launch lifecycle and Built-In mod labels.
// Run with: node scripts/verify-v1643.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const base = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(base, 'src', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(base, 'src', 'renderer.js'), 'utf8');
const pkg = require(path.join(base, 'package.json'));
assert.equal(pkg.version, '1.6.43');
function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing ${start}`);
  return source.slice(first, last);
}
class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.hidden = false;
    this.destroyed = false;
    this.webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => {},
      isDestroyed: () => this.destroyed,
      send: () => {}
    });
  }
  loadFile() {}
  isDestroyed() { return this.destroyed; }
  setBackgroundColor() {}
  show() { this.hidden = false; }
  hide() { this.hidden = true; }
  focus() {}
  close() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', event);
    if (!event.defaultPrevented) { this.destroyed = true; this.emit('closed'); }
  }
}
const ctx = vm.createContext({
  logWindow: null,
  gameLaunchInProgress: true,
  updateInstallStarting: false,
  BrowserWindow: FakeWindow,
  fs: { existsSync: () => false },
  path,
  __dirname: path.join(base, 'src'),
  BRAND_IMAGE_PATH: path.join(base, 'src', 'assets', 'spector-logo.png'),
  logWindowBackground: () => '#031018',
  normalizeLauncherTheme: (v) => v,
  pushThemeToLogWindow: () => {},
  shell: { openExternal: () => {} },
  console
});
vm.runInContext(between(main, 'function createLogWindow(', 'function makeIpcSafe('), ctx);
const logs = vm.runInContext("createLogWindow('classic')", ctx);
logs.close();
assert.equal(logs.hidden, true, 'Closing logs during launch must hide them');
assert.equal(logs.destroyed, false, 'Closing logs during launch must not destroy webContents');
assert.equal(vm.runInContext('logWindow === null', ctx), false);
vm.runInContext("createLogWindow('classic')", ctx);
assert.equal(logs.hidden, false, 'Logs should reopen with launch in progress');
vm.runInContext('gameLaunchInProgress = false', ctx);
logs.close();
assert.equal(logs.destroyed, true, 'Logs can close normally after launch');
assert.equal(vm.runInContext('logWindow === null', ctx), true);
// Closing the log window must not bubble logging exceptions into Java installation.
const delivered = [];
Object.assign(ctx, {
  logWindow: {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: () => { throw Error('renderer closed'); } }
  },
  send: (...args) => delivered.push(args)
});
vm.runInContext(between(main, 'function sendLogPayload(', 'function classifyLogLevel('), ctx);
assert.doesNotThrow(() => vm.runInContext("sendLogPayload({ line: 'still launching' })", ctx));
assert.equal(delivered.length, 1);
assert(main.includes('if (gameLaunchInProgress) return; // Never terminate during Minecraft preparation.'));
assert(main.includes('mainWindow.hide();\n      return;'));
const modCtx = vm.createContext({
  activeContentType: 'mods', contentProvider: 'modrinth', installedMods: []
});
vm.runInContext(between(renderer, 'function isBuiltInContentItem(', 'function updateButtonForInstalledMod('), modCtx);
function isBuiltIn(item) { modCtx.item = item; return vm.runInContext('isBuiltInContentItem(item)', modCtx); }
assert.equal(isBuiltIn({ slug: 'fabric-api', source: 'modrinth' }), true);
assert.equal(isBuiltIn({ slug: 'fabric-api', source: 'curseforge' }), true);
assert.equal(isBuiltIn({ core: true, filename: 'spectorclient.jar' }), true);
assert.equal(isBuiltIn({ slug: 'some-normal-mod' }), false);
modCtx.installedMods = [{ core: true, filename: 'spectorclient.jar', projectId: 'spector-id', source: 'modrinth' }];
assert.equal(isBuiltIn({ projectId: 'spector-id', source: 'modrinth' }), true);
assert.equal(isBuiltIn({ projectId: 'other-id', source: 'modrinth' }), false);
modCtx.activeContentType = 'resourcepacks';
assert.equal(isBuiltIn({ slug: 'fabric-api', source: 'modrinth' }), false);
assert(renderer.includes("const actionLabel = builtIn ? 'Built-In'"));
assert(renderer.includes("${builtIn || installedCurrent ? 'disabled' : ''}"));
console.log('PASS: Logs window launch-safety and Built-In status regression checks.');
