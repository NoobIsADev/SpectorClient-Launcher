"use strict";
// Regression guard for the v1.6.57 Electron-only continuation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
assert.equal(pkg.version.split('.').slice(0, 2).join('.'), '1.6');
assert.ok(Number(pkg.version.split('.')[2]) >= 57, 'Electron-only baseline v1.6.57+ required');
assert.equal(pkg.main, 'src/main.js');
assert.match(pkg.scripts.start, /^electron\b/);
assert.equal(pkg.scripts['dist:linux'].includes('AppImage'), true);
assert.match(pkg.scripts['dist:win'], /electron-builder/);
assert.match(pkg.scripts['dist:mac'], /electron-builder/);
assert.ok(pkg.dependencies['minecraft-launcher-core']);
assert.ok(pkg.dependencies['prismarine-auth']);
assert.ok(pkg.dependencies['electron-updater']);
assert.ok(pkg.devDependencies.electron);
assert.ok(pkg.devDependencies['electron-builder']);
assert.equal(pkg.build.win.target.includes('nsis'), true);
assert.equal(pkg.build.linux.target.some(x => x.target === 'AppImage'), true);
assert.equal(pkg.build.mac.target.some(x => x.target === 'dmg' && x.arch.includes('universal')), true);
assert.equal(pkg.build.mac.target.some(x => x.target === 'zip' && x.arch.includes('universal')), true);
assert.equal(pkg.build.publish.provider, 'github');
const tauriArtifacts = [
  'src-tauri', 'src/tauri-entry.js', 'src/tauri-bridge.js',
  'vite.config.mjs', 'scripts/prepare-tauri.mjs',
  'scripts/build-tauri-release.mjs', 'scripts/configure-tauri-release.mjs',
  '.github/workflows/tauri-preview.yml', '.github/workflows/tauri-signed-release.yml',
  'MIGRATION-STATUS.md', 'MIGRATION-PRESERVATION.json', 'README-TAURI.md'
];
for (const artifact of tauriArtifacts) assert.equal(fs.existsSync(path.join(root, artifact)), false, `Tauri artifact must be absent: ${artifact}`);
assert.equal(Object.keys(pkg.scripts).some(x => /tauri/i.test(x)), false);
assert.equal([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)].some(x => /tauri/i.test(x)), false);
const main = read('src/main.js');
for (const required of [
  "require('electron')", "require('prismarine-auth')", "require('minecraft-launcher-core')",
  "require('electron-updater')", "ipcMain.handle('game:launch'",
  "process.platform === 'win32' && isMinecraft263(opts)",
  "activeGameProcess = child"
]) assert.ok(main.includes(required), `Missing original Electron code: ${required}`);
assert.ok(read('src/preload.js').includes('contextBridge'));
const workflow = read('.github/workflows/release.yml');
assert.ok(workflow.includes('Build Windows'));
assert.ok(workflow.includes('AppImage'));
assert.ok(workflow.includes('macOS'));
assert.equal(fs.existsSync(path.join(root, 'src/assets/home-player-background.png')), true);
const expectedBg = 'ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793';
const actualBg = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/assets/home-player-background.png'))).digest('hex');
assert.equal(actualBg, expectedBg, 'User-provided Minecraft background must be byte-identical');
console.log('[v1.6.57] PASS: Electron-only source, Windows/Linux/macOS builds, original launch code, updates and exact user background');
