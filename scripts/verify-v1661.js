'use strict';
// v1.6.61: Content header actions + shared saves/config migration, pure Node tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/refinements-v1661.css'), 'utf8');
const pkg = require('../package.json');
assert(Number(pkg.version.split('.')[2]) >= 61, 'v1.6.61 shared-folder behavior retained');
assert(pkg.scripts['verify:ui'].includes('verify-v1659.js'));
assert(pkg.scripts['verify:ui'].includes('verify-v1660.js'));
assert(pkg.scripts['verify:ui'].includes('verify-v1661.js'));
assert(html.includes('<link rel="stylesheet" href="refinements-v1661.css" />'));
assert.equal((html.match(/id="changeModVersionBtn"/g) || []).length, 1);
assert.equal((html.match(/id="openModsFolderBtn"/g) || []).length, 1);
assert.equal((html.match(/id="modsVersionMenu"/g) || []).length, 1);
const header = html.slice(html.indexOf('class="section-head content-page-head"'),html.indexOf('class="content-quick-nav"'));
assert(header.includes('class="mod-context-actions"'));
assert(header.indexOf('id="openModsFolderBtn"') < header.indexOf('id="changeModVersionBtn"'));
assert(header.includes('id="modsVersionMenu"'));
assert(!html.includes('class="mod-selected-version-row"'), 'Old extra bar below category tabs must be gone');
assert(html.includes('id="modSelectedVersionLabel" hidden'), 'Renderer reference stays intact');
assert(css.includes('.content-page-head .mod-context-actions'));
assert(css.includes('.content-page-head .mods-version-picker .version-dropdown'));
assert(html.includes('id="playVersionMenu"'), 'Play dropdown remains unchanged');
assert(main.includes('https://spectorclient.com/mod/download/legacy'), 'Forge legacy Spector mod endpoint preserved');
assert(main.includes("if (gameVersion === '1.8.9' && entryName === 'options.txt') continue"), 'Legacy options.txt must remain separate');
assert(main.includes("['config', 'spectorclient', 'resourcepacks', 'shaderpacks', 'saves']"), 'All five directories must be shared');
assert(!main.includes("gameVersion === '1.8.9' && entryName === 'config'"), '1.8.9 must not skip shared config');
assert(main.includes('mergeWorldsIntoShared'), 'World save names must be collision-safe');
assert(!html.includes('id="view-versions"'), 'Versions page stays removed');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
assert.equal(ids.length, new Set(ids).size, 'No duplicate DOM ids');
const bg = fs.readFileSync(path.join(root,'src/assets/home-player-background.png'));
assert.equal(crypto.createHash('sha256').update(bg).digest('hex'),'ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793');

const start = main.indexOf('const SHARED_INSTANCE_DIRECTORIES');
const end = main.indexOf('async function ensureDirs()', start);
assert(start > 0 && end > start, 'Shared-data helper source block remains intact');
const snippet = main.slice(start, end);

async function runScenario(platform) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'spector-shared-' + platform + '-'));
  try {
    const instances = path.join(tmp, 'instances');
    const versions = ['26.2', '26.3', '1.21.11', '1.8.9'];
    for (const v of versions) await fsp.mkdir(path.join(instances, v), {recursive:true});
    const put = async (v, entry, name, content) => {
      const base = v ? path.join(instances, v, entry) : path.join(tmp,entry);
      await fsp.mkdir(base,{recursive:true});
      await fsp.mkdir(path.dirname(path.join(base,name)),{recursive:true});
      await fsp.writeFile(path.join(base,name),content);
    };
    await put(null,'saves','MyWorld/level.dat','newer-level');
    await put('1.8.9','saves','MyWorld/level.dat','legacy-level');
    await put('1.21.11','saves','SecondWorld/region/r.0.0.mca','region-two');
    await put('26.3','saves','MyWorld/level.dat','third-level');
    await put(null,'config','modern.json','modern config');
    await put('1.8.9','config','legacy.cfg','legacy config');
    // Keep the legacy options file isolated from the modern shared options.
    await fsp.writeFile(path.join(instances,'1.8.9','options.txt'),'legacy options');
    await fsp.writeFile(path.join(tmp,'options.txt'),'modern options');
    await fsp.mkdir(path.join(instances,'26.2','mods'),{recursive:true});
    await fsp.mkdir(path.join(instances,'1.8.9','mods'),{recursive:true});
    await fsp.writeFile(path.join(instances,'1.8.9','mods','legacy.jar'),'legacy mod');
    let messages=[];
    const ctx = vm.createContext({
      path, fs, fsp, process:{platform}, APPDATA_ROOT:tmp, LAUNCHER_DATA:path.join(tmp,'launcher-data'),
      DEFAULT_GAME_VERSION:'26.2', CLIENT_PROFILES:Object.fromEntries(versions.map(v=>[v,{}])),
      launcherDataPath:(...parts)=>path.join(tmp,'launcher-data',...parts),
      instancePath:(v,...parts)=>path.join(instances,v,...parts),
      normalizeGameVersion:(v)=>versions.includes(v)?v:'26.2',
      pathExists: async file => { try { await fsp.access(file,fs.constants.F_OK);return true; } catch {return false;} },
      log:(text)=>messages.push(text)
    });
    vm.runInContext(snippet,ctx,{filename:'src/main.js shared block'});
    await vm.runInContext('ensureSharedInstanceData()',ctx);
    for (const v of versions) {
      for (const dir of ['config','spectorclient','resourcepacks','shaderpacks','saves']) {
        assert.equal(await fsp.realpath(path.join(instances,v,dir)),await fsp.realpath(path.join(tmp,dir)),`${platform} ${v}/${dir} must share one root`);
      }
    }
    assert.equal(await fsp.readFile(path.join(tmp,'saves','MyWorld','level.dat'),'utf8'),'newer-level');
    assert.equal(await fsp.readFile(path.join(tmp,'saves','MyWorld (from 1.8.9)','level.dat'),'utf8'),'legacy-level');
    assert.equal(await fsp.readFile(path.join(tmp,'saves','MyWorld (from 26.3)','level.dat'),'utf8'),'third-level');
    assert.equal(await fsp.readFile(path.join(tmp,'saves','SecondWorld','region','r.0.0.mca'),'utf8'),'region-two');
    assert.equal(await fsp.readFile(path.join(instances,'1.8.9','config','legacy.cfg'),'utf8'),'legacy config');
    assert.equal(await fsp.readFile(path.join(instances,'26.2','config','legacy.cfg'),'utf8'),'legacy config');
    assert.equal(await fsp.readFile(path.join(instances,'1.8.9','options.txt'),'utf8'),'legacy options');
    assert.equal(await fsp.readFile(path.join(tmp,'options.txt'),'utf8'),'modern options');
    assert.equal(await fsp.readFile(path.join(instances,'1.8.9','mods','legacy.jar'),'utf8'),'legacy mod');
    assert.notEqual(path.resolve(path.join(instances,'26.2','mods')),path.resolve(path.join(instances,'1.8.9','mods')));
    // Reconciliation must be idempotent, without duplicate worlds.
    await vm.runInContext('ensureSharedInstanceData()',ctx);
    const names = await fsp.readdir(path.join(tmp,'saves'));
    assert.equal(names.filter(n=>n.startsWith('MyWorld')).length,3);
    assert(messages.some(m=>m.includes('Preserving 1.8.9')), 'Collision must be logged');

    // A link to some unrelated saves folder must never be removed or followed.
    const outside = path.join(tmp,'outside-worlds');
    await fsp.mkdir(outside,{recursive:true});
    await fsp.writeFile(path.join(outside,'level.dat'),'unrelated world');
    const suspicious=path.join(instances,'1.8.9','saves');
    await fsp.unlink(suspicious);
    await fsp.symlink(outside,suspicious,platform==='win32'?'junction':'dir');
    await assert.rejects(vm.runInContext("ensureSharedSavesForVersion('1.8.9')",ctx),/Refusing to replace/);
    assert.equal(await fsp.readFile(path.join(outside,'level.dat'),'utf8'),'unrelated world');
    assert.equal(await fsp.realpath(suspicious),await fsp.realpath(outside));
  } finally {
    await fsp.rm(tmp,{recursive:true,force:true});
  }
}
(async()=>{
  for (const platform of ['linux','win32','darwin']) await runScenario(platform);
  console.log('PASS: v1.6.61 Content header controls, all shared dirs incl. Forge 1.8.9, worlds collision-safe + idempotent migration, options/mod isolation, Windows/Linux/macOS symlinks');
})().catch(err=>{console.error(err);process.exitCode=1;});
