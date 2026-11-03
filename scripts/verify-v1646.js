// Regression suite for the v1.6.46 Play character + Content/Settings refinements.
// This verifies the source-level wiring without requiring Microsoft credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = require(path.join(root, 'package.json'));
const html = read('src/index.html');
const renderer = read('src/renderer.js');
const css = read('src/refinements-v1646.css');
assert(Number(pkg.version.split('.')[2]) >= 46, 'Requires the complete v1.6.46 baseline or newer');
assert(html.includes('<link rel="stylesheet" href="refinements-v1646.css" />'), 'Refinement stylesheet must load last');
assert(html.includes('<script src="../node_modules/skinview3d/bundles/skinview3d.bundle.js"></script>'), 'Original 3D preview runtime is required');
for (const id of ['skinPlaceholder','skinViewerCanvas','playerSkinFallback','homeAccountName', 'changeModVersionBtn']) {
  assert(html.includes(`id="${id}"`), `Missing required player or version control ${id}`);
}
assert(html.includes('class="skin-display"'), 'Minecraft character must be displayed on Play');
assert(renderer.includes('void renderPlayer().catch('), 'Character must refresh when changing account');
assert(renderer.includes('skinViewer.controls.enableRotate = true'), 'Preserve rotate-to-view the Minecraft player');
assert(renderer.includes("console.warn('3D skin preview unavailable; using 2D fallback:'"), '3D fallback must not block the launcher');
assert(renderer.includes("fallback.src = skinBodyUrl(account)"), 'Preserve 2D fallback when no 3D engine is available');
assert(!html.includes('class="home-center-art"'), 'Remove the replacement logo-only Play hero');
assert(!html.includes('class="content-manager-sidebar"'), 'Entire Your Library promo card must be absent');
assert(!html.includes('YOUR LIBRARY'), 'Entire Your Library promo card must be absent');
assert(css.includes('.content-manager-grid {') && css.includes('display: block;'), 'Full-width Content manager must use available space');
assert(html.includes('class="mod-context-actions"') || html.includes('class="mod-selected-version-row" aria-label="Version controls"'), 'Keep version-switch available without promotional sidebar');
const versionBtn = /<button id="versionBtn"[\s\S]*?<\/button>/.exec(html)?.[0];
assert(versionBtn, 'Play version selector must remain');
assert(versionBtn.includes('id="selectedVersionLabel"'), 'Play version selector must still show chosen version');
assert(!versionBtn.includes('CHANGE') && !versionBtn.includes('Change'), 'No extra Change label on Play version control');
assert(!renderer.includes('↓ ${formatDownloads(item.downloads)}'), 'Remove blurry download arrow before download totals');
assert(renderer.includes('${formatDownloads(item.downloads)} downloads'), 'Keep numeric download totals');
const settingsSvg = /<button\b[^>]*data-view="settings"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1];
assert(settingsSvg, 'Settings navigation must remain');
assert(settingsSvg.includes('M10.4 2.5h3.2') && settingsSvg.includes('<circle cx="12" cy="12" r="3.2"'), 'Use a recognizable toothed gear with a central opening');
assert(!html.includes('data-view="cosmetics"'), 'Do not restore separate Skins management UI');
assert(html.includes('id="view-cosmetics"'), 'Preserve old cosmetics backend and rollback source');
for (const id of ['view-home','view-mods','view-versions','view-settings','view-accounts','accountSwitcher','socialChat','socialMessages','playBtn']) {
  assert(html.includes(`id="${id}"`), `Original launcher feature must remain: ${id}`);
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, 'No duplicate DOM IDs');
assert(pkg.scripts['verify:ui'].includes('node scripts/verify-v1643.js'), 'Keep Logs + Built-In regression suite');
assert(pkg.scripts['verify:ui'].includes('node scripts/verify-v1644.js'), 'Keep prior visual regression suite');
assert(pkg.scripts['verify:ui'].includes('node scripts/verify-v1645.js'), 'Keep adaptive messaging regression suite');
console.log('PASS: v1.6.46 Play player, full-width Mods, version label, download counts, Settings gear, feature preservation.');
