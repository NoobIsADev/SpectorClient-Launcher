// Regression suite for SpectorClient Launcher v1.6.47, compact Versions UI.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const pkg = require(path.join(root, 'package.json'));
const html = read('src/index.html');
const js = read('src/renderer.js');
const css = read('src/refinements-v1647.css');
assert(/^1\.6\.(?:4[7-9]|[5-9]\d|\d{3,})$/.test(pkg.version), 'v1.6.47 or later keeps compact version UI');
assert(html.includes('<link rel="stylesheet" href="refinements-v1647.css" />'), 'Compact card CSS must load after old styles');
assert(!html.includes('version-feature-list'), 'Remove checklist entirely');
assert(!html.includes('version-path-details'), 'Remove long mods directory area');
assert(!html.includes('MODS DIRECTORY'), 'No long mods directory label');
for (const description of ['Latest Minecraft release','Modern stable edition','Java 21 compatibility','Separate instance','Managed Fabric','Independent mods']) {
  assert(!html.includes(description), `Obsolete card copy remains: ${description}`);
}
const matches = [...html.matchAll(/<article class="client-version-card" data-game-version="([^"]+)">([\s\S]*?)<\/article>/g)];
assert.equal(matches.length, 3, 'All three version cards must exist');
for (const version of ['26.3','26.2','1.21.11']) {
  const body = matches.find(([, candidate]) => candidate === version)?.[2];
  assert(body, `Missing version card ${version}`);
  assert(body.includes(`<h3>${version}</h3>`));
  assert(body.includes(`data-version-use="${version}"`), 'Keep Use button');
  assert(body.includes(`data-version-content="${version}"`), 'Keep Manage Mods button');
  assert(!body.includes('version-path-details') && !body.includes('version-feature-list'));
  assert(html.includes(`data-mod-game-version="${version}"`), 'Keep mod content chooser');
  assert(html.includes(`Fabric • Minecraft ${version}`), 'Readable mod chooser subtitle');
}
assert(js.includes("if ($('versionModsPath26'))"), 'Retain previous guarded path-update source for rollback');
assert(js.includes('contentFolderForVersion(gameVersion)'), 'Keep directory resolution for installs');
assert(js.includes('`Minecraft ${version} compatibility`'), 'Shared global content version chooser');
assert(!js.includes('`Fabric • ${path26}`'), 'Do not restore long chooser path dynamically');
assert(css.includes('min-height: 196px') && css.includes('margin-top: auto'), 'Cards must compact without losing usable buttons');
assert(html.includes('id="openModsFolderBtn"'), 'Keep open-folder action available in Mods');
assert(html.includes('id="gameDirectory"'), 'Keep folder location in Settings');
assert(html.includes('id="skinViewerCanvas"') && html.includes('id="socialChat"'), 'Preserve Play skin and Satellite');
assert(pkg.scripts['verify:ui'].includes('verify-v1643.js'), 'Prior logs and built-in regressions are required');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate DOM ID');
console.log('PASS: v1.6.47 compact Versions, no long directory labels, all actions and prior features preserved.');
