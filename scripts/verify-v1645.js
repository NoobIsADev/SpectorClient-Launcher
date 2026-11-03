// New v1.6.45 UI regression checks. No dependencies needed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/redesign-v1645.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
assert(Number(pkg.version.split('.')[2]) >= 45, 'Requires v1.6.45 UI baseline');
const requiredIds = [
  'view-home', 'view-mods', 'view-versions', 'view-accounts', 'view-settings', 'view-logs',
  'playBtn', 'status', 'versionBtn', 'selectedVersionLabel', 'versionActiveName',
  'homeFeaturedVersion', 'accountSwitcher', 'topAccountName', 'minimizeBtn', 'maximizeBtn', 'closeBtn',
  'modVersionChooser', 'modManagerContent', 'modSelectedVersionLabel', 'contentVersionQuestion',
  'contentTypeButton', 'contentTypeMenu', 'contentTypeLabel', 'modSearchInput', 'modSearchBtn',
  'modSearchResults', 'modPagination', 'modInstallPanel', 'modInstalledPanel', 'installedMods',
  'socialMain', 'socialHome', 'socialChat', 'socialMessages', 'socialMessageForm',
  'socialMessageInput', 'socialChatExpandBtn', 'socialRailBackdrop', 'friendsPanelToggle',
  'socialRailCloseBtn', 'socialFriendsList', 'socialRequestsList', 'socialSearchResults',
  'settingsSelectedVersion', 'openFolderRailBtn'
];
for (const id of requiredIds) assert(html.includes(`id="${id}"`), `Missing functional UI ID ${id}`);
for (const version of ['26.2','26.3','1.21.11']) {
  assert(html.includes(`data-game-version="${version}"`));
  assert(html.includes(`data-version-use="${version}"`));
  assert(html.includes(`data-version-content="${version}"`));
  assert(html.includes(`data-mod-game-version="${version}"`));
}
for (const type of ['mods','resourcepacks','shaders']) {
  assert(html.includes(`data-content-type-shortcut="${type}"`));
  assert(renderer.includes('setActiveContentType(button.dataset.contentTypeShortcut)'));
}
for (const el of ['topbar-version','topbar-client-label']) {
  assert(!html.includes(`class="${el}"`) && !html.includes(`id="${el}"`), `${el} should be absent from visible UI`);
}
assert(!html.includes('data-view="cosmetics"'), 'Skins should not appear in navigation');
assert(!html.includes('class="secondary-btn open-cosmetics"'), 'Skin changer should not be in account cards');
if (Number(pkg.version.split('.')[2]) === 45) {
  assert(!html.includes('skinview3d.bundle.js'), 'v1.6.45 intentionally hid 3D previews');
} else {
  assert(html.includes('skinview3d.bundle.js'), 'Play-screen 3D character was restored in v1.6.46');
}
assert(html.includes('id="view-cosmetics"'), 'Archived cosmetics source is intentionally retained for potential rollback');
assert(css.includes('#view-cosmetics { display: none !important; }'));
assert(html.includes('<link rel="stylesheet" href="styles.css" />') && html.includes('<link rel="stylesheet" href="overhaul.css" />') && html.includes('<link rel="stylesheet" href="redesign-v1645.css" />'));
assert(renderer.includes('function closeResponsiveSocialPanel()') && renderer.includes('function toggleResponsiveSocialPanel('));
assert(renderer.includes("window.launcher.windowControl('minimize')"));
assert(renderer.includes("window.launcher.windowControl('maximize')"));
assert(renderer.includes("window.launcher.windowControl('close')"));
assert(css.includes('font-size: 13px') && css.includes('.social-message'));
for (const width of ['1160px','850px','680px']) assert(css.includes(width), `Missing responsive breakpoint ${width}`);
assert(main.includes('minWidth: 820,') && main.includes('minHeight: 560,'));
assert(renderer.includes("const actionLabel = builtIn ? 'Built-In'"),'v1.6.43 Built-In status must persist');
assert(main.includes('if (gameLaunchInProgress) return; // Never terminate during Minecraft preparation.'),'v1.6.43 Logs launch safety must persist');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
assert.equal(ids.length,new Set(ids).size,'Duplicate UI ids');
console.log('PASS: v1.6.45 IDs, controls, modern versions, content library, responsive Satellite, no skins, launch preservation.');
