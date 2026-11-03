// UI-overhaul assertions. Run `node scripts/verify-v1644.js` to verify that
// launcher infrastructure IDs and page wiring survive the visual redesign.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'overhaul.css'), 'utf8');
const patch = Number(pkg.version.split('.')[2]);
assert(patch >= 44, 'v1.6.44 overhaul baseline must not be rolled back accidentally');
assert(html.includes('<link rel="stylesheet" href="styles.css" />'), 'Original CSS must stay loaded');
assert(html.includes('<link rel="stylesheet" href="overhaul.css" />'), 'Overhaul CSS must load after old CSS');
assert(fs.existsSync(path.join(root, 'ROLLBACK.md')), 'Revert documentation must be present');
const nav = [...html.matchAll(/class="rail-btn[^\"]*"\s+data-view="([^\"]+)"/g)].map(x => x[1]);
assert.deepEqual(nav, patch >= 45
  ? ['home', 'versions', 'mods', 'accounts', 'settings']
  : ['home', 'mods', 'versions', 'accounts', 'cosmetics', 'settings']);
for (const disallowed of ['Chat', 'Clips', 'Character', 'Servers']) {
  assert(!new RegExp(`<span class="rail-label">${disallowed}</span>`).test(html), `Unwanted sidebar link ${disallowed}`);
}
assert(!html.includes('news-panel'), 'News panel must be removed');
assert(!html.includes('newsHomeBtn'), 'Removed News button must not be referenced in HTML');
assert(!js.includes("$('newsHomeBtn')"), 'Removed News button must not be referenced in JS');
assert(!html.includes('quick-play'), 'Quick Play must remain removed');
assert(!html.includes('notification-center'), 'Notification Center must remain removed');
for (const id of [
  'minimizeBtn', 'maximizeBtn', 'closeBtn', 'accountSwitcher', 'topAccountName',
  'playBtn',
  'versionBtn', 'status', 'view-home', 'view-mods', 'view-versions', 'view-accounts',
  'view-cosmetics', 'view-settings', 'view-logs', 'socialMain', 'socialHome',
  'socialFriendsList', 'socialRequestsList', 'socialChat', 'openFolderRailBtn',
  'openClientFolderBtn', 'cosmeticsSkinFile', 'applyCosmeticsSkinBtn',
  'modManagerContent', 'modSearchResults', 'modSelectedVersionLabel'
]) {
  assert(new RegExp(`\\bid="${id}"`).test(html), `Must keep functional DOM id: ${id}`);
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate element IDs found');
assert(js.includes("button.setAttribute('aria-current', 'page')") ||
       js.includes("nav.setAttribute('aria-current', 'page')"));
assert(js.includes("window.launcher.windowControl('close')"), 'Close control must remain functional');
assert(js.includes("window.launcher.windowControl('minimize')"), 'Minimize must remain functional');
assert(js.includes("window.launcher.windowControl('maximize')"), 'Maximize must remain functional');
assert(css.includes('grid-template-columns: 80px minmax(0,1fr) 294px'));
if (patch >= 45) {
  assert(!html.includes('data-view="cosmetics"'), 'Skins navigation should not be visible');
  if (patch === 45) assert(!html.includes('id="skinViewerCanvas"'), 'v1.6.45 hides player preview');
  if (patch >= 46) assert(html.includes('id="skinViewerCanvas"'), 'v1.6.46 restores player on Play');
  assert(!html.includes('class="topbar-version"'), 'Header version label must be removed');
  assert(fs.existsSync(path.join(root,'src','redesign-v1645.css')));
}
assert(css.includes('.right-rail') && css.includes('.friends-panel'));
console.log('PASS: v1.6.44+ navigation, chrome, rollback and DOM compatibility.');
