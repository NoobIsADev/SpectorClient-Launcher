// SpectorClient Launcher v1.6.51: header layout and corner branding regression tests.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = require('../package.json');
const html = read('src/index.html');
const css = read('src/refinements-v1651.css');
const js = read('src/renderer.js');
assert(Number(pkg.version.split('.').at(-1)) >= 51, 'v1.6.51 layout must remain in later releases');
assert(html.includes('<link rel="stylesheet" href="refinements-v1651.css" />'), 'New style layer must be loaded last');
assert(!/class="(?:top-brand-logo|brand-logo-img|rail-logo)"/.test(html), 'Remove redundant corner images, not the brand name');
assert(/<div class="client-title" aria-label="SpectorClient">[\s\S]*?<span class="client-title-main">Spector<\/span><span class="client-title-accent">Client<\/span>/.test(html), 'Keep header wordmark readable and text-only');
assert(/\.topbar\s*\{[^}]*padding-left:\s*12px/.test(css), 'Text must shift into former icon footprint');
assert(/\.client-title\s*\{[^}]*padding:\s*0\s*!important/.test(css), 'Remove leftover text inset');
assert(html.includes('class="version-featured-logo"'), 'Preserve featured-version logo on Versions screen');
for(const id of ['accountSwitcher','friendsPanelToggle','minimizeBtn','maximizeBtn','closeBtn','versionBtn','changeModVersionBtn','playBtn','modManagerContent','view-home','view-mods','view-versions','view-settings']) {
 assert(html.includes('id="'+id+'"'), 'Functional control missing: '+id);
}
assert(js.includes('renderPlayer()') && js.includes('changeModVersionBtn'), 'Preserve player preview and mod version logic');
assert(pkg.scripts['verify:ui'].includes('verify-v1650.js') && pkg.scripts['verify:ui'].includes('verify-v1651.js'), 'Keep previous and new suites');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate HTML IDs');
console.log('PASS: v1.6.51 corner logos removed, wordmark moved left; all controls retained.');
