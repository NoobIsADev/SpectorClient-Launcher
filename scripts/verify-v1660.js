'use strict';
// v1.6.60: inline Play/Mods dropdowns replace both full-page version choosers.
// No network, Electron runtime, or third-party dependency required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const html = read('src/index.html');
const js = read('src/renderer.js');
const css = read('src/refinements-v1660.css');
const main = read('src/main.js');
const pkg = require('../package.json');
assert(Number(pkg.version.split('.').at(-1)) >= 60, 'v1.6.60 dropdown behavior must be preserved');
assert(pkg.scripts['verify:ui'].includes('node scripts/verify-v1659.js'), 'Forge and Java 8 regression coverage must persist');
assert(pkg.scripts['verify:ui'].includes('node scripts/verify-v1660.js'));
assert(html.includes('<link rel="stylesheet" href="refinements-v1660.css" />'), 'New dropdown theme stylesheet must load');
assert(!html.includes('id="view-versions"') && !html.includes('data-view="versions"'), 'Versions page and sidebar entry must be removed');
assert(!html.includes('id="modVersionChooser"') && !html.includes('class="mod-version-grid"'), 'Full-sized Mods version picker must be removed');
for (const id of ['playBtn','versionBtn','selectedVersionLabel','playVersionMenu','changeModVersionBtn','modsVersionMenu','modManagerContent','modSearchResults','modInstalledPanel','view-home','view-mods','settingsSelectedVersion']) {
  assert(html.includes(`id="${id}"`), `Functional ID missing: ${id}`);
}
assert(html.includes('id="modManagerContent">'), 'Mods content should be directly visible on page open');
for (const [trigger, menu] of [['versionBtn','playVersionMenu'],['changeModVersionBtn','modsVersionMenu']]) {
  const button = html.match(new RegExp(`<button id="${trigger}"[^>]+>`))?.[0];
  assert(button?.includes(`aria-controls="${menu}"`) && button.includes('aria-expanded="false"') && button.includes('aria-haspopup="listbox"'), `Accessible dropdown wiring missing: ${trigger}`);
  assert(html.includes(`id="${menu}" class="version-dropdown hidden" role="listbox"`));
}
assert(css.includes('.home-version-picker .version-dropdown { bottom:') && css.includes('.mods-version-picker .version-dropdown { top:'), 'Play opens upward and Mods opens downward');
assert(css.includes('rgb(var(--accent-rgb) / .13)'), 'Dropdown selected items respect launcher theme');
assert(js.includes('window.launcher.saveSettings(collectSettings())'), 'Play version selection must persist through existing settings IPC');
assert(js.includes('versionLoaderLabel(modsTargetVersion)'), 'Mods loading labels must show Forge for 1.8.9');
assert(!js.includes('Folder: <code>${escapeHtml(contentFolderForVersion(modsTargetVersion))}</code>'), 'Do not put long instance paths back into Mods heading');
assert(js.includes('await selectModsVersion(version)'), 'Mods dropdown must use existing version-specific content loading');
assert(js.includes("if (name === 'versions') name = 'home'"), 'Legacy navigation redirected harmlessly');
assert(js.includes("if (event.key === 'Escape') { closeVersionDropdowns(true)"), 'Escape must close and restore focus');
assert(js.includes('modsTargetVersion || selectedGameVersion()'), 'Mods dropdown must have a compatible selected state');
assert(main.includes('https://spectorclient.com/mod/download/legacy') && main.includes('ensureForgeUniversal(getInstanceRoot(selectedVersion)'),'Forge 1.8.9 integration must not regress');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(ids.length,new Set(ids).size,'No duplicate DOM ids');
const background = fs.readFileSync(path.join(root,'src/assets/home-player-background.png'));
assert.equal(crypto.createHash('sha256').update(background).digest('hex'), 'ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793','User-provided Minecraft background must be byte-for-byte identical');

// Exercise dynamic dropdown options and independent version selection directly
// against the exact renderer functions used by the Play and Content buttons.
class FakeClassList {
  constructor(value='') { this.items=new Set(value.split(/\s+/).filter(Boolean)); }
  add(x){this.items.add(x);} remove(x){this.items.delete(x);} contains(x){return this.items.has(x);}
}
class Element {
  constructor(initial='') {this.classList=new FakeClassList(initial);this.attributes={};this.children=[];this.dataset={};this.textContent='';}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k];}
  replaceChildren(...children){this.children=children;}
  append(...children){this.children.push(...children);}
  focus(){this.focused=true;}
}
const elements = {
  versionBtn:new Element(), playVersionMenu:new Element('hidden'),
  changeModVersionBtn:new Element(), modsVersionMenu:new Element('hidden'),
  selectedVersionLabel:new Element(),settingsSelectedVersion:new Element(),
  settingsLoader:new Element(),settingsLoaderSupport:new Element(),homeFeaturedVersion:new Element()
};
let saved=[];
const context=vm.createContext({
  settings:{selectedGameVersion:'26.2'},
  modsTargetVersion:null,
  clientInfo:{defaultGameVersion:'26.2',supportedVersions:['26.3','26.2','1.21.11','1.8.9'].map(v=>({gameVersion:v,loader:v==='1.8.9'?'forge':'fabric'}))},
  $:id=>elements[id]||null,
  document:{createElement:()=>new Element()},
  window:{launcher:{saveSettings:async data=>{saved.push(data.selectedGameVersion);return data;}}},
  collectSettings:()=>({...context.settings}),updatePlayState:()=>{},showToast:()=>{},
  selectModsVersion:async v=>{context.modsTargetVersion=v;}
});
const start=js.indexOf('function supportedGameVersions()');
const end=js.indexOf('const CONTENT_UI =',start);
assert(start>0 && end>start, 'Dropdown uses original renderer version helpers');
vm.runInContext(js.slice(start,end),context);
context.renderSelectedVersionUI();
for(const kind of ['play','mods']) {
  const options=elements[kind==='play'?'playVersionMenu':'modsVersionMenu'].children;
  assert.deepEqual(options.map(o=>o.dataset.dropdownVersion),['26.3','26.2','1.21.11','1.8.9']);
  assert.equal(options.at(-1).children[1].textContent,'Forge');
  assert.equal(options[0].children[1].textContent,'Fabric');
  const trigger=elements[kind==='play'?'versionBtn':'changeModVersionBtn'];
  context.toggleVersionDropdown(kind);
  assert.equal(trigger.getAttribute('aria-expanded'),'true');
  context.closeVersionDropdowns();
  assert.equal(trigger.getAttribute('aria-expanded'),'false');
}
(async()=>{
  await context.applyVersionDropdownSelection('play','1.8.9');
  assert.equal(context.settings.selectedGameVersion,'1.8.9');
  assert.equal(saved.at(-1),'1.8.9');
  assert.equal(elements.selectedVersionLabel.textContent,'1.8.9');
  await context.applyVersionDropdownSelection('play','26.3');
  await context.applyVersionDropdownSelection('mods','1.8.9');
  assert.equal(context.modsTargetVersion,'1.8.9');
  assert.equal(context.settings.selectedGameVersion,'26.3','Selecting Mods target must not change Play version');
  assert.equal(elements.selectedVersionLabel.textContent,'26.3');
  console.log('PASS: v1.6.60 no Versions page, responsive themed Play/Mods dropdowns, Forge/Fabric options, independent selection, settings persistence, original launcher & image preserved.');
})().catch(e=>{console.error(e);process.exitCode=1;});
