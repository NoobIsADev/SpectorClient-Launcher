// SpectorClient Launcher v1.6.49 regression and original-image-integrity checks.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('src/index.html');
const css = read('src/refinements-v1649.css');
const fetchBrand = read('scripts/fetch-brand.js');
const renderer = read('src/renderer.js');
const pkg = require('../package.json');
assert.ok(/^1\.6\.\d+$/.test(pkg.version) && Number(pkg.version.split('.')[2]) >= 49, 'v1.6.49 checks must remain enabled for all later patch releases');
assert(html.includes('<link rel="stylesheet" href="refinements-v1649.css" />'), 'New stylesheet must load');
assert(html.includes('id="skinViewerCanvas"'), '3D player must remain');
assert(html.includes('id="playerSkinFallback"'), 'Player fallback must remain');
assert(html.includes('id="homeAccountName" hidden'), 'Account state hook must remain but be hidden');
assert(html.includes('id="homeFeaturedVersion" hidden'), 'Version state hook must remain but be hidden');
assert(!html.includes('CURRENT ACCOUNT'), 'Remove duplicate Current Account heading');
assert(!html.includes('class="hero-brand"'), 'Remove oversized home brand heading');
assert(!html.includes('class="hero-identity"'), 'Remove player heading copy');
assert(css.includes('assets/home-player-background.png'), 'Play background must use the supplied image');
assert(css.includes('filter: none !important;'), 'Do not alter background colors');
assert(css.includes('grid-template-rows: minmax(0, 1fr)'), 'Play player must fill the released heading space');
assert(fetchBrand.includes('verifyBundledUserBackground()'), 'Build must verify the exact PNG');
assert(fetchBrand.includes('await Promise.all([prepareLogo(), verifyBundledUserBackground()])'), 'Do not fetch old background or replace custom image');
const file = path.join(root, 'src/assets/home-player-background.png');
const originalHash = 'ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793';
const buffer = fs.readFileSync(file);
assert.equal(buffer.length, 4454146, 'Image byte count must remain exact');
assert.equal(crypto.createHash('sha256').update(buffer).digest('hex'), originalHash, 'Image must be byte-for-byte identical');
assert.deepEqual(buffer.subarray(0,8), Buffer.from([137,80,78,71,13,10,26,10]), 'Image must remain PNG');
const forbidden = /[↗↘↖↙→←↻]/;
for (const match of html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
  assert(!forbidden.test(match[0]), `Remove decorative arrow from button: ${match[0].slice(0,110)}`);
}
assert(!renderer.includes('Equip cape →'), 'Cape action should not show decorative arrow');
for (const required of ['data-version-use="26.3"','data-version-use="26.2"','data-version-use="1.21.11"', 'data-version-content="26.3"','data-mod-game-version="26.3"','id="socialChat"','id="playBtn"']) {
  assert(html.includes(required), `Must preserve original function ${required}`);
}
assert(pkg.scripts['verify:ui'].includes('verify-v1648.js'), 'Previous suite stays in test chain');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(ids).size, ids.length, 'No duplicate DOM IDs');
console.log('PASS: v1.6.49 bundled exact PNG SHA-256, clean Play heading, plain action buttons, and feature wiring.');
