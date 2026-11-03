// SpectorClient Launcher v1.6.50 — provider bar regression checks.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = require('../package.json');
const html = read('src/index.html');
const css = read('src/refinements-v1650.css');
const renderer = read('src/renderer.js');
assert(Number(pkg.version.split('.')[2]) >= 50, 'v1.6.50 provider baseline must be preserved');
assert(html.includes('<link rel="stylesheet" href="refinements-v1650.css" />'), 'Provider CSS must be loaded after previous styles');
assert(html.includes('class="content-provider-switch" role="tablist"'), 'Provider tab controls must remain');
for (const provider of ['modrinth', 'curseforge']) {
  assert(html.includes(`data-content-provider="${provider}"`), `Preserve ${provider} button`);
  assert(renderer.includes(provider), `Preserve ${provider} source integration`);
}
const rule = css.match(/#modInstallPanel \.content-provider-switch\s*\{([^}]+)\}/);
assert(rule, 'Need scoped override for redundant full-width provider banner');
for (const declaration of ['width: fit-content', 'padding: 0 !important', 'border: 0 !important', 'background: transparent !important', 'box-shadow: none !important']) {
  assert(rule[1].includes(declaration), `Provider wrapper must declare ${declaration}`);
}
assert(css.includes('#modInstallPanel .content-provider-switch > .content-provider-btn'), 'Buttons must remain individually styled');
assert(!css.includes('display: none'), 'Do not hide the provider selector');
assert(pkg.scripts['verify:ui'].includes('verify-v1649.js'), 'Previous regression checks preserved');
assert(pkg.scripts['verify:ui'].includes('verify-v1650.js'), 'New regression check included');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'IDs must remain unique');
console.log('PASS: v1.6.50 transparent standalone Modrinth/CurseForge selector; integrations preserved.');
