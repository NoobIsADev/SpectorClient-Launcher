'use strict';
// SpectorClient Launcher v1.6.53: test the real Play-button IPC handler with a
// mocked MCLC process, and verify command-line mutation at the spawn boundary.
// No network, Microsoft login, Electron, or real Minecraft installation needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  minecraftVersion,
  isMinecraft263,
  splitCommandLine,
  getCustomLaunchArguments,
  normalizeCustomJvmArgs,
  enforceFinalJvmArguments
} = require('../src/launch-jvm');
const pkg = require('../package.json');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

assert(Number(pkg.version.split('.')[2]) >= 53, 'Keep v1.6.53 Play-path JVM fix in later releases');
assert(pkg.scripts['verify:ui'].includes('verify-v1652.js'), 'Keep earlier downloader regression tests');
assert(pkg.scripts['verify:ui'].includes('verify-v1653.js'), 'Run launch-argument regression tests');
assert(mainSource.includes("require('./launch-jvm')"), 'Use launch JVM helper in actual Electron main process');
assert(mainSource.includes("launcher.on('arguments', onJavaArguments)"), 'Enforce the final JVM command in the real launch path');
assert(mainSource.includes("launcher.removeListener('arguments', onJavaArguments)"), 'Release launch-scoped listeners');
assert(mainSource.includes('activeGameProcess = child'), 'Retain original spawned process tracking');

// Unit checks: no flag, low, repeated, invalid, high and split legacy flag.
function checkArgs(version, input, expected, other = []) {
  const original = [...input, '-cp', 'libs', 'net.fabricmc.loader.impl.launch.knot.KnotClient', '--username', 'Test'];
  const args = original.slice();
  const result = enforceFinalJvmArguments(args, { version: { number: version, custom: 'fabric-loader-any-name' } });
  const prefix = args.slice(0, args.indexOf('-cp'));
  const flags = prefix.filter(s => /^-XX:StackShadowPages(?:=.*)?$/.test(s));
  if (expected === null) {
    assert.equal(result.applied, false);
    assert.deepEqual(args, original, `Do not alter Minecraft ${version}`);
  } else {
    assert.equal(result.applied, true);
    assert.deepEqual(flags, [`-XX:StackShadowPages=${expected}`]);
    assert.deepEqual(prefix.filter(x => !x.startsWith('-XX:StackShadowPages')), other);
    assert.deepEqual(args.slice(-2), ['--username', 'Test'], 'Do not rewrite game arguments');
    assert(args.indexOf(`-XX:StackShadowPages=${expected}`) < args.indexOf('-cp'), 'JVM flag must be before the main class');
  }
}
checkArgs('26.3', [], 32);
checkArgs('26.3', ['-Xmx8G', '-XX:StackShadowPages=8', '-Dfoo=bar'], 32, ['-Xmx8G', '-Dfoo=bar']);
checkArgs('26.3', ['-XX:StackShadowPages=128', '-XX:StackShadowPages=16', '-XX:+UseG1GC'], 128, ['-XX:+UseG1GC']);
checkArgs('26.3', ['-XX:StackShadowPages', '16', '-XX:StackShadowPages=oops'], 32);
checkArgs('26.2', ['-XX:StackShadowPages=8', '-Xmx8G'], null);
checkArgs('1.21.11', ['-Xmx4G'], null);
const noSeparator = ['-Xmx6G', 'net.fabricmc.loader.impl.launch.knot.KnotClient'];
assert.throws(() => enforceFinalJvmArguments(noSeparator, { version: { number: '26.3' } }), /classpath\/main-class boundary/);
assert.deepEqual(noSeparator, ['-Xmx6G', 'net.fabricmc.loader.impl.launch.knot.KnotClient'], 'Failed validation must not modify the command');
assert.equal(minecraftVersion('SpectorClient 26.3'), '26.3', 'Recognize exact legacy saved profile label');
assert.equal(minecraftVersion('SpectorClient 1.21.11'), '1.21.11');
assert.equal(minecraftVersion({ number: '26.3', name: 'SpectorClient 26.2' }), '26.3', 'Version number beats profile display name');
assert.equal(isMinecraft263({ version: { number: '26.2', custom: 'fabric-loader-26.3' } }), false, 'Use actual version.number, not Fabric/profile name');
assert.equal(isMinecraft263({ version: { number: '26.3', custom: 'SpectorClient 1.21.11' } }), true);
assert.deepEqual(splitCommandLine('-Xss1M -Dmy.key="hello world" -XX:StackShadowPages=16'), ['-Xss1M', '-Dmy.key=hello world', '-XX:StackShadowPages=16']);
assert.deepEqual(normalizeCustomJvmArgs(['-XX:StackShadowPages=64', '-XX:StackShadowPages=16', '-Dkey=hello world'], '26.3'), ['-Dkey=hello world', '-XX:StackShadowPages=64']);
assert.deepEqual(normalizeCustomJvmArgs(['-XX:StackShadowPages=16'], '26.2'), ['-XX:StackShadowPages=16']);
const saved = {
  selectedProfileId: 'saved-26.3',
  profiles: [{ id: 'saved-26.3', name: 'SpectorClient 26.3', javaArgs: '-Dsession.name="test profile" -XX:StackShadowPages=48', gameArguments: ['--demo'] }],
  customArgs: ['-XX:StackShadowPages=16', '-Dcustom.entry=kept'],
  customLaunchArgs: ['--testGameArg', 'value']
};
assert.deepEqual(getCustomLaunchArguments(saved), {
  jvm: ['-Dsession.name=test profile', '-XX:StackShadowPages=48', '-XX:StackShadowPages=16', '-Dcustom.entry=kept'],
  game: ['--demo', '--testGameArg', 'value']
});
const misplaced = getCustomLaunchArguments({ gameArgs: '--demo -XX:StackShadowPages=72 --server example.net' });
assert.deepEqual(misplaced.jvm, ['-XX:StackShadowPages=72'], 'Move wrongly stored JVM value into Java args');
assert.deepEqual(misplaced.game, ['--demo', '--server', 'example.net'], 'Keep real game args in place');

// Run the ACTUAL ipcMain game:launch handler from main.js in isolation.
// The installed MCLC 3.18.2 creates argv and emits 'arguments' immediately
// before spawn. Our stub replicates that event contract and returns the SAME
// child object, so process tracking and exit reporting are exercised as well.
const start = mainSource.indexOf("ipcMain.handle('game:launch'");
const end = mainSource.indexOf("\nipcMain.handle('notifications:permission-help'", start);
assert(start > -1 && end > start, 'Cannot locate original Play handler');
const actualPlayHandlerSource = mainSource.slice(start, end);

async function simulatePlay({ gameVersion, input = {}, profile = null, extraGeneratedJVM = [], withBoundary = true }) {
  const hooks = new Map();
  const emitted = [];
  const javaLogs = [];
  const client = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 2345;
  child.exitCode = null;
  let launched = false;
  let usedOptions;
  let actualArgs;
  client.launch = async options => {
    launched = true;
    usedOptions = options;
    actualArgs = [
      '-XX:-OmitStackTraceInFastThrow',
      `-Xmx${options.memory.max}`,
      `-Xms${options.memory.min}`,
      ...extraGeneratedJVM,
      ...options.customArgs,
      ...(withBoundary ? ['-cp', 'libraries/path', 'net.fabricmc.loader.impl.launch.knot.KnotClient'] : ['net.fabricmc.loader.impl.launch.knot.KnotClient']),
      ...options.customLaunchArgs,
      '--version',
      options.version.number
    ];
    client.emit('arguments', actualArgs);
    return child;
  };
  const config = {
    selectedGameVersion: gameVersion, selectedAccountId: 'user-1',
    accounts: [{ id: 'user-1', name: 'Test User' }], minRamGb: 5, maxRamGb: 11,
    java25Path: '/mock/java25', java21Path: '/mock/java21',
    theme: 'classic', width: 900, height: 600,
    ...profile
  };
  const mainWindow = { isDestroyed: () => false, isVisible: () => true, show: () => {}, hide: () => {} };
  const scope = {
    ipcMain: { handle: (name, fn) => hooks.set(name, fn) },
    app: {}, launcher: client, mainWindow, log: (s) => javaLogs.push(s),
    loadSettings: async () => config, saveSettings: async () => {},
    getClientProfile: value => ({ javaMajor: minecraftVersion(value) === '1.21.11' ? 21 : 25 }),
    javaSettingsKey: major => Number(major) === 21 ? 'java21Path' : 'java25Path',
    normalizeGameVersion: value => {
      const v = minecraftVersion(value);
      return ['26.2','26.3','1.21.11'].includes(v) ? v : '26.2';
    },
    isMinecraft263, getCustomLaunchArguments, normalizeCustomJvmArgs, enforceFinalJvmArguments,
    createLogWindow: () => {}, inspectJava: async () => ({ ok: true }),
    ensureManagedJava: async major => `/mock/java${major}`,
    ensureSharedDataForVersion: async () => {},
    prepareClient: async version => ({ versionId: `fabric-loader-0.19.0-${version}` }),
    getMinecraftSession: async () => ({ token: 'redacted' }),
    toMclcAuthorization: () => ({ token: 'redacted' }),
    getInstanceRoot: version => `/mock/instances/${version}`,
    normalizeSatelliteServerAddress: s => s || null,
    bindLauncherEvents: () => {}, send: (type, obj) => emitted.push({ type, ...obj }),
    sendSatellitePresence: async () => {}, showNativeNotification: () => {},
    installDownloadedUpdateWhenSafe: () => {}, isMinecraftRunning: () => false,
    gameLaunchInProgress: false, activeGameProcess: null, activeGameVersion: null, activeGameServerAddress: null,
    updateInstallPending: false, updateInstallStarting: false,
    backgroundForUpdate: false, updateDownloadInProgress: false,
    setTimeout
  };
  vm.runInNewContext(actualPlayHandlerSource, scope, { filename: 'src/main.js:game:launch' });
  const handler = hooks.get('game:launch');
  assert.equal(typeof handler, 'function');
  const result = await handler(null, input);
  assert.equal(result.ok, true);
  assert.equal(launched, true, 'Launch must reach the real Play handler');
  assert.equal(scope.activeGameProcess, child, 'Track actual Java process without wrapper or respawn');
  assert.equal(scope.gameLaunchInProgress, false);
  assert.equal(child.listenerCount('exit'), 1, 'Attach original exit listener');
  assert.equal(client.listenerCount('arguments'), 0, 'Remove command listener after launch');
  assert(emitted.some(x => x.type === 'game-state' && x.state === 'running'));
  const expected = minecraftVersion(gameVersion);
  assert.equal(usedOptions.version.number, expected);
  assert.equal(usedOptions.memory.min, '5G', 'Preserve configured RAM allocation');
  assert.equal(usedOptions.memory.max, '11G', 'Preserve configured RAM allocation');
  assert(usedOptions.version.custom.startsWith('fabric-loader-'), 'Still use the Fabric profile');
  if (expected === '26.3') {
    const prefix = actualArgs.slice(0, actualArgs.indexOf('-cp'));
    assert.equal(prefix.filter(x => /^-XX:StackShadowPages(?:=.*)?$/.test(x)).length, 1, 'Exactly one flag in actual Java argv');
    assert(actualArgs.indexOf('-XX:StackShadowPages=32') < actualArgs.indexOf('-cp') ||
           actualArgs.some(x => /^-XX:StackShadowPages=([3-9][0-9]|[1-9][0-9]{2,})$/.test(x)), 'Effective flag >= 32, before main class');
  }
  const gameArgumentsSnapshot = actualArgs.slice(actualArgs.indexOf('net.fabricmc.loader.impl.launch.knot.KnotClient') + 1);
  assert(gameArgumentsSnapshot.includes('--version'), 'Preserve game arguments');
  if (input.customLaunchArgs?.includes?.('--world')) {
    assert(gameArgumentsSnapshot.includes('--world'), 'Preserve user-specified game args');
  }
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scope.activeGameProcess, null, 'Original process exit clears launcher state');
  assert(emitted.some(x => x.type === 'game-state' && x.state === 'stopped'));
  return { actualArgs, usedOptions, javaLogs };
}

async function run() {
  let result = await simulatePlay({ gameVersion: '26.3' });
  assert(result.actualArgs.includes('-XX:StackShadowPages=32'), 'Default first-run 26.3 gets 32');
  result = await simulatePlay({
    gameVersion: 'SpectorClient 26.3',
    profile: saved,
    input: { customLaunchArgs: ['--world', 'My World'] },
    extraGeneratedJVM: ['-XX:StackShadowPages=16']
  });
  assert(result.actualArgs.includes('-XX:StackShadowPages=48'), 'Higher saved profile setting takes precedence over low values');
  assert(result.actualArgs.includes('-Dsession.name=test profile'), 'Preserve saved profile JVM properties');
  assert(result.actualArgs.includes('-Dcustom.entry=kept'), 'Preserve other custom JVM settings');
  assert(result.actualArgs.includes('--world'), 'Preserve game flags');
  result = await simulatePlay({ gameVersion: '26.3', extraGeneratedJVM: ['-XX:StackShadowPages=128', '-XX:+UseZGC'] });
  assert(result.actualArgs.includes('-XX:StackShadowPages=128'), 'Preserve higher value injected by launch library');
  assert(result.actualArgs.includes('-XX:+UseZGC'), 'Preserve other JVM flags');
  for (const version of ['26.2', '1.21.11']) {
    result = await simulatePlay({ gameVersion: version, extraGeneratedJVM: ['-XX:StackShadowPages=12'] });
    assert(result.actualArgs.includes('-XX:StackShadowPages=12'), `${version} JVM args must stay unchanged`);
    assert.deepEqual(Array.from(result.usedOptions.customArgs), [], `${version} must retain previous launcher behavior`);
  }
  console.log('PASS: v1.6.53 Play IPC builds original Fabric launch, 26.3 JVM argument exactly once before main class; saved profiles, custom flags, RAM, game args, process exit tracking, 26.2/1.21.11 untouched.');
}
run().catch(err => { console.error(err); process.exitCode = 1; });
