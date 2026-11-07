'use strict';
// v1.6.55: Exercise the ACTUAL Play IPC handler with a mocked MCLC emitter.
// Windows 26.3 must enforce one safe JVM flag. Linux/macOS must use the
// unchanged pre-v1.6.53 argv configuration, even with saved profile data.
// This is an offline regression test; it does not launch Minecraft or Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  minecraftVersion, isMinecraft263, getCustomLaunchArguments,
  normalizeCustomJvmArgs, enforceFinalJvmArguments
} = require('../src/launch-jvm');
const pkg = require('../package.json');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const main = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
const shadow = /^-XX:StackShadowPages(?:=.*)?$/;

assert.equal(pkg.version, '1.6.55');
assert(pkg.scripts['verify:ui'].includes('verify-v1655.js'));
assert(source.includes("process.platform === 'win32' && isMinecraft263(opts)"), 'OS gate must guard actual Minecraft version');
assert(source.includes('if (useWindows263StackShadow) launcher.on('), 'Pre-spawn mutation must be Windows-only');
assert(source.includes('if (useWindows263StackShadow) launcher.removeListener('), 'Unhook only an attached Windows listener');
assert(source.includes('if (useWindows263StackShadow && !finalJvmVerified)'), 'Verification must be Windows-only');
assert(source.includes('activeGameProcess = child'), 'Do not replace original child process');

const start = source.indexOf("ipcMain.handle('game:launch'");
const end = source.indexOf("\nipcMain.handle('notifications:permission-help'", start);
assert(start >= 0 && end > start, 'Must extract the production Play handler');
const playHandler = source.slice(start, end);

const savedSettings = {
  selectedLaunchProfileId: 'test-saved',
  savedProfiles: { 'test-saved': {
    id: 'test-saved', name: 'SpectorClient 26.3',
    jvmArgs: '-Dprofile=kept -XX:StackShadowPages=48',
    gameArguments: '--testSavedGameFlag persisted'
  } },
  customArgs: ['-XX:StackShadowPages=12', '-Dglobal=kept'],
  customLaunchArgs: ['--testGlobalGameFlag', 'present']
};

async function play(platform, version, { saved = false, extraJvm = [], extraGame = [], failClasspath = false } = {}) {
  const callbacks = new Map();
  const emitted = [];
  const logs = [];
  const client = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 95005;
  child.exitCode = null;
  let argsSeenAtSpawn;
  let inputOptions;
  let listenersAtSpawn;
  let launchCount = 0;
  const baselineSystemJVM = platform === 'darwin' ? '-XstartOnFirstThread' : platform === 'linux' ? '-Xss1M' : '-Dwin32=true';
  client.launch = async opts => {
    inputOptions = opts;
    const argv = [
      '-XX:-OmitStackTraceInFastThrow',
      `-Xmx${opts.memory.max}`, `-Xms${opts.memory.min}`,
      baselineSystemJVM,
      ...extraJvm, ...opts.customArgs,
      ...(failClasspath ? [main] : ['-cp', 'fabric.jar', main]),
      ...opts.customLaunchArgs, ...extraGame,
      '--username', 'TestAccount'
    ];
    listenersAtSpawn = client.listenerCount('arguments');
    client.emit('arguments', argv); // Same mutable final argv that MCLC spawns.
    argsSeenAtSpawn = argv;
    launchCount += 1;
    return child;
  };
  const config = {
    selectedGameVersion: version,
    selectedAccountId: 'account-1', accounts: [{ id: 'account-1' }],
    minRamGb: 4, maxRamGb: 12, width: 1280, height: 720,
    java21Path: '/mock/java21', java25Path: '/mock/java25',
    theme: 'classic', ...(saved ? savedSettings : {})
  };
  const scope = {
    process: { platform },
    ipcMain: { handle: (id, callback) => callbacks.set(id, callback) },
    launcher: client,
    loadSettings: async () => config, saveSettings: async () => {},
    normalizeGameVersion: value => {
      const normalized = minecraftVersion(value);
      return ['1.21.11','26.2','26.3'].includes(normalized) ? normalized : '26.2';
    },
    getClientProfile: v => ({ javaMajor: minecraftVersion(v) === '1.21.11' ? 21 : 25 }),
    javaSettingsKey: major => major === 21 ? 'java21Path' : 'java25Path',
    inspectJava: async () => ({ ok: true }), ensureManagedJava: async major => `/mock/java${major}`,
    createLogWindow: () => {}, ensureSharedDataForVersion: async () => {},
    prepareClient: async v => ({ versionId: `fabric-loader-test-${v}` }),
    getMinecraftSession: async () => ({ access_token: '<redacted>' }),
    toMclcAuthorization: () => ({ token: '<redacted>' }),
    getInstanceRoot: v => `/instances/${v}`,
    normalizeSatelliteServerAddress: x => x || null,
    minecraftVersion, isMinecraft263, getCustomLaunchArguments,
    normalizeCustomJvmArgs, enforceFinalJvmArguments,
    bindLauncherEvents: () => {},
    send: (type, payload) => emitted.push({ type, ...payload }),
    sendSatellitePresence: async () => {}, showNativeNotification: () => {},
    installDownloadedUpdateWhenSafe: () => {},
    mainWindow: { isDestroyed: () => false, isVisible: () => true, show: () => {}, hide: () => {} },
    gameLaunchInProgress: false, activeGameProcess: null, activeGameVersion: null, activeGameServerAddress: null,
    updateInstallPending: false, updateInstallStarting: false,
    backgroundForUpdate: false, updateDownloadInProgress: false,
    log: m => logs.push(m), setTimeout
  };
  vm.runInNewContext(playHandler, scope, { filename: 'main.js:game:launch' });
  assert(callbacks.has('game:launch'));
  let result, error;
  try { result = await callbacks.get('game:launch')(null, {}); }
  catch (e) { error = e; }
  const windows263 = platform === 'win32' && minecraftVersion(version) === '26.3';
  if (failClasspath && windows263) {
    assert(error && /classpath|JVM arguments/.test(error.message), 'Windows must reject malformed Java argv');
    assert.equal(launchCount, 0, 'Windows must reject before Java spawn');
    assert.equal(scope.activeGameProcess, null);
    assert.equal(client.listenerCount('arguments'), 0);
    return;
  }
  if (error) throw error;
  assert.equal(result.ok, true);
  assert.equal(launchCount, 1);
  assert.equal(scope.activeGameProcess, child, 'Must track original MCLC child, not a wrapper');
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(scope.gameLaunchInProgress, false);
  assert.equal(inputOptions.version.number, minecraftVersion(version), 'Actual version wins over saved profile name');
  assert.equal(inputOptions.version.custom, `fabric-loader-test-${minecraftVersion(version)}`);
  assert.equal(inputOptions.memory.min, '4G');
  assert.equal(inputOptions.memory.max, '12G');
  assert.equal(argsSeenAtSpawn[1], '-Xmx12G');
  assert.equal(argsSeenAtSpawn[2], '-Xms4G');
  assert.equal(argsSeenAtSpawn[3], baselineSystemJVM, 'Native platform JVM flags are retained');
  assert(argsSeenAtSpawn.includes('--username'));
  assert.equal(client.listenerCount('arguments'), 0, 'No stale pre-spawn hook');
  assert.equal(listenersAtSpawn, windows263 ? 1 : 0, 'Only Windows 26.3 may inspect/mutate argv');
  if (windows263) {
    const allFlags = argsSeenAtSpawn.filter(v => shadow.test(String(v)));
    assert.equal(allFlags.length, 1, 'One JVM StackShadowPages flag in whole command');
    const pages = Number(allFlags[0].split('=')[1]);
    assert(pages >= 32);
    assert(argsSeenAtSpawn.indexOf(allFlags[0]) < argsSeenAtSpawn.indexOf('-cp'));
    assert(logs.some(s => String(s).includes('Verified Minecraft 26.3 Java argv')));
    if (saved) {
      assert.equal(pages, 48, 'Higher saved profile setting wins');
      assert(argsSeenAtSpawn.includes('-Dprofile=kept'));
      assert(argsSeenAtSpawn.includes('-Dglobal=kept'));
      assert(argsSeenAtSpawn.includes('--testSavedGameFlag'));
      assert(argsSeenAtSpawn.includes('--testGlobalGameFlag'));
    } else {
      assert.equal(pages, 32);
    }
  } else {
    // Exact v1.6.52 options: empty custom JVM and game args, no extra flag.
    assert.deepEqual(Array.from(inputOptions.customArgs), []);
    assert.deepEqual(Array.from(inputOptions.customLaunchArgs), []);
    assert(!logs.some(s => String(s).includes('Verified Minecraft 26.3 Java argv')));
    assert.deepEqual(argsSeenAtSpawn, [
      '-XX:-OmitStackTraceInFastThrow', '-Xmx12G', '-Xms4G',
      baselineSystemJVM, ...extraJvm,
      ...(failClasspath ? [main] : ['-cp', 'fabric.jar', main]),
      ...extraGame, '--username', 'TestAccount'
    ], 'Linux/macOS and older versions must not alter the original MCLC command');
  }
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scope.activeGameProcess, null, 'Exit must clear the original process');
  assert(emitted.some(e => e.type === 'game-state' && e.state === 'stopped'), 'Exit must be reported');
}

async function run() {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const version of ['1.21.11','26.2','26.3','SpectorClient 26.3']) {
      await play(platform, version);
      await play(platform, version, { saved: true });
      await play(platform, version, { saved: true, extraJvm: ['-XX:StackShadowPages=16', '-XX:+UseG1GC'], extraGame: ['--server', 'example.org'] });
    }
  }
  // On macOS/Linux, even a malformed command passes through untouched as it
  // did before v1.6.53. On Windows 26.3, fail closed instead of spawning.
  await play('win32', '26.3', { failClasspath: true });
  await play('linux', '26.3', { failClasspath: true, saved: true });
  await play('darwin', '26.3', { failClasspath: true, saved: true });
  console.log('PASS: v1.6.55 Windows-only StackShadowPages; Linux/macOS pre-v1.6.53 JVM defaults; actual Fabric Play handler, saved profiles, 1.21.11/26.2/26.3, RAM/game flags, original child and exit tracking (39 runs).');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
