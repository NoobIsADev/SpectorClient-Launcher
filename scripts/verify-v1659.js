'use strict';
// v1.6.59: Java 8 / Forge 1.8.9 / loader-filter regressions. Fully offline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  FORGE_VERSION, FORGE_UNIVERSAL_URL, FORGE_UNIVERSAL_SHA1,
  verifyForgeUniversal, ensureForgeUniversal
} = require('../src/legacy-forge');
const {
  verifyForgeJar, verifyFabricJar, downloadSpectorJar, installVerifiedSpectorJar
} = require('../src/spector-mod-network');
const { minecraftVersion, isMinecraft263, getCustomLaunchArguments, normalizeCustomJvmArgs, enforceFinalJvmArguments } = require('../src/launch-jvm');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
assert.equal(pkg.version, '1.6.59');
assert(pkg.scripts['verify:ui'].includes('verify-v1659.js'));
assert.equal(FORGE_VERSION, '11.15.1.2318');
assert(/^[a-f0-9]{40}$/.test(FORGE_UNIVERSAL_SHA1));
assert(FORGE_UNIVERSAL_URL.startsWith('https://maven.minecraftforge.net/'));
assert(FORGE_UNIVERSAL_URL.endsWith('-universal.jar'));
assert(main.includes('https://spectorclient.com/mod/download/legacy'));
assert(main.includes('java8Path'));
assert(main.includes('ensureForgeUniversal(getInstanceRoot(selectedVersion)'));
assert(main.includes("forge: preparedClient.forgePath"));
assert(main.includes('isFabricClient(gameVersion)'));
assert(main.includes("selectedGameVersion === '1.8.9' ? 'legacy' : 'multiplayer'"));
assert(main.includes("gameVersion === '1.8.9' && entryName === 'options.txt'"));
for (const v of ['26.2', '26.3', '1.21.11', '1.8.9']) {
  assert(html.includes(`data-game-version="${v}"`));
  assert(html.includes(`data-mod-game-version="${v}"`));
}
for (const id of ['java8Path', 'chooseJava8Btn', 'installJava8Btn', 'repairJava8Btn', 'modChooserPath189', 'settingsLoader']) {
  assert(html.includes(`id="${id}"`), `Missing ${id}`);
}
assert(ui.includes("chooserText('1.8.9')"));
assert(ui.includes('window.launcher.chooseJava(8)'));
assert(ui.includes("runJavaAction(8, 'repair'"));
// Validate actual Java major parsing, not just the Play-handler mock.
const javaCtx = vm.createContext({ Number, String });
const javaStart = main.indexOf('function javaSettingsKey(');
const javaEnd = main.indexOf('async function pathExists(', javaStart);
assert(javaStart >= 0 && javaEnd > javaStart);
vm.runInContext(main.slice(javaStart, javaEnd), javaCtx);
assert.equal(javaCtx.javaSettingsKey(8), 'java8Path');
assert.equal(javaCtx.javaSettingsKey(21), 'java21Path');
assert.equal(javaCtx.javaSettingsKey(25), 'java25Path');
const javaParseStart = main.indexOf('function parseJavaMajor(');
const javaParseEnd = main.indexOf('async function inspectJava(', javaParseStart);
assert(javaParseStart >= 0 && javaParseEnd > javaParseStart);
vm.runInContext(main.slice(javaParseStart, javaParseEnd), javaCtx);
assert.equal(javaCtx.parseJavaMajor('java version \"1.8.0_471\"'), 8);
assert.equal(javaCtx.parseJavaMajor('openjdk version \"21.0.10\"'), 21);
assert.equal(javaCtx.parseJavaMajor('openjdk version \"25.0.3\"'), 25);
for (const v of ['1.8.9', 'SpectorClient 1.8.9']) assert.equal(minecraftVersion(v), '1.8.9');

function snippet(start, end) {
  const i = main.indexOf(start), j = main.indexOf(end, i + start.length);
  assert(i >= 0 && j > i, `Missing code boundaries: ${start} / ${end}`);
  return main.slice(i, j);
}

function zipFixture(entries) {
  const locals = [], centrals = [];
  let pos = 0;
  for (const [name, bytes] of entries) {
    const n = Buffer.from(name);
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(b.length, 18); local.writeUInt32LE(b.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, b);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(b.length, 20); central.writeUInt32LE(b.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(pos, 42);
    centrals.push(central, n);
    pos += local.length + n.length + b.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centrals.reduce((n, b) => n + b.length, 0), 12);
  end.writeUInt32LE(pos, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function exerciseForgeInstallerAndMod(tmp) {
  const forgeData = zipFixture([
    ['version.json', '{"id":"1.8.9-forge","mainClass":"net.minecraft.launchwrapper.Launch"}'],
    ['net/minecraftforge/fml/common/launcher/FMLTweaker.class', 'CAFE BABE legacy mock']
  ]);
  const sha1 = crypto.createHash('sha1').update(forgeData).digest('hex');
  const instance = path.join(tmp, '1.8.9');
  let downloadCount = 0;
  const download = async (_url, target) => { downloadCount++; await fsp.writeFile(target, forgeData); };
  const first = await ensureForgeUniversal(instance, { sha1, transfer: download });
  assert.equal(first.cached, false);
  assert.equal(first.forgeVersion, FORGE_VERSION);
  assert.equal(downloadCount, 1);
  await verifyForgeUniversal(first.forgePath, sha1);
  const second = await ensureForgeUniversal(instance, { sha1, transfer: download });
  assert.equal(second.cached, true);
  assert.equal(downloadCount, 1, 'Verified Forge universal must be reused');
  await assert.rejects(verifyForgeUniversal(first.forgePath), /SHA-1 mismatch/, 'Wrong Forge build checksum must be rejected');
  await assert.rejects(ensureForgeUniversal(instance, {
    sha1: '0'.repeat(40), transfer: async (_url, target) => fsp.writeFile(target, '<html>not a jar</html>')
  }), /SHA-1 mismatch/);
  assert.deepEqual(await fsp.readFile(first.forgePath), forgeData, 'Bad network file must preserve installed Forge JAR');

  const forgeMod = zipFixture([
    ['mcmod.info', '[{"modid":"spectorclient","mcversion":"1.8.9"}]'],
    ['net/spectorclient/LegacyMod.class', 'CAFE BABE some Java 8 code']
  ]);
  const fabricMod = zipFixture([
    ['fabric.mod.json', '{"id":"spectorclient"}'],
    ['net/spectorclient/FabricClient.class', 'CAFE BABE mock fabric code']
  ]);
  const modPath = path.join(instance, 'mods', 'spectorclient.jar');
  await fsp.mkdir(path.dirname(modPath), { recursive: true });
  await fsp.writeFile(modPath, forgeMod);
  await verifyForgeJar(modPath);
  await assert.rejects(verifyFabricJar(modPath), /fabric\.mod\.json missing/);
  const wrong = path.join(tmp, 'wrong-loader.jar');
  await fsp.writeFile(wrong, fabricMod);
  await assert.rejects(verifyForgeJar(wrong), /compatible Forge/);
  await assert.rejects(installVerifiedSpectorJar(wrong, modPath, { loader: 'forge' }), /compatible Forge/);
  assert.deepEqual(await fsp.readFile(modPath), forgeMod, 'A mismatched mod must not replace the Forge mod');

  const server = http.createServer((req, res) => {
    if (req.url === '/mod/download/legacy') {
      res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': forgeMod.length });
      res.end(forgeMod);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = (url, options, cb) => http.get(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options, cb);
  try {
    const result = await downloadSpectorJar('https://spectorclient.test/mod/download/legacy', modPath, { loader: 'forge', get });
    await installVerifiedSpectorJar(result.path, modPath, { loader: 'forge' });
    await verifyForgeJar(modPath);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function exerciseLoaderRouting() {
  // Run real production function bodies with only the external services mocked.
  const ctx = vm.createContext({
    normalizeGameVersion: v => v, modLoaderFor: v => v === '1.8.9' ? 'forge' : 'fabric',
    isFabricClient: v => v !== '1.8.9',
    getContentConfig: () => ({ modrinthType: 'mod', fabricOnly: true }),
    normalizeContentType: () => 'mods',
    URLSearchParams, JSON, Math, Date, String, Number, Set, Map,
    ensureDirs: async () => {}, send: () => {}, log: () => {},
    getInstanceRoot: version => `/instances/${version}`,
    ensureFabricProfile: async () => ({ versionId: 'fabric-profile' }),
    ensureFabricApi: async () => { throw new Error('Fabric API must NEVER be requested for 1.8.9'); },
    ensureForgeUniversal: async () => ({ forgePath: '/instances/1.8.9/forge/forge-universal.jar', forgeVersion: FORGE_VERSION }),
    ensureSpectorMod: async () => ({ skipped: false }),
    request: async () => [],
    MODRINTH_API: 'https://api.modrinth.com/v2'
  });
  vm.runInContext(snippet('function buildModrinthFacets(', '\nfunction modrinthPageUrl'), ctx);
  assert.equal(ctx.buildModrinthFacets('1.8.9', 'mods')[1][0], 'categories:forge');
  assert.equal(ctx.buildModrinthFacets('26.3', 'mods')[1][0], 'categories:fabric');
  assert.equal(ctx.buildModrinthFacets('1.8.9', 'mods')[2][0], 'versions:1.8.9');
  vm.runInContext(snippet('async function getCompatibleModrinthProjectVersion(', '\nasync function getCompatibleProjectVersion'), ctx);
  let queried = '';
  ctx.request = async url => { queried = url; return [{ id:'forge-version', version_type:'release', loaders:['forge'], game_versions:['1.8.9'] }]; };
  await ctx.getCompatibleModrinthProjectVersion('1.8.9','mods','example');
  assert.deepEqual(JSON.parse(new URL(queried).searchParams.get('loaders')), ['forge']);
  assert.deepEqual(JSON.parse(new URL(queried).searchParams.get('game_versions')), ['1.8.9']);
  const cfCtx = vm.createContext({
    normalizeGameVersion: v => v, normalizeContentType: () => 'mods',
    getContentConfig: () => ({ curseForgeClassId: 6, fabricOnly:true }),
    modLoaderFor: v => v === '1.8.9' ? 'forge' : 'fabric',
    URLSearchParams, Math, Number, String, Array, JSON,
    CURSEFORGE_PAGE_SIZE: 24, CURSEFORGE_GAME_ID: 432,
    curseForgeProjectCache: new Map(),
    curseForgeRequest: async endpoint => { queried = endpoint; return { data: [], pagination: { totalCount: 0 } }; }
  });
  vm.runInContext(snippet('async function searchCurseForgeContent(', '\nasync function searchContent'), cfCtx);
  await cfCtx.searchCurseForgeContent('1.8.9', 'mods', 'fps');
  assert.equal(new URL('https://curseforge.test' + queried).searchParams.get('modLoaderType'), '1');
  assert.equal(new URL('https://curseforge.test' + queried).searchParams.get('gameVersion'), '1.8.9');
  await cfCtx.searchCurseForgeContent('26.2', 'mods', 'fps');
  assert.equal(new URL('https://curseforge.test' + queried).searchParams.get('modLoaderType'), '4');
  vm.runInContext(snippet('async function prepareClient(', '\n// ---------------------------\n// Content manager'), ctx);
  const forge = await ctx.prepareClient('1.8.9');
  assert.equal(forge.loader, 'forge');
  assert.equal(forge.fabricApiVersion, null);
  assert.equal(forge.forgeVersion, FORGE_VERSION);
}

async function exerciseActualPlayHandler() {
  const callbacks = new Map();
  const child = new EventEmitter(); child.pid = 18189; child.exitCode = null;
  const launcher = new EventEmitter();
  let optsSeen;
  launcher.launch = async opts => { optsSeen = opts; launcher.emit('arguments', ['-Xmx8G', '-cp', 'forge.jar', 'net.minecraft.launchwrapper.Launch', '--username', 'Tester']); return child; };
  const emitted = [];
  const ctx = vm.createContext({
    process: { platform: 'win32' },
    ipcMain: { handle: (name, handler) => callbacks.set(name, handler) }, launcher,
    loadSettings: async () => ({ selectedGameVersion: '1.8.9', selectedAccountId: 'account', accounts: [{ id: 'account' }],
      minRamGb: 2, maxRamGb: 8, java8Path: 'C:/Java8/java.exe', theme: 'classic', serverAddress: 'play.example.net:25570' }),
    saveSettings: async () => {}, normalizeGameVersion: v => minecraftVersion(v),
    getClientProfile: () => ({ javaMajor:8, loader:'forge' }), javaSettingsKey: major => major === 8 ? 'java8Path' : 'java25Path',
    inspectJava: async () => ({ok:true}), ensureManagedJava: async () => '/mock/java8',
    createLogWindow: () => {}, ensureSharedDataForVersion: async () => {},
    prepareClient: async () => ({ loader:'forge', forgePath:'C:/forge/forge-universal.jar' }),
    getMinecraftSession: async () => ({ token:'redacted' }), toMclcAuthorization: () => ({ token:'redacted' }),
    getInstanceRoot: v => `C:/minecraft/instances/${v}`, normalizeSatelliteServerAddress: v => v,
    minecraftVersion, isMinecraft263, getCustomLaunchArguments, normalizeCustomJvmArgs, enforceFinalJvmArguments,
    bindLauncherEvents: () => {}, send: (name, body) => emitted.push({ name, ...body }),
    sendSatellitePresence: async () => {}, showNativeNotification: () => {},
    installDownloadedUpdateWhenSafe: () => {},
    mainWindow: { isDestroyed: () => false, isVisible: () => true, show:()=>{}, hide:()=>{} },
    updateInstallPending: false, updateInstallStarting: false,
    backgroundForUpdate: false, updateDownloadInProgress: false,
    gameLaunchInProgress: false, activeGameProcess: null, activeGameVersion: null, activeGameServerAddress: null,
    log: () => {}, setTimeout
  });
  vm.runInContext(snippet("ipcMain.handle('game:launch'", "\nipcMain.handle('notifications:permission-help'"), ctx);
  assert.equal((await callbacks.get('game:launch')(null, {})).ok, true);
  assert.equal(optsSeen.version.number, '1.8.9');
  assert.equal(optsSeen.version.custom, undefined);
  assert.equal(optsSeen.forge, 'C:/forge/forge-universal.jar');
  assert.equal(optsSeen.javaPath, 'C:/Java8/java.exe');
  assert.equal(optsSeen.quickPlay.type, 'legacy');
  assert.equal(optsSeen.quickPlay.identifier, 'play.example.net:25570');
  assert.equal(optsSeen.memory.max, '8G');
  assert.equal(optsSeen.memory.min, '2G');
  assert.equal(optsSeen.overrides.url.mavenForge, 'https://maven.minecraftforge.net/');
  assert.equal(ctx.activeGameProcess, child);
  assert.equal(child.listenerCount('exit'), 1);
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.activeGameProcess, null);
  assert(emitted.some(e => e.name === 'game-state' && e.state === 'stopped'));
}

(async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'spector-v1659-'));
  try {
    await exerciseForgeInstallerAndMod(temp);
    await exerciseLoaderRouting();
    await exerciseActualPlayHandler();
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
  console.log('[v1.6.59] PASS: Forge universal SHA1/JAR verification, verified reuse, invalid downloads preserved, Forge mod JAR, legacy endpoint, no Fabric API, Java8, 1.8.9 Modrinth/CurseForge filters, Play process tracking, all original editions retained.');
})().catch(error => { console.error(error); process.exitCode = 1; });
