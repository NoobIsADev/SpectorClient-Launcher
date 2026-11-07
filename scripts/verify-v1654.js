'use strict';
// SpectorClient Launcher v1.6.54: verify JVM placement at the real Play IPC
// boundary and within the original, mutable MCLC spawn argument array.
// This is an offline source/behavior test, not a claim of a live Minecraft run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  minecraftVersion, isMinecraft263, getCustomLaunchArguments,
  enforceFinalJvmArguments, normalizeCustomJvmArgs
} = require('../src/launch-jvm');
const pkg = require('../package.json');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
const shadow = /^-XX:StackShadowPages(?:=.*)?$/;

assert(Number(pkg.version.split('.')[2]) >= 54, 'Keep v1.6.54 Windows JVM checks in future releases');
assert(pkg.scripts['verify:ui'].includes('verify-v1653.js'));
assert(pkg.scripts['verify:ui'].includes('verify-v1654.js'));
assert(source.includes("launcher.on('arguments', onJavaArguments)"), 'Hook actual MCLC pre-spawn argv event');
assert(source.includes("launcher.removeListener('arguments', onJavaArguments)"), 'Unhook for every launch');
assert(source.includes('activeGameProcess = child'), 'Keep the original Java child process');
assert(source.includes('opts.customArgs = normalizeCustomJvmArgs'), 'JVM args must be set on the actual launch options');
assert(!/spawn\s*\(\s*javaExecutable/.test(source), 'No second Java process');

function verifyArgv(input, expected) {
  const argv = input.slice();
  const sameArray = argv;
  const result = enforceFinalJvmArguments(argv, { version: { number: '26.3', custom: 'fabric-loader-26.3' } });
  assert.equal(argv, sameArray, 'MCLC must receive mutations on the original argv object');
  const mainIndex = argv.indexOf(mainClass);
  const cpIndex = argv.indexOf('-cp');
  const flagIndex = argv.findIndex(s => shadow.test(String(s)));
  assert(mainIndex > cpIndex && cpIndex > flagIndex, 'JVM flag must precede -cp and Fabric main class');
  assert.equal(argv.filter(s => shadow.test(String(s))).length, 1, 'No stray duplicate in the entire command');
  assert.equal(argv[flagIndex], `-XX:StackShadowPages=${expected}`);
  assert.equal(result.pages, expected);
  assert.equal(result.mainClass, mainClass);
  assert.equal(result.mainClassIndex, mainIndex);
  assert.equal(result.flagIndex, flagIndex);
  assert.deepEqual(argv.slice(cpIndex, mainIndex + 1), ['-cp', 'lib/a.jar;lib/b.jar', mainClass], 'Preserve classpath and Fabric entrypoint');
  const first = argv.slice();
  enforceFinalJvmArguments(argv, { version: { number: '26.3' } });
  assert.deepEqual(argv, first, 'Applying twice must be idempotent');
  return { argv, result };
}

const base = ['-Xmx11G', '-Xms5G', '-Duser.property=hello world', '-XX:+UseG1GC', '-cp', 'lib/a.jar;lib/b.jar', mainClass, '--username', 'TestPlayer', '--gameDir', 'C:\\My Games\\Spector Client'];
let out = verifyArgv(base, 32);
assert(out.argv.includes('-Xmx11G') && out.argv.includes('-Xms5G'));
assert(out.argv.includes('-Duser.property=hello world'));
assert.deepEqual(out.argv.slice(-6), ['-cp', 'lib/a.jar;lib/b.jar', mainClass, '--username', 'TestPlayer', '--gameDir', 'C:\\My Games\\Spector Client'].slice(-6));

const low = ['-XX:StackShadowPages=0', '-XX:StackShadowPages=16', '-XX:StackShadowPages=oops'];
out = verifyArgv([...base.slice(0, 4), ...low, ...base.slice(4)], 32);
assert.equal(out.result.removed, 3);
out = verifyArgv([...base.slice(0, 4), '-XX:StackShadowPages=48', '-XX:StackShadowPages=32', ...base.slice(4)], 48);
assert.equal(out.result.removed, 2);
out = verifyArgv([...base.slice(0, 4), '-XX:StackShadowPages', '96', ...base.slice(4)], 96);
out = verifyArgv([...base, '-XX:StackShadowPages=64', '--server', 'example.org'], 64);
assert.equal(out.result.relocatedFromGameArgs, 1);
assert.deepEqual(out.argv.slice(-4), ['--gameDir', 'C:\\My Games\\Spector Client', '--server', 'example.org'], 'Only misplaced StackShadowPages gets removed from game args');
out = verifyArgv([...base.slice(0, 4), '-XX:StackShadowPages=48', ...base.slice(4), '-XX:StackShadowPages=128', '--fullscreen'], 128);
assert.equal(out.result.relocatedFromGameArgs, 1);
assert(out.argv.includes('--fullscreen'));

// Matrix of deterministic malformed, low, high and duplicated values across
// both JVM and game segments. Preserve max and isolate every other token.
for (let n = 0; n < 120; n += 1) {
  const jvmN = (n * 19) % 96;
  const gameN = (n * 73) % 160;
  const sourceArgs = [...base.slice(0, 4), `-XX:StackShadowPages=${jvmN}`, '-Dunrelated=true', ...base.slice(4), '--server', 'mc.example.test', `-XX:StackShadowPages=${gameN}`];
  const expected = Math.max(32, jvmN, gameN);
  const { argv } = verifyArgv(sourceArgs, expected);
  assert(argv.includes('-Dunrelated=true'));
  assert.deepEqual(argv.slice(-2), ['--server', 'mc.example.test']);
}

for (const version of ['1.21.11', '26.2']) {
  const original = [...base, '-XX:StackShadowPages=7'];
  const command = original.slice();
  assert.equal(enforceFinalJvmArguments(command, { version: { number: version, custom: 'fabric-loader-26.3' } }).applied, false);
  assert.deepEqual(command, original, `Do not modify ${version} arguments`);
  assert.deepEqual(normalizeCustomJvmArgs(['-XX:StackShadowPages=7'], version), ['-XX:StackShadowPages=7']);
}
assert.equal(minecraftVersion('SpectorClient 26.3'), '26.3');
assert.equal(isMinecraft263({ version: { number: '26.3', name: 'SpectorClient 26.2' } }), true);
assert.equal(isMinecraft263({ version: { number: '26.2', name: 'SpectorClient 26.3' } }), false);
for (const malformed of [
  ['-Xmx4G', mainClass],
  ['-Xmx4G', '-cp', 'libraries.jar'],
  ['-Xmx4G', '-cp', '', mainClass]
]) {
  const untouched = malformed.slice();
  assert.throws(() => enforceFinalJvmArguments(malformed, { version: { number: '26.3' } }), /classpath|main class/i);
  assert.deepEqual(malformed, untouched, 'Do not mutate invalid commands');
}

const saved = {
  selectedLaunchProfileId: 'profile-263',
  savedProfiles: { 'profile-263': {
    name: 'SpectorClient 26.3', jvmArgs: '-Dplayer.note="hello world" -XX:StackShadowPages=48',
    gameArguments: '--server play.example.org -XX:StackShadowPages=64'
  } },
  customArgs: '-XX:StackShadowPages=12 -Dcolor=blue',
  gameArgs: '--width 900'
};
assert.deepEqual(getCustomLaunchArguments(saved), {
  jvm: ['-Dplayer.note=hello world', '-XX:StackShadowPages=48', '-XX:StackShadowPages=12', '-Dcolor=blue', '-XX:StackShadowPages=64'],
  game: ['--server', 'play.example.org', '--width', '900']
});

// Execute the real game:launch IPC body from main.js against a mock MCLC API.
// Mock MCLC emits its actual argv and records the same array at the simulated
// spawn boundary; it does not launch or wrap another game process.
const start = source.indexOf("ipcMain.handle('game:launch'");
const end = source.indexOf("\nipcMain.handle('notifications:permission-help'", start);
assert(start > -1 && end > start);
const playHandler = source.slice(start, end);
async function runPlay(version, { conf = {}, extraJvm = [], extraGame = [], dropClasspath = false } = {}) {
  const handlers = new Map();
  const messages = [];
  const logLines = [];
  const client = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 6001;
  child.exitCode = null;
  let spawned = false;
  let processArgs = null;
  let options = null;
  client.launch = async opts => {
    options = opts;
    const command = ['-XX:-OmitStackTraceInFastThrow', `-Xmx${opts.memory.max}`, `-Xms${opts.memory.min}`, ...extraJvm, ...opts.customArgs,
      ...(dropClasspath ? [mainClass] : ['-cp', 'lib/a.jar;lib/b.jar', mainClass]),
      ...opts.customLaunchArgs, ...extraGame, '--version', opts.version.number];
    client.emit('arguments', command);
    spawned = true;
    processArgs = command;
    return child;
  };
  const settings = {
    selectedGameVersion: version, selectedAccountId: 'account-1', accounts: [{ id: 'account-1', name: 'Test' }],
    minRamGb: 7, maxRamGb: 14, java25Path: 'mock-java25', java21Path: 'mock-java21',
    width: 1280, height: 720, theme: 'classic', ...conf
  };
  const scope = {
    process: { platform: 'win32' }, // Simulated Windows launch path
    ipcMain: { handle: (name, f) => handlers.set(name, f) }, launcher: client,
    mainWindow: { isDestroyed: () => false, isVisible: () => true, show: () => {}, hide: () => {} },
    loadSettings: async () => settings, saveSettings: async () => {},
    minecraftVersion, isMinecraft263, getCustomLaunchArguments, normalizeCustomJvmArgs, enforceFinalJvmArguments,
    normalizeGameVersion: v => ['1.21.11', '26.2', '26.3'].includes(minecraftVersion(v)) ? minecraftVersion(v) : '26.2',
    getClientProfile: v => ({ javaMajor: minecraftVersion(v) === '1.21.11' ? 21 : 25 }),
    javaSettingsKey: v => v === 21 ? 'java21Path' : 'java25Path',
    inspectJava: async () => ({ ok: true }), ensureManagedJava: async major => `mock-java${major}`,
    createLogWindow: () => {}, ensureSharedDataForVersion: async () => {},
    prepareClient: async v => ({ versionId: `fabric-loader-test-${v}` }),
    getMinecraftSession: async () => ({ token: '<redacted>' }), toMclcAuthorization: () => ({ token: '<redacted>' }),
    getInstanceRoot: v => `instances/${v}`, normalizeSatelliteServerAddress: x => x || null,
    bindLauncherEvents: () => {}, send: (type, payload) => messages.push({ type, ...payload }),
    sendSatellitePresence: async () => {}, showNativeNotification: () => {},
    installDownloadedUpdateWhenSafe: () => {},
    gameLaunchInProgress: false, activeGameProcess: null, activeGameVersion: null, activeGameServerAddress: null,
    updateInstallPending: false, updateInstallStarting: false, backgroundForUpdate: false, updateDownloadInProgress: false,
    setTimeout, log: value => logLines.push(value)
  };
  vm.runInNewContext(playHandler, scope, { filename: 'main.js:game:launch' });
  let result;
  let launchError;
  try { result = await handlers.get('game:launch')(null, {}); }
  catch (error) { launchError = error; }
  assert.equal(client.listenerCount('arguments'), 0, 'Clear pre-spawn hook even on failed launch');
  if (dropClasspath && minecraftVersion(version) === '26.3') {
    assert(launchError && /classpath|Java command|JVM arguments/i.test(launchError.message), 'Reject invalid 26.3 commands before spawn');
    assert.equal(spawned, false, 'Fail closed when an unverified Java command is emitted');
    assert.equal(scope.activeGameProcess, null);
    assert(messages.some(m => m.type === 'game-state' && m.state === 'error'));
    return { result, messages, logLines, options };
  }
  if (launchError) throw launchError;
  assert.equal(result.ok, true);
  assert(spawned);
  assert.equal(scope.activeGameProcess, child, 'Original Minecraft process is tracked');
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(options.memory.min, '7G');
  assert.equal(options.memory.max, '14G');
  assert.equal(options.version.number, minecraftVersion(version));
  assert(options.version.custom.includes('fabric-loader'));
  assert(processArgs.includes('-Xmx14G'));
  assert(processArgs.includes('-Xms7G'));
  assert(processArgs.includes('--version'));
  if (minecraftVersion(version) === '26.3') {
    assert.equal(processArgs.filter(v => shadow.test(String(v))).length, 1);
    assert(processArgs.findIndex(v => shadow.test(String(v))) < processArgs.indexOf('-cp'));
    assert(logLines.some(s => s.includes('Verified Minecraft 26.3 Java argv:') && s.includes('before main class')),
      'Log exact flag placement for support diagnostics');
  } else {
    assert(!processArgs.some(v => /-XX:StackShadowPages=32/.test(String(v))), 'No injected JVM change for old versions');
  }
  child.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scope.activeGameProcess, null);
  assert(messages.some(m => m.type === 'game-state' && m.state === 'stopped'));
  return { result, messages, logLines, processArgs, options };
}

async function run() {
  let result = await runPlay('26.3');
  assert(result.processArgs.includes('-XX:StackShadowPages=32'));
  result = await runPlay('SpectorClient 26.3', {
    conf: saved, extraJvm: ['-XX:StackShadowPages=16', '-XX:+UseZGC'],
    extraGame: ['--quickPlayMultiplayer', 'example.org', '-XX:StackShadowPages=80']
  });
  assert(result.processArgs.includes('-XX:StackShadowPages=80'));
  assert(result.processArgs.includes('-Dplayer.note=hello world'));
  assert(result.processArgs.includes('-XX:+UseZGC'));
  assert(result.processArgs.includes('--quickPlayMultiplayer'));
  assert(result.processArgs.includes('example.org'));
  assert(result.logLines.some(s => s.includes('moved 1 misplaced flag(s)')));
  for (const version of ['26.2', '1.21.11']) {
    result = await runPlay(version, { extraJvm: ['-XX:StackShadowPages=12'] });
    assert(result.processArgs.includes('-XX:StackShadowPages=12'));
    assert.deepEqual(Array.from(result.options.customArgs), []);
  }
  await runPlay('26.3', { dropClasspath: true });
  console.log('PASS: v1.6.54 verified 26.3 final Java argv, saved and late JVM conflicts, Fabric main class and cp ordering, original child process, preserved RAM and game args, unchanged older versions; 120 exhaustive test combinations.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
