const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { Authflow } = require('prismarine-auth');
const { Client } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');
const WebSocket = require('ws');

// Keep only one SpectorClient process alive. Multiple launcher processes can
// keep files in the install directory locked and make an in-place update fail.
// A second launch focuses the existing window instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const PRODUCT_NAME = 'SpectorClient';
const WINDOWS_APP_ID = 'client.spector.launcher';
const WINDOWS_TOAST_CLSID = '{7C0F70F8-9A1B-4A7E-8C1E-7D2AF30F6C91}';
const DEFAULT_GAME_VERSION = '26.2';
const CLIENT_PROFILES = Object.freeze({
  '26.2': { label: 'SpectorClient 26.2', modUrl: 'https://spectorclient.com/mod/download', javaMajor: 25 },
  '26.3': { label: 'SpectorClient 26.3', modUrl: 'https://spectorclient.com/mod/download/26.3', javaMajor: 25 },
  '1.21.11': { label: 'SpectorClient 1.21.11', modUrl: 'https://spectorclient.com/mod/download/1.21.11', javaMajor: 21 }
});
const SPECTOR_MOD_FILENAME = 'spectorclient.jar';
const LEGACY_SPECTOR_MOD_FILENAMES = ['spectorclient-1.0.0.jar'];
const BRAND_IMAGE_URL = 'https://i.imgur.com/nP9aVFe.png';
const BRAND_IMAGE_PATH = path.join(__dirname, 'assets', 'spector-logo.png');
const FABRIC_API_PROJECT = 'fabric-api';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const CURSEFORGE_WEB_API = 'https://www.curseforge.com/api/v1';
const CURSEFORGE_GAME_ID = 432;
const CURSEFORGE_PAGE_SIZE = 24;
const curseForgeProjectCache = new Map();
let curseForgeCoreRejected = false;
let runtimeSecrets = {};
try { runtimeSecrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-secrets.json'), 'utf8')); } catch {}
// The API key stays out of the renderer and out of the public source repository.
// Release builds include the bundled CurseForge API key so Content works with zero setup.
const CURSEFORGE_API_KEY = String(process.env.CURSEFORGE_API_KEY || runtimeSecrets.curseForgeApiKey || '').trim();
const USER_AGENT = `SpectorClient/${app.getVersion()} (Electron Minecraft launcher)`;
const MODRINTH_PAGE_SIZE = 24;
const UPDATE_REPO_OWNER = 'NoobIsADev';
const UPDATE_REPO_NAME = 'SpectorClient-Launcher';

// Spector Satellite social backend. The URL can be overridden for testing with
// SPECTOR_SATELLITE_URL, but production builds target the user's hosted service.
const SATELLITE_BASE_URL = String(process.env.SPECTOR_SATELLITE_URL || 'http://nyc1.nightly.host:25597').replace(/\/+$/, '');
const SATELLITE_RECONNECT_MS = 5000;
const SATELLITE_REQUEST_TIMEOUT_MS = 15000;
const SATELLITE_PRESENCE_MODES = new Set(['online', 'dnd', 'idle', 'invisible']);

// Keep this client completely separate from the normal .minecraft folder.
const APPDATA_ROOT = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'spectorclient')
  : path.join(app.getPath('appData'), 'spectorclient');
const LAUNCHER_DATA = path.join(APPDATA_ROOT, 'launcher-data');
app.setPath('userData', LAUNCHER_DATA);
const JAVA_RUNTIME_DOWNLOAD_DIR = path.join(LAUNCHER_DATA, 'downloads');

let mainWindow;
let logWindow;
const logBuffer = [];
const MAX_LOG_LINES = 2500;
let activeGameProcess = null;
let activeGameVersion = null;
let activeGameServerAddress = null;
let launcherEventsBound = false;
let preferredUiScale = 1;
let effectiveUiScale = 1;
let scaleResizeTimer = null;
const fabricApiRefreshPromises = new Map();
const javaInstallPromises = new Map();
let updaterInitialized = false;
let updaterInterval = null;
let updaterCheckPromise = null;
let lastUpdaterProgressBucket = -1;
let downloadedUpdateInfo = null;
let updateInstallPending = false;
let updateInstallStarting = false;
let updateDownloadInProgress = false;
let updateInstallFreshnessPromise = null;
let latestKnownUpdateVersion = null;
let backgroundForUpdate = false;
let gameLaunchInProgress = false;
let lastUpdaterErrorFingerprint = '';
let lastUpdaterErrorAt = 0;
let lastNativeUpdateNoticeVersion = '';
let lastNativeInstallNoticeVersion = '';

// Satellite sessions are intentionally memory-only. They are refreshed from the
// already signed-in Minecraft account when the launcher starts or the selected
// account changes.
let satelliteSessionToken = null;
let satelliteSessionExpiresAt = 0;
let satelliteAccountId = null;
let satelliteSocket = null;
let satelliteReconnectTimer = null;
let satelliteConnectPromise = null;
let satelliteManualDisconnect = false;
let satelliteState = {
  endpoint: SATELLITE_BASE_URL,
  connection: 'disconnected',
  secure: SATELLITE_BASE_URL.startsWith('https://'),
  accountId: null,
  me: null,
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  error: null,
  presenceMode: 'online'
};

// The UI was designed around this content area. The preferred user scale is
// automatically capped to a fit scale whenever the window is too small.
const DESIGN_WIDTH = 1240;
const DESIGN_HEIGHT = 760;
const launcher = new Client();

const p = (...parts) => path.join(APPDATA_ROOT, ...parts);
const launcherDataPath = (...parts) => path.join(LAUNCHER_DATA, ...parts);

function normalizeGameVersion(value) {
  const candidate = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(CLIENT_PROFILES, candidate) ? candidate : DEFAULT_GAME_VERSION;
}

function getClientProfile(value) {
  const gameVersion = normalizeGameVersion(value);
  return { gameVersion, ...CLIENT_PROFILES[gameVersion] };
}

function getInstanceRoot(value) {
  const gameVersion = normalizeGameVersion(value);
  return path.join(APPDATA_ROOT, 'instances', gameVersion);
}

function getModsDir(value) {
  return path.join(getInstanceRoot(value), 'mods');
}

function instancePath(value, ...parts) {
  return path.join(getInstanceRoot(value), ...parts);
}

function getModRegistryPath(value) {
  const gameVersion = normalizeGameVersion(value);
  return gameVersion === DEFAULT_GAME_VERSION
    ? launcherDataPath('mods-registry.json')
    : launcherDataPath(`mods-registry-${gameVersion}.json`);
}

function normalizeSocialPresenceMode(value) {
  const mode = String(value || '').toLowerCase();
  return SATELLITE_PRESENCE_MODES.has(mode) ? mode : 'online';
}

function defaultSettings() {
  return {
    selectedAccountId: null,
    selectedGameVersion: DEFAULT_GAME_VERSION,
    minRamGb: 4,
    maxRamGb: 6,
    java25Path: '',
    java21Path: '',
    width: 1280,
    height: 720,
    fullscreen: false,
    serverAddress: '',
    closeLauncherOnStart: false,
    logsPopout: true,
    uiScale: 1,
    animationsEnabled: true,
    soundsEnabled: true,
    soundVolume: 42,
    theme: 'classic',
    socialPresenceMode: 'online',
    accounts: []
  };
}

const LEGACY_26_2_MIGRATION_MARKER = launcherDataPath('migration-26.2-to-instances-v1.json');
const SHARED_INSTANCE_DIRECTORIES = Object.freeze(['config', 'spectorclient', 'resourcepacks', 'shaderpacks']);
const SHARED_INSTANCE_FILES = Object.freeze(['options.txt', 'servers.dat', 'servers.dat_old']);
const SHARED_INSTANCE_ENTRIES = Object.freeze([...SHARED_INSTANCE_DIRECTORIES, ...SHARED_INSTANCE_FILES]);
const LEGACY_26_2_EXCLUDED_ROOT_ENTRIES = new Set(['launcher-data', 'runtime', 'instances', ...SHARED_INSTANCE_ENTRIES]);
let dirsInitialized = false;
let ensureDirsPromise = null;

async function nextMigrationBackupPath(destination) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${destination}.pre-migration-backup-${stamp}`;
  let index = 1;
  while (await pathExists(candidate)) {
    candidate = `${destination}.pre-migration-backup-${stamp}-${index++}`;
  }
  return candidate;
}

async function moveLegacyEntry(source, destination) {
  const sourceStat = await fsp.lstat(source);
  const destinationExists = await pathExists(destination);

  if (!destinationExists) {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
    return;
  }

  const destinationStat = await fsp.lstat(destination);
  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    await fsp.mkdir(destination, { recursive: true });
    const children = await fsp.readdir(source);
    for (const child of children) {
      await moveLegacyEntry(path.join(source, child), path.join(destination, child));
    }
    await fsp.rmdir(source);
    return;
  }

  // Never destroy a file that already exists in the new 26.2 instance. Keep
  // it beside the migrated file as a timestamped backup, then move the legacy
  // user's file into the canonical location.
  const backup = await nextMigrationBackupPath(destination);
  await fsp.rename(destination, backup);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.rename(source, destination);
}

async function migrateLegacy26_2Instance() {
  if (await pathExists(LEGACY_26_2_MIGRATION_MARKER)) return { migrated: false, alreadyDone: true };

  await fsp.mkdir(APPDATA_ROOT, { recursive: true });
  await fsp.mkdir(LAUNCHER_DATA, { recursive: true });
  await fsp.mkdir(path.join(APPDATA_ROOT, 'instances'), { recursive: true });

  const destinationRoot = path.join(APPDATA_ROOT, 'instances', DEFAULT_GAME_VERSION);
  await fsp.mkdir(destinationRoot, { recursive: true });

  const entries = await fsp.readdir(APPDATA_ROOT, { withFileTypes: true }).catch(() => []);
  const legacyEntries = entries.filter((entry) => !LEGACY_26_2_EXCLUDED_ROOT_ENTRIES.has(entry.name));
  const moved = [];

  if (legacyEntries.length) {
    log(`[Migration] Moving legacy ${DEFAULT_GAME_VERSION} instance into ${destinationRoot}…`, 'launcher');
  }

  for (const entry of legacyEntries) {
    const source = path.join(APPDATA_ROOT, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    await moveLegacyEntry(source, destination);
    moved.push(entry.name);
    log(`[Migration] Moved ${entry.name} -> instances/${DEFAULT_GAME_VERSION}/${entry.name}`, 'launcher');
  }

  await fsp.writeFile(LEGACY_26_2_MIGRATION_MARKER, JSON.stringify({
    version: 1,
    migratedAt: new Date().toISOString(),
    destination: destinationRoot,
    moved
  }, null, 2), 'utf8');

  if (moved.length) {
    log(`[Migration] Legacy ${DEFAULT_GAME_VERSION} migration complete. Old root instance files were removed after moving.`, 'launcher');
  }
  return { migrated: moved.length > 0, moved };
}


function sharedInstancePath(name) {
  return path.join(APPDATA_ROOT, name);
}

async function samePhysicalEntry(first, second) {
  try {
    const [a, b] = await Promise.all([fsp.stat(first), fsp.stat(second)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

async function linkResolvesTo(linkPath, targetPath) {
  try {
    const info = await fsp.lstat(linkPath);
    if (!info.isSymbolicLink()) return false;
    const [resolvedLink, resolvedTarget] = await Promise.all([
      fsp.realpath(linkPath),
      fsp.realpath(targetPath)
    ]);
    return path.resolve(resolvedLink) === path.resolve(resolvedTarget);
  } catch {
    return false;
  }
}

async function moveToSharedMigrationBackup(source, sourceLabel, entryName, relativePath = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(
    LAUNCHER_DATA,
    'shared-data-migration-backups',
    stamp,
    String(sourceLabel || 'unknown'),
    entryName,
    relativePath
  );
  const destination = await nextMigrationBackupPath(base);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.rename(source, destination);
  log(`[Shared data] Preserved older/conflicting ${entryName} data at ${destination}.`, 'launcher');
  return destination;
}

async function mergeFileIntoShared(source, destination, sourceLabel, entryName, relativePath = '') {
  if (!await pathExists(source)) return;

  if (await pathExists(destination) && await samePhysicalEntry(source, destination)) return;

  if (!await pathExists(destination)) {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
    return;
  }

  const [sourceStat, destinationStat] = await Promise.all([
    fsp.stat(source),
    fsp.stat(destination)
  ]);

  if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
    await moveToSharedMigrationBackup(destination, 'previous-shared', entryName, relativePath);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
  } else {
    await moveToSharedMigrationBackup(source, sourceLabel, entryName, relativePath);
  }
}

async function mergeDirectoryIntoShared(source, destination, sourceLabel, entryName, relativePath = '') {
  if (!await pathExists(source)) return;
  if (await linkResolvesTo(source, destination)) return;

  if (!await pathExists(destination)) {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
    return;
  }

  const [sourceInfo, destinationInfo] = await Promise.all([
    fsp.lstat(source),
    fsp.lstat(destination)
  ]);

  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
    const [sourceStat, destinationStat] = await Promise.all([fsp.stat(source), fsp.stat(destination)]);
    if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
      await moveToSharedMigrationBackup(destination, 'previous-shared', entryName, relativePath);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.rename(source, destination);
    } else {
      await moveToSharedMigrationBackup(source, sourceLabel, entryName, relativePath);
    }
    return;
  }

  await fsp.mkdir(destination, { recursive: true });
  const children = await fsp.readdir(source, { withFileTypes: true });
  for (const child of children) {
    const childSource = path.join(source, child.name);
    const childDestination = path.join(destination, child.name);
    const childRelative = relativePath ? path.join(relativePath, child.name) : child.name;

    if (child.isDirectory() && !child.isSymbolicLink()) {
      await mergeDirectoryIntoShared(childSource, childDestination, sourceLabel, entryName, childRelative);
    } else {
      await mergeFileIntoShared(childSource, childDestination, sourceLabel, entryName, childRelative);
    }
  }
  await fsp.rmdir(source).catch(() => {});
}

async function ensureSharedDirectoryForVersion(gameVersion, entryName) {
  const shared = sharedInstancePath(entryName);
  const instanceEntry = instancePath(gameVersion, entryName);
  await fsp.mkdir(shared, { recursive: true });

  if (await linkResolvesTo(instanceEntry, shared)) return;
  if (await pathExists(instanceEntry)) {
    await mergeDirectoryIntoShared(instanceEntry, shared, gameVersion, entryName);
  }
  await fsp.rm(instanceEntry, { recursive: true, force: true }).catch(() => {});

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fsp.symlink(shared, instanceEntry, linkType);
}

async function ensureSharedFileForVersion(gameVersion, entryName) {
  const shared = sharedInstancePath(entryName);
  const instanceEntry = instancePath(gameVersion, entryName);

  if (await pathExists(instanceEntry)) {
    if (!await pathExists(shared) || !await samePhysicalEntry(instanceEntry, shared)) {
      await mergeFileIntoShared(instanceEntry, shared, gameVersion, entryName);
    }
  }

  if (!await pathExists(shared)) return;
  if (await samePhysicalEntry(instanceEntry, shared)) return;

  await fsp.rm(instanceEntry, { force: true }).catch(() => {});
  await fsp.mkdir(path.dirname(instanceEntry), { recursive: true });

  if (process.platform === 'win32') {
    // File symlinks can require Developer Mode/admin on Windows. A hard link is
    // privilege-free and keeps these small Minecraft files genuinely shared.
    await fsp.link(shared, instanceEntry);
  } else {
    await fsp.symlink(shared, instanceEntry, 'file');
  }
}

async function ensureSharedDataForVersion(gameVersion) {
  gameVersion = normalizeGameVersion(gameVersion);
  for (const entryName of SHARED_INSTANCE_DIRECTORIES) {
    await ensureSharedDirectoryForVersion(gameVersion, entryName);
  }
  for (const entryName of SHARED_INSTANCE_FILES) {
    await ensureSharedFileForVersion(gameVersion, entryName);
  }
}

async function ensureSharedInstanceData() {
  // These live directly in the main SpectorClient directory and are presented
  // inside every version instance. Config, SpectorClient data, resource packs and
  // shader packs are shared; mods remain version-specific.
  for (const gameVersion of Object.keys(CLIENT_PROFILES)) {
    await ensureSharedDataForVersion(gameVersion);
  }
}

async function ensureDirs() {
  if (dirsInitialized) return;
  if (!ensureDirsPromise) {
    ensureDirsPromise = (async () => {
      // Create only launcher-global directories first. The legacy 26.2 migration
      // must run before the new per-version instance directories are initialized.
      await Promise.all([
        fsp.mkdir(APPDATA_ROOT, { recursive: true }),
        fsp.mkdir(LAUNCHER_DATA, { recursive: true }),
        fsp.mkdir(launcherDataPath('accounts'), { recursive: true }),
        fsp.mkdir(path.join(APPDATA_ROOT, 'instances'), { recursive: true }),
        fsp.mkdir(path.join(APPDATA_ROOT, 'runtime'), { recursive: true }),
        fsp.mkdir(JAVA_RUNTIME_DOWNLOAD_DIR, { recursive: true })
      ]);

      await migrateLegacy26_2Instance();

      const versionRoots = Object.keys(CLIENT_PROFILES).map((gameVersion) => getInstanceRoot(gameVersion));
      const versionDirs = versionRoots.flatMap((root) => [
        fsp.mkdir(root, { recursive: true }),
        fsp.mkdir(path.join(root, 'mods'), { recursive: true }),
        fsp.mkdir(path.join(root, 'versions'), { recursive: true })
      ]);
      await Promise.all(versionDirs);

      // Keep only mods/version runtime data isolated. User settings that should
      // follow the player between 26.2, 26.3 and 1.21.11 live in APPDATA_ROOT.
      await ensureSharedInstanceData();
      dirsInitialized = true;
    })();
  }

  try {
    await ensureDirsPromise;
  } finally {
    if (!dirsInitialized) ensureDirsPromise = null;
  }
}

function temurinArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'aarch64';
  throw new Error(`Automatic Java installation does not support ${process.platform} ${process.arch}.`);
}

function temurinOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`Automatic Java installation is not supported on ${process.platform}.`);
}

function temurinPlatformLabel() {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform;
}

function javaRuntimeDir(major) {
  return path.join(APPDATA_ROOT, 'runtime', `java-${major}`);
}

function managedJavaPath(major) {
  // Use java.exe on Windows instead of javaw.exe so JVM startup failures are
  // captured by the launcher logs instead of appearing only as a GUI popup.
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  return path.join(javaRuntimeDir(major), 'bin', executable);
}

function javaSettingsKey(major) {
  return Number(major) === 21 ? 'java21Path' : 'java25Path';
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJavaMajor(output) {
  const text = String(output || '');
  const match = text.match(/(?:openjdk|java) version ["'](\d+)(?:[.\-+_][^"']*)?["']/i)
    || text.match(/version ["'](\d+)(?:\.|["'])/i);
  return match ? Number(match[1]) : null;
}

async function inspectJava(javaExecutable, expectedMajor) {
  if (!(await pathExists(javaExecutable))) {
    return { ok: false, reason: 'Java executable does not exist.' };
  }
  try {
    // A small heap smoke test proves the JVM can actually initialize, which
    // catches corrupt/incomplete runtimes that may still contain java.exe.
    const { stdout, stderr } = await execFilePromise(
      javaExecutable,
      ['-Xms32m', '-Xmx128m', '-version'],
      { timeout: 20000, maxBuffer: 1024 * 1024 }
    );
    const output = `${stdout || ''}\n${stderr || ''}`;
    const major = parseJavaMajor(output);
    if (major !== Number(expectedMajor)) {
      return { ok: false, major, output, reason: `Expected Java ${expectedMajor}, but this executable reports Java ${major ?? 'unknown'}.` };
    }
    return { ok: true, major, output };
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    return {
      ok: false,
      output,
      reason: output || error.message || `Java ${expectedMajor} could not create a JVM.`
    };
  }
}

async function isJavaMajor(javaExecutable, expectedMajor) {
  return (await inspectJava(javaExecutable, expectedMajor)).ok;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function getTemurinPackage(major, arch, imageType) {
  const query = new URLSearchParams({
    architecture: arch,
    image_type: imageType,
    os: temurinOs(),
    vendor: 'eclipse'
  });
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${query.toString()}`;
  const assets = await request(url);
  if (!Array.isArray(assets) || !assets.length) {
    throw new Error(`Eclipse Temurin does not currently list a ${temurinPlatformLabel()} ${arch} Java ${major} ${imageType.toUpperCase()} package.`);
  }

  const asset = assets.find((entry) => {
    const binary = entry?.binary;
    return binary?.architecture === arch
      && binary?.os === temurinOs()
      && binary?.image_type === imageType
      && binary?.package?.link;
  }) || assets[0];

  const pkg = asset?.binary?.package;
  if (!pkg?.link || !/^https:\/\//i.test(pkg.link)) {
    throw new Error(`Temurin Java ${major} metadata did not contain a secure package URL.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(pkg.checksum || '')) {
    throw new Error(`Temurin Java ${major} metadata did not contain a valid SHA-256 checksum.`);
  }
  const size = Number(pkg.size) || 0;
  if (size < 10 * 1024 * 1024) {
    throw new Error(`Temurin Java ${major} metadata reported an invalid package size (${size} bytes).`);
  }

  return {
    imageType,
    url: pkg.link,
    checksum: String(pkg.checksum).toLowerCase(),
    size,
    name: pkg.name || `Temurin Java ${major}`,
    releaseName: asset?.release_name || ''
  };
}

function downloadJavaArchive(url, destination, { redirects = 8, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = (currentUrl, remaining) => {
      const req = https.get(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/zip,application/gzip,application/x-gzip,application/octet-stream,*/*;q=0.8',
          'Cache-Control': 'no-cache'
        }
      }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && remaining > 0) {
          const next = new URL(res.headers.location, currentUrl).toString();
          res.resume();
          requestUrl(next, remaining - 1);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Java download failed with HTTP ${status}.`));
          return;
        }

        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('text/html')) {
          res.resume();
          reject(new Error('Java download returned an HTML page instead of a runtime archive.'));
          return;
        }

        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        let settled = false;
        const output = fs.createWriteStream(destination);
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try { output.destroy(); } catch {}
          reject(error);
        };
        output.on('error', fail);
        res.on('error', fail);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        output.on('finish', () => {
          output.close(() => {
            if (settled) return;
            settled = true;
            resolve({ destination, received, total, contentType });
          });
        });
        res.pipe(output);
      });
      req.on('error', reject);
      req.setTimeout(180000, () => req.destroy(new Error('Java download timed out.')));
    };
    requestUrl(url, redirects);
  });
}

async function findJavaHome(root, depth = 4) {
  const consoleName = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidate = path.join(root, 'bin', consoleName);
  if (await pathExists(candidate)) return root;
  if (depth <= 0) return null;

  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findJavaHome(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function extractJavaArchive(downloadPath, stagingDir) {
  if (process.platform === 'linux') {
    // Adoptium publishes Linux runtimes as .tar.gz archives. GNU tar preserves
    // the executable bit on bin/java, which is required for the managed runtime.
    await execFilePromise('tar', ['-xzf', downloadPath, '-C', stagingDir], {
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024
    });
    return;
  }

  // Windows ships bsdtar on supported Windows 10/11 builds. It handles ZIPs
  // reliably and avoids the Expand-Archive failure seen on some systems.
  try {
    await execFilePromise('tar.exe', ['-xf', downloadPath, '-C', stagingDir], {
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024
    });
    return;
  } catch (tarError) {
    log(`[Java] tar.exe extraction failed (${tarError.message}); falling back to PowerShell Expand-Archive.`, 'debug');
  }

  // Use an encoded PowerShell command so spaces/quotes in AppData paths cannot
  // corrupt the command line.
  const escapePs = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = `Expand-Archive -LiteralPath ${escapePs(downloadPath)} -DestinationPath ${escapePs(stagingDir)} -Force`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await execFilePromise('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded
  ], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
}

async function installManagedJava(major) {
  major = Number(major);
  if (![21, 25].includes(major)) throw new Error(`Unsupported managed Java version: ${major}`);
  if (!['win32', 'linux'].includes(process.platform)) {
    throw new Error(`Automatic Java ${major} installation is not supported on ${process.platform}. Select Java ${major} manually in Settings.`);
  }

  await ensureDirs();
  const arch = temurinArch();
  const runtimeDir = javaRuntimeDir(major);
  const archiveExtension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const downloadPath = path.join(JAVA_RUNTIME_DOWNLOAD_DIR, `temurin-${major}-${arch}-${process.pid}${archiveExtension}`);
  const stagingDir = path.join(APPDATA_ROOT, 'runtime', `.java-${major}-install-${process.pid}-${Date.now()}`);

  log(`[Java] Resolving verified Eclipse Temurin Java ${major} package for ${temurinPlatformLabel()} ${arch}…`, 'launcher');
  send('install-state', { step: `Java ${major}`, message: `Finding Java ${major}…` });

  await fsp.rm(downloadPath, { force: true }).catch(() => {});
  await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(stagingDir, { recursive: true });

  let lastError = null;
  try {
    for (const imageType of ['jre', 'jdk']) {
      let pkg;
      try {
        pkg = await getTemurinPackage(major, arch, imageType);
      } catch (error) {
        lastError = error;
        log(`[Java] Java ${major} ${imageType.toUpperCase()} metadata unavailable: ${error.message}`, 'debug');
        continue;
      }

      try {
        log(`[Java] Downloading ${pkg.name} (${Math.round(pkg.size / 1024 / 1024)} MB)${pkg.releaseName ? ` from ${pkg.releaseName}` : ''}.`, 'launcher');
        send('install-state', { step: `Java ${major}`, message: `Downloading Java ${major}… 0%`, percent: 0 });

        let lastPercent = -1;
        await downloadJavaArchive(pkg.url, downloadPath, {
          onProgress: (received, total) => {
            const denominator = total || pkg.size;
            if (!denominator) return;
            const percent = Math.max(0, Math.min(100, Math.floor((received / denominator) * 100)));
            if (percent === lastPercent || percent % 5 !== 0) return;
            lastPercent = percent;
            send('install-state', { step: `Java ${major}`, message: `Downloading Java ${major}… ${percent}%`, percent });
          }
        });

        const stat = await fsp.stat(downloadPath);
        if (stat.size !== pkg.size) {
          throw new Error(`Java ${major} download size mismatch: expected ${pkg.size} bytes, got ${stat.size}.`);
        }

        const actualChecksum = await sha256File(downloadPath);
        if (actualChecksum !== pkg.checksum) {
          throw new Error(`Java ${major} SHA-256 verification failed.`);
        }

        const fd = await fsp.open(downloadPath, 'r');
        const header = Buffer.alloc(4);
        await fd.read(header, 0, 4, 0);
        await fd.close();
        if (process.platform === 'win32') {
          if (header[0] !== 0x50 || header[1] !== 0x4b) {
            throw new Error(`Verified Java ${major} package is not a ZIP archive.`);
          }
        } else if (header[0] !== 0x1f || header[1] !== 0x8b) {
          throw new Error(`Verified Java ${major} package is not a gzip-compressed tar archive.`);
        }

        log(`[Java] Java ${major} package passed size and SHA-256 verification.`, 'launcher');
        send('install-state', { step: `Java ${major}`, message: `Installing Java ${major}…` });
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fsp.mkdir(stagingDir, { recursive: true });
        await extractJavaArchive(downloadPath, stagingDir);

        const extractedHome = await findJavaHome(stagingDir);
        if (!extractedHome) throw new Error(`Java ${major} extracted, but its Java executable could not be found.`);

        const extractedJava = path.join(extractedHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (process.platform === 'linux') await fsp.chmod(extractedJava, 0o755).catch(() => {});
        const inspection = await inspectJava(extractedJava, major);
        if (!inspection.ok) {
          throw new Error(`The downloaded Java ${major} runtime failed its JVM test: ${inspection.reason}`);
        }

        // Keep the previous runtime until the new one has been fully verified.
        const oldRuntime = `${runtimeDir}.old-${process.pid}-${Date.now()}`;
        if (await pathExists(runtimeDir)) await fsp.rename(runtimeDir, oldRuntime);
        try {
          if (path.resolve(extractedHome) === path.resolve(stagingDir)) {
            await fsp.rename(stagingDir, runtimeDir);
          } else {
            await fsp.rename(extractedHome, runtimeDir);
            await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
          }

          const finalJava = managedJavaPath(major);
          if (process.platform === 'linux') await fsp.chmod(finalJava, 0o755).catch(() => {});
          const finalInspection = await inspectJava(finalJava, major);
          if (!finalInspection.ok) {
            throw new Error(`Installed Java ${major} failed its final JVM test: ${finalInspection.reason}`);
          }
          await fsp.rm(oldRuntime, { recursive: true, force: true }).catch(() => {});
          log(`[Java] Managed Java ${major} is ready and verified: ${finalJava}`, 'launcher');
          send('install-state', { step: `Java ${major}`, message: `Java ${major} ready.`, percent: 100 });
          return finalJava;
        } catch (installError) {
          await fsp.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
          if (await pathExists(oldRuntime)) await fsp.rename(oldRuntime, runtimeDir).catch(() => {});
          throw installError;
        }
      } catch (error) {
        lastError = error;
        log(`[Java] Java ${major} ${imageType.toUpperCase()} install attempt failed: ${error.message}`, 'debug');
        await fsp.rm(downloadPath, { force: true }).catch(() => {});
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fsp.mkdir(stagingDir, { recursive: true }).catch(() => {});
      }
    }
    throw lastError || new Error(`Could not install Java ${major}.`);
  } finally {
    await fsp.rm(downloadPath, { force: true }).catch(() => {});
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureManagedJava(major, { force = false } = {}) {
  major = Number(major);
  const javaExecutable = managedJavaPath(major);
  if (!force && await isJavaMajor(javaExecutable, major)) return javaExecutable;

  if (!force && await pathExists(javaRuntimeDir(major))) {
    log(`[Java] Existing managed Java ${major} is invalid or cannot create a JVM. Reinstalling it.`, 'launcher');
  }

  if (!javaInstallPromises.has(major)) {
    javaInstallPromises.set(major, installManagedJava(major).finally(() => javaInstallPromises.delete(major)));
  }
  return javaInstallPromises.get(major);
}

async function loadSettings() {
  await ensureDirs();
  try {
    const parsed = JSON.parse(await fsp.readFile(launcherDataPath('settings.json'), 'utf8'));
    // v1.6.16: the old single javaPath override belonged to the original 26.2
    // client. Preserve it as the Java 25 override while Java 21 gets its own field.
    if (!parsed.java25Path && parsed.javaPath) parsed.java25Path = parsed.javaPath;
    return {
      ...defaultSettings(),
      ...parsed,
      selectedGameVersion: normalizeGameVersion(parsed.selectedGameVersion),
      socialPresenceMode: normalizeSocialPresenceMode(parsed.socialPresenceMode),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(settings) {
  const safe = { ...defaultSettings(), ...settings };
  safe.selectedGameVersion = normalizeGameVersion(safe.selectedGameVersion);
  safe.socialPresenceMode = normalizeSocialPresenceMode(safe.socialPresenceMode);
  delete safe.gameDirectory;
  delete safe.clientId;
  delete safe.selectedVersion;
  delete safe.versionType;
  delete safe.javaPath; // legacy pre-v1.6.16 single Java override
  delete safe.backgroundTransparency; // v1.4.2+: launcher is always fully opaque.
  await fsp.writeFile(launcherDataPath('settings.json'), JSON.stringify(safe, null, 2));
  return safe;
}

function clampUiScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.8, Math.max(0.6, Math.round(n * 10) / 10));
}

function calculateFitScale() {
  if (!mainWindow || mainWindow.isDestroyed()) return preferredUiScale;

  const bounds = mainWindow.getContentBounds();
  const widthFit = bounds.width / DESIGN_WIDTH;
  const heightFit = bounds.height / DESIGN_HEIGHT;

  // Keep a tiny safety margin so borders/taskbar/work-area rounding never clips
  // the bottom row by a pixel or two. Do not force the UI larger than requested.
  return Math.max(0.5, Math.min(widthFit, heightFit) * 0.995);
}

function applyUiScale(value = preferredUiScale, { announce = false } = {}) {
  preferredUiScale = clampUiScale(value);

  if (mainWindow && !mainWindow.isDestroyed()) {
    const fitScale = calculateFitScale();
    effectiveUiScale = Math.max(0.5, Math.min(preferredUiScale, fitScale));
    mainWindow.webContents.setZoomFactor(effectiveUiScale);

    if (announce) {
      send('ui-scale', {
        scale: effectiveUiScale,
        percent: Math.round(effectiveUiScale * 100),
        preferredScale: preferredUiScale,
        preferredPercent: Math.round(preferredUiScale * 100),
        autoFitted: effectiveUiScale + 0.001 < preferredUiScale
      });
    }
  }

  return effectiveUiScale;
}

function scheduleFitScale({ announce = false } = {}) {
  if (scaleResizeTimer) clearTimeout(scaleResizeTimer);
  scaleResizeTimer = setTimeout(() => {
    scaleResizeTimer = null;
    applyUiScale(preferredUiScale, { announce });
  }, 45);
}

async function persistUiScale(value, announce = true) {
  const settings = await loadSettings();
  settings.uiScale = clampUiScale(value);
  await saveSettings(settings);
  preferredUiScale = settings.uiScale;
  return applyUiScale(preferredUiScale, { announce });
}

async function refreshWindowIcon() {
  try {
    await fsp.mkdir(path.dirname(BRAND_IMAGE_PATH), { recursive: true });
    let valid = false;
    try { valid = (await fsp.stat(BRAND_IMAGE_PATH)).size > 128; } catch {}
    if (!valid) await downloadFile(BRAND_IMAGE_URL, BRAND_IMAGE_PATH, 'SpectorClient logo');
    if (mainWindow && !mainWindow.isDestroyed()) {
      const icon = nativeImage.createFromPath(BRAND_IMAGE_PATH);
      if (!icon.isEmpty()) mainWindow.setIcon(icon);
    }
  } catch (error) {
    log(`Could not cache SpectorClient logo: ${error.message}`, 'debug');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 760,
    minWidth: 1040,
    minHeight: 650,
    backgroundColor: '#02070b',
    transparent: false,
    title: PRODUCT_NAME,
    frame: false,
    show: false,
    icon: fs.existsSync(BRAND_IMAGE_PATH) ? BRAND_IMAGE_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', async () => {
    const settings = await loadSettings();
    applyUiScale(settings.uiScale);
    mainWindow.show();
    refreshWindowIcon();
  });

  const reapplyScale = () => setTimeout(() => applyUiScale(preferredUiScale, { announce: true }), 30);
  mainWindow.on('maximize', () => { send('window-maximized', true); reapplyScale(); });
  mainWindow.on('unmaximize', () => { send('window-maximized', false); reapplyScale(); });
  mainWindow.on('enter-full-screen', reapplyScale);
  mainWindow.on('leave-full-screen', reapplyScale);
  mainWindow.on('resize', () => scheduleFitScale());

  // Do not let a user accidentally kill an update that is already downloading.
  // If Minecraft is active we also keep the launcher alive in the background so
  // the downloaded update can install the instant the game exits.
  mainWindow.on('close', (event) => {
    const updaterBusy = updateDownloadInProgress || updateInstallPending;
    if (updaterBusy && !updateInstallStarting) {
      event.preventDefault();
      backgroundForUpdate = true;
      mainWindow.hide();

      if (updateInstallPending && (isMinecraftRunning() || gameLaunchInProgress)) {
        log('[Updater] Update is ready. SpectorClient will stay in the background until Minecraft closes.', 'updater');
        emitUpdateState('waiting-for-game', {
          version: downloadedUpdateInfo?.version || null,
          text: 'Update ready. Waiting for Minecraft to close before installing…'
        });
      } else if (updateDownloadInProgress) {
        log('[Updater] Finishing the launcher update in the background…', 'updater');
        emitUpdateState('downloading', { text: 'Finishing the launcher update in the background…' });
      }
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if (input.key === 'F11' || input.code === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      setTimeout(() => applyUiScale(preferredUiScale, { announce: true }), 30);
      return;
    }

    const ctrl = input.control || input.meta;
    if (!ctrl) return;

    const plus = input.key === '+' || input.key === '=' || input.code === 'NumpadAdd';
    const minus = input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract';
    const reset = input.key === '0' || input.code === 'Numpad0';
    if (!plus && !minus && !reset) return;

    event.preventDefault();
    if (plus) persistUiScale(preferredUiScale + 0.1).catch(() => {});
    else if (minus) persistUiScale(preferredUiScale - 0.1).catch(() => {});
    else persistUiScale(1).catch(() => {});
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function normalizeLauncherTheme(value) {
  return ['classic', 'classic-pink', 'crimson', 'prince'].includes(value) ? value : 'classic';
}

function logWindowBackground(theme) {
  const normalized = normalizeLauncherTheme(theme);
  if (normalized === 'classic-pink') return '#12070d';
  if (normalized === 'crimson') return '#100307';
  if (normalized === 'prince') return '#100c03';
  return '#031018';
}

function pushThemeToLogWindow(theme) {
  if (!logWindow || logWindow.isDestroyed()) return;
  const normalized = normalizeLauncherTheme(theme);
  logWindow.setBackgroundColor(logWindowBackground(normalized));
  logWindow.webContents.send('theme-changed', normalized);
}

function createLogWindow(theme = 'classic') {
  const normalizedTheme = normalizeLauncherTheme(theme);
  if (logWindow && !logWindow.isDestroyed()) {
    pushThemeToLogWindow(normalizedTheme);
    logWindow.show();
    logWindow.focus();
    return logWindow;
  }

  logWindow = new BrowserWindow({
    width: 920,
    height: 560,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: logWindowBackground(normalizedTheme),
    title: 'SpectorClient Logs',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(BRAND_IMAGE_PATH) ? BRAND_IMAGE_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  logWindow.loadFile(path.join(__dirname, 'logs.html'));
  logWindow.webContents.once('did-finish-load', () => pushThemeToLogWindow(normalizedTheme));
  logWindow.once('ready-to-show', () => logWindow?.show());
  logWindow.on('closed', () => { logWindow = null; });
  logWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return logWindow;
}

function makeIpcSafe(value, seen = new WeakSet()) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return undefined;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || '' };
  if (Buffer.isBuffer(value)) return { type: 'Buffer', data: value.toString('base64') };
  if (Array.isArray(value)) return value.map((item) => makeIpcSafe(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = makeIpcSafe(item, seen);
      if (safe !== undefined) out[key] = safe;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, makeIpcSafe(payload));
  } catch (error) {
    console.error(`IPC send failed for ${channel}:`, error);
  }
}

function sendLogPayload(payload) {
  send('game-log', payload);
  if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('game-log', payload);
}

function classifyLogLevel(line, type = 'launcher') {
  const text = String(line || '').toLowerCase();
  if (/\b(error|failed|failure|exception|fatal|crash|unable to|could not)\b/.test(text)) return 'error';
  if (/\b(warn|warning|retry|deprecated|waiting for|fallback)\b/.test(text)) return 'warn';
  if (type === 'debug') return 'debug';
  return 'info';
}

function log(line, type = 'launcher') {
  const text = String(line);
  const at = Date.now();
  const payload = {
    id: `${at}-${logBuffer.length}-${Math.random().toString(36).slice(2, 7)}`,
    type: String(type || 'launcher'),
    level: classifyLogLevel(text, type),
    line: text,
    at,
    iso: new Date(at).toISOString()
  };
  logBuffer.push(payload);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  sendLogPayload(payload);
}



function isTrustedLauncherWebContents(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  const url = String(webContents.getURL?.() || '');
  if (!url.startsWith('file://')) return false;
  const trustedIds = [
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null,
    logWindow && !logWindow.isDestroyed() ? logWindow.webContents.id : null
  ].filter(Boolean);
  return trustedIds.includes(webContents.id);
}

function configureNotificationPermissions() {
  // Renderer Notification.requestPermission() is used as the permission request
  // surface. Only SpectorClient's own local pages may request notification
  // permission; everything else is denied.
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const trusted = isTrustedLauncherWebContents(webContents);
    if (permission === 'notifications') return trusted;
    // Preserve Electron's previous permissive behavior for SpectorClient's own
    // local pages while denying permission checks from anything external.
    return trusted;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const trusted = isTrustedLauncherWebContents(webContents);
    if (permission === 'notifications') {
      callback(trusted);
      return;
    }
    callback(trusted);
  });
}

async function showNotificationPermissionHelp() {
  if (process.platform !== 'win32') return { openedSettings: false };
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: 'SpectorClient Notifications',
    message: 'Windows notifications are blocked for SpectorClient.',
    detail: 'SpectorClient uses Windows notifications for Minecraft startup, launcher updates, friend activity, friend requests, and messages. Enable notifications in Windows Settings to receive them.',
    buttons: ['Open Notification Settings', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (result.response === 0) {
    try {
      await shell.openExternal('ms-settings:notifications');
      return { openedSettings: true };
    } catch (error) {
      log(`[Notifications] Could not open Windows notification settings: ${error?.message || error}`, 'launcher');
    }
  }
  return { openedSettings: false };
}


function showNativeNotification(title, body, { version = '', kind = 'update' } = {}) {
  if (!Notification.isSupported()) {
    log(`[Notifications] Desktop notification unavailable on ${process.platform}: ${title} — ${body}`, 'launcher');
    return false;
  }

  if (kind === 'available' && version && lastNativeUpdateNoticeVersion === version) return false;
  if (kind === 'installing' && version && lastNativeInstallNoticeVersion === version) return false;

  try {
    const notice = new Notification({
      title: String(title || PRODUCT_NAME),
      body: String(body || ''),
      icon: BRAND_IMAGE_PATH,
      silent: false
    });

    notice.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    notice.show();
    if (kind === 'available' && version) lastNativeUpdateNoticeVersion = version;
    if (kind === 'installing' && version) lastNativeInstallNoticeVersion = version;
    return true;
  } catch (error) {
    log(`[Notifications] Could not show desktop notification: ${error?.message || error}`, 'launcher');
    return false;
  }
}

function emitUpdateState(state, extra = {}) {
  const payload = { state, ...makeIpcSafe(extra), at: Date.now() };
  send('update-state', payload);
  return payload;
}

function isMinecraftRunning() {
  return Boolean(activeGameProcess && activeGameProcess.exitCode == null);
}

function clearUpdaterPolling() {
  if (updaterInterval) {
    clearInterval(updaterInterval);
    updaterInterval = null;
  }
}

function normalizeLauncherVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareLauncherVersions(a, b) {
  const parse = (value) => normalizeLauncherVersion(value)
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  const length = Math.max(av.length, bv.length, 3);
  for (let i = 0; i < length; i += 1) {
    const left = av[i] || 0;
    const right = bv[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

async function getLatestPublishedLauncherVersion() {
  const url = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest?ts=${Date.now()}`;
  const release = await request(url);
  if (!release || release.draft || release.prerelease) {
    throw new Error('GitHub did not return a normal published SpectorClient release.');
  }
  const version = normalizeLauncherVersion(release.tag_name || release.name);
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`GitHub returned an invalid launcher version: ${release.tag_name || release.name || 'unknown'}`);
  }
  return version;
}

async function ensurePendingUpdateIsLatest() {
  const downloadedVersion = normalizeLauncherVersion(downloadedUpdateInfo?.version);
  if (!downloadedVersion) return true;

  let latestVersion;
  try {
    latestVersion = await getLatestPublishedLauncherVersion();
    latestKnownUpdateVersion = latestVersion;
  } catch (error) {
    // If the network disappears after an update was already downloaded, do not
    // strand the user forever. Install the verified downloaded update and let
    // the next normal startup check catch anything newer.
    log(`[Updater] Could not verify the newest published version before install: ${error?.message || error}. Installing the already-downloaded update.`, 'updater');
    return true;
  }

  if (compareLauncherVersions(latestVersion, downloadedVersion) <= 0) {
    log(`[Updater] Confirmed ${downloadedVersion} is the newest published SpectorClient release.`, 'updater');
    return true;
  }

  log(`[Updater] Skipping intermediate update ${downloadedVersion}; SpectorClient ${latestVersion} is already available. Downloading the newest release instead…`, 'updater');
  emitUpdateState('refreshing-latest', {
    version: latestVersion,
    text: `A newer SpectorClient ${latestVersion} release is available. Jumping directly to the latest version…`
  });

  try {
    const result = await autoUpdater.checkForUpdates();
    const resolvedVersion = normalizeLauncherVersion(result?.updateInfo?.version);

    // GitHub's updater metadata can trail the Releases API for a few seconds.
    // Never install the intermediate build while that happens; wait and retry.
    if (!resolvedVersion || compareLauncherVersions(resolvedVersion, latestVersion) < 0) {
      if (result?.downloadPromise) {
        try { await result.downloadPromise; } catch {}
      }
      log(`[Updater] Update metadata has not caught up to ${latestVersion} yet. Retrying instead of installing ${downloadedVersion}.`, 'updater');
      setTimeout(() => installDownloadedUpdateWhenSafe('waiting for newest release metadata'), 5000).unref?.();
      return false;
    }

    if (result?.downloadPromise) await result.downloadPromise;

    const refreshedVersion = normalizeLauncherVersion(downloadedUpdateInfo?.version);
    if (compareLauncherVersions(refreshedVersion, latestVersion) >= 0) {
      log(`[Updater] Newest release ${refreshedVersion} is downloaded and ready to install.`, 'updater');
      return true;
    }

    // The download event may still be finalizing its state after the promise.
    setTimeout(() => installDownloadedUpdateWhenSafe('newest release download finalized'), 750).unref?.();
    return false;
  } catch (error) {
    log(`[Updater] Could not refresh to newest release ${latestVersion}: ${error?.message || error}. Retrying without installing the intermediate update.`, 'updater');
    setTimeout(() => installDownloadedUpdateWhenSafe('retry newest release'), 5000).unref?.();
    return false;
  }
}

async function installDownloadedUpdateWhenSafe(reason = 'update downloaded') {
  if (!updateInstallPending || updateInstallStarting || !app.isPackaged) return false;

  const version = downloadedUpdateInfo?.version || 'new version';
  if (isMinecraftRunning() || gameLaunchInProgress) {
    log(`[Updater] SpectorClient ${version} is ready. Waiting for Minecraft to close before installing.`, 'updater');
    emitUpdateState('waiting-for-game', {
      version,
      text: `SpectorClient ${version} is ready. It will update automatically when Minecraft closes.`
    });
    return false;
  }

  // Do not install a previously downloaded intermediate release. Right before
  // handing off to the platform updater, verify GitHub's newest published release and jump
  // straight to it if anything newer has appeared.
  if (!updateInstallFreshnessPromise) {
    updateInstallFreshnessPromise = ensurePendingUpdateIsLatest().finally(() => {
      updateInstallFreshnessPromise = null;
    });
  }
  const newestReady = await updateInstallFreshnessPromise;
  if (!newestReady) return false;
  // update-downloaded can fire while the freshness check is awaiting the newer
  // download. Multiple callers may therefore resume together; only the first
  // one is allowed to hand off to the platform updater.
  if (updateInstallStarting || !updateInstallPending) return false;

  // The freshness check can take long enough for Minecraft to start again.
  if (isMinecraftRunning() || gameLaunchInProgress || updateDownloadInProgress) {
    log('[Updater] Newest update is not safe to install yet. Waiting for active launch/download work to finish.', 'updater');
    return false;
  }

  const finalVersion = downloadedUpdateInfo?.version || version;
  updateInstallStarting = true;
  clearUpdaterPolling();
  log(`[Updater] Installing newest SpectorClient ${finalVersion} now (${reason})…`, 'updater');
  showNativeNotification(
    'SpectorClient Update Installing',
    `Installing SpectorClient ${finalVersion} now. The launcher will restart automatically when it is finished.`,
    { version: finalVersion, kind: 'installing' }
  );
  emitUpdateState('installing-update', {
    version: finalVersion,
    text: `Installing SpectorClient ${finalVersion} now…`
  });

  // Give the renderer/log window a brief moment to paint the final status.
  // Then close every BrowserWindow ourselves before handing control to the
  // platform updater. This avoids renderer/GPU handles keeping files locked.
  setTimeout(() => {
    try {
      if (logWindow && !logWindow.isDestroyed()) logWindow.destroy();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      app.releaseSingleInstanceLock();

      // isSilent=true: no installer wizard where supported. forceRunAfter=true:
      // restart the updated launcher after NSIS/AppImage replacement completes.
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      updateInstallStarting = false;
      backgroundForUpdate = false;
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
      const message = error?.message || String(error);
      log(`[Updater] Could not start the update installer: ${message}`, 'updater');
      emitUpdateState('error', { text: `Could not install launcher update: ${message}` });
    }
  }, 1000).unref?.();

  return true;
}


function normalizeUpdaterError(error) {
  const raw = error?.message || String(error || 'Unknown updater error');
  const firstLine = raw.split(/\r?\n/)[0].trim();
  const missingLatestMetadata = /latest(?:-linux)?\.yml/i.test(raw) && (/(?:404|not found)/i.test(raw) || /cannot find latest(?:-linux)?\.yml/i.test(raw));
  const rateLimited = /(?:rate limit|403)/i.test(raw) && /github/i.test(raw);
  const networkIssue = /(?:ENOTFOUND|ECONNRESET|ETIMEDOUT|network|socket hang up)/i.test(raw);

  if (missingLatestMetadata) {
    return {
      raw,
      logMessage: firstLine,
      state: 'retrying',
      text: 'The newest launcher release is still publishing. SpectorClient will retry automatically.'
    };
  }
  if (rateLimited) {
    return {
      raw,
      logMessage: firstLine,
      state: 'retrying',
      text: 'GitHub temporarily limited update checks. SpectorClient will retry automatically.'
    };
  }
  if (networkIssue) {
    return {
      raw,
      logMessage: firstLine,
      state: 'retrying',
      text: 'Could not reach the update server. SpectorClient will retry automatically.'
    };
  }
  return {
    raw,
    logMessage: firstLine,
    state: 'error',
    text: 'Could not check for launcher updates. SpectorClient will retry automatically.'
  };
}

function handleUpdaterError(error, context = 'Update check failed') {
  const detail = normalizeUpdaterError(error);
  const fingerprint = `${detail.state}|${detail.logMessage}`;
  const now = Date.now();

  // electron-updater can surface the same failure through both its `error`
  // event and the rejected checkForUpdates() promise. Avoid duplicate UI/logs.
  if (fingerprint === lastUpdaterErrorFingerprint && now - lastUpdaterErrorAt < 3000) return;
  lastUpdaterErrorFingerprint = fingerprint;
  lastUpdaterErrorAt = now;

  log(`[Updater] ${context}: ${detail.logMessage}`, 'updater');
  emitUpdateState(detail.state, { text: detail.text });
}

function verifyPackagedUpdateConfig() {
  const configPath = path.join(process.resourcesPath, 'app-update.yml');
  try {
    const config = fs.readFileSync(configPath, 'utf8');
    const providerOk = /(?:^|\n)provider:\s*github\s*(?:\n|$)/i.test(config);
    const ownerOk = new RegExp(`(?:^|\n)owner:\s*[\"']?${UPDATE_REPO_OWNER}[\"']?\s*(?:\n|$)`, 'i').test(config);
    const repoOk = new RegExp(`(?:^|\n)repo:\s*[\"']?${UPDATE_REPO_NAME}[\"']?\s*(?:\n|$)`, 'i').test(config);
    if (!providerOk || !ownerOk || !repoOk) {
      throw new Error(`app-update.yml does not point to ${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}`);
    }
    log(`[Updater] Packaged update configuration verified: ${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}.`, 'updater');
    return true;
  } catch (error) {
    log(`[Updater] Packaged update configuration problem: ${error?.message || error}`, 'updater');
    emitUpdateState('error', { text: 'This SpectorClient build is missing valid automatic-update configuration.' });
    return false;
  }
}

function setupAutoUpdater() {
  if (updaterInitialized || !app.isPackaged) {
    if (!app.isPackaged) log(`[Updater] Development build ${app.getVersion()} detected; automatic app replacement is disabled. Install the Windows NSIS build or run the Linux AppImage to test auto-updates.`, 'updater');
    return;
  }

  if (process.platform === 'linux') {
    if (!process.env.APPIMAGE) {
      log('[Updater] Packaged Linux build is not running from an AppImage. Automatic in-place updates are disabled for this launch.', 'updater');
      return;
    }
    try {
      // AppImageUpdater replaces/renames the current AppImage. The containing
      // directory therefore must be writable by the current user.
      fs.accessSync(path.dirname(process.env.APPIMAGE), fs.constants.W_OK);
    } catch {
      log(`[Updater] Linux AppImage directory is not writable: ${path.dirname(process.env.APPIMAGE)}. Move SpectorClient to a user-writable folder to enable automatic updates.`, 'updater');
      emitUpdateState('error', { text: 'Linux auto-update needs the SpectorClient AppImage to be in a writable folder.' });
      return;
    }
  }

  updaterInitialized = true;

  // electron-builder embeds the canonical publish provider in app-update.yml.
  // Using that generated file is the officially supported electron-updater path
  // and avoids runtime feed overrides drifting from the release configuration.
  verifyPackagedUpdateConfig();

  // Avoid stale release metadata when a new release has just been published.
  autoUpdater.requestHeaders = {
    ...(autoUpdater.requestHeaders || {}),
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
  };

  log(`[Updater] Automatic updates enabled. Installed launcher version: ${app.getVersion()}.`, 'updater');
  log(`[Updater] Update source: ${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}.`, 'updater');

  autoUpdater.autoDownload = true;
  // Reliability over bandwidth: always download the complete platform package
  // (NSIS on Windows, AppImage on Linux) instead of relying on differential patches.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.allowDowngrade = false;
  // We intentionally control installation ourselves. This prevents an update
  // from installing merely because the launcher is closed while Minecraft is
  // still running.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    log('[Updater] Checking for launcher updates…', 'updater');
    emitUpdateState('checking', { text: 'Checking for launcher updates…' });
  });

  autoUpdater.on('update-available', (info) => {
    updateDownloadInProgress = true;
    lastUpdaterProgressBucket = -1;
    log(`[Updater] SpectorClient ${info.version} is available. Downloading immediately…`, 'updater');
    const updateNoticeBody = (isMinecraftRunning() || gameLaunchInProgress)
      ? `SpectorClient ${info.version} is downloading now and will install automatically after Minecraft closes.`
      : `SpectorClient ${info.version} is downloading automatically.`;
    showNativeNotification(
      'SpectorClient Update Available',
      updateNoticeBody,
      { version: info.version, kind: 'available' }
    );
    emitUpdateState('available', {
      version: info.version,
      text: `SpectorClient ${info.version} is available. Downloading now…`
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    updateDownloadInProgress = false;
    const version = info?.version || app.getVersion();
    log(`[Updater] SpectorClient ${version} is up to date.`, 'updater');
    emitUpdateState('current', { version, text: 'SpectorClient is up to date.' });
  });

  autoUpdater.on('download-progress', (progress) => {
    updateDownloadInProgress = true;
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
    const bucket = Math.floor(percent / 10);
    if (bucket !== lastUpdaterProgressBucket || percent === 100) {
      lastUpdaterProgressBucket = bucket;
      log(`[Updater] Downloading update: ${percent}%`, 'updater');
    }
    emitUpdateState('downloading', {
      percent,
      text: `Downloading launcher update… ${percent}%`
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloadInProgress = false;
    downloadedUpdateInfo = makeIpcSafe(info || {});
    updateInstallPending = true;
    const version = info?.version || 'new version';
    clearUpdaterPolling();

    if (isMinecraftRunning() || gameLaunchInProgress) {
      log(`[Updater] SpectorClient ${version} downloaded. Minecraft is active, so installation will wait for the game to close.`, 'updater');
      emitUpdateState('waiting-for-game', {
        version,
        text: `SpectorClient ${version} downloaded. It will update automatically when Minecraft closes.`
      });
      return;
    }

    log(`[Updater] SpectorClient ${version} downloaded. Installing immediately…`, 'updater');
    emitUpdateState('downloaded', {
      version,
      text: `SpectorClient ${version} downloaded. Installing now…`
    });
    installDownloadedUpdateWhenSafe('download completed');
  });

  autoUpdater.on('error', (error) => {
    if (!updateInstallPending) updateDownloadInProgress = false;
    handleUpdaterError(error, 'Update check failed');
  });

  const check = () => {
    if (updateInstallPending || updateInstallStarting || updateDownloadInProgress) return updaterCheckPromise;
    if (updaterCheckPromise) return updaterCheckPromise;

    updaterCheckPromise = autoUpdater.checkForUpdates()
      .catch((error) => {
        handleUpdaterError(error, 'Could not check for updates');
      })
      .finally(() => {
        updaterCheckPromise = null;
      });

    return updaterCheckPromise;
  };

  // GitHub Releases is polled because desktop clients do not receive a push
  // notification from GitHub. Check almost immediately, then every 15 seconds.
  // The release workflow only exposes a version after all updater artifacts pass
  // verification, so frequent checks cannot observe a half-published release.
  setTimeout(check, 750).unref?.();
  updaterInterval = setInterval(check, 15 * 1000);
  updaterInterval.unref?.();
}

function request(url, { binary = false, redirects = 8, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: binary ? '*/*' : 'application/json',
        ...headers
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        request(next, { binary, redirects: redirects - 1, headers }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const error = new Error(`HTTP ${status} from ${new URL(url).hostname}: ${body.slice(0, 180)}`);
          error.status = status;
          error.body = body;
          error.url = url;
          reject(error);
        });
        return;
      }
      if (binary) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      } else {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Invalid JSON from ${new URL(url).hostname}: ${e.message}`)); }
        });
      }
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${url}`)));
  });
}


function satelliteSnapshot() {
  return makeIpcSafe({ ...satelliteState });
}

function emitSatelliteState(patch = {}) {
  satelliteState = {
    ...satelliteState,
    ...patch,
    endpoint: SATELLITE_BASE_URL,
    secure: SATELLITE_BASE_URL.startsWith('https://'),
    presenceMode: normalizeSocialPresenceMode(patch.presenceMode ?? satelliteState.presenceMode)
  };
  send('social-state', satelliteSnapshot());
}

function clearSatelliteReconnect() {
  if (satelliteReconnectTimer) clearTimeout(satelliteReconnectTimer);
  satelliteReconnectTimer = null;
}

function closeSatelliteSocket() {
  const socket = satelliteSocket;
  satelliteSocket = null;
  if (!socket) return;
  try { socket.removeAllListeners(); } catch {}
  try { socket.close(1000, 'SpectorClient reconnecting'); } catch {}
}

function satelliteHttpRequest(route, { method = 'GET', body = null, token = null, timeoutMs = SATELLITE_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, `${SATELLITE_BASE_URL}/`);
    const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!transport) return reject(new Error(`Unsupported Satellite protocol: ${target.protocol}`));

    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = transport.request(target, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.length > 1024 * 1024) req.destroy(new Error('Satellite response was too large.'));
      });
      res.on('end', () => {
        let data = {};
        try { data = text ? JSON.parse(text) : {}; }
        catch { return reject(new Error(`Satellite returned invalid JSON (HTTP ${res.statusCode || 0}).`)); }

        const status = res.statusCode || 0;
        if (status < 200 || status >= 300 || data.ok === false) {
          const error = new Error(data.message || `Satellite request failed with HTTP ${status}.`);
          error.status = status;
          error.code = data.error || 'SATELLITE_REQUEST_FAILED';
          return reject(error);
        }
        resolve(data);
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Satellite connection timed out.')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function satelliteAuthedRequest(route, options = {}, retry = true) {
  if (!satelliteSessionToken || satelliteSessionExpiresAt <= Date.now() + 30000) {
    await connectSatelliteForSelectedAccount({ force: true });
  }
  try {
    return await satelliteHttpRequest(route, { ...options, token: satelliteSessionToken });
  } catch (error) {
    if (retry && error?.status === 401) {
      await connectSatelliteForSelectedAccount({ force: true });
      return satelliteAuthedRequest(route, options, false);
    }
    throw error;
  }
}

function updateSatelliteFriend(userId, updater) {
  const id = String(userId || '');
  if (!id) return;
  const friends = (satelliteState.friends || []).map((friend) => {
    if (String(friend.id) !== id) return friend;
    return typeof updater === 'function' ? updater(friend) : { ...friend, ...updater };
  });
  emitSatelliteState({ friends });
}

async function refreshSatelliteFriends() {
  if (!satelliteSessionToken) return satelliteSnapshot();
  const data = await satelliteAuthedRequest('/v1/friends');
  emitSatelliteState({
    connection: satelliteSocket?.readyState === WebSocket.OPEN ? 'online' : satelliteState.connection,
    friends: Array.isArray(data.friends) ? data.friends : [],
    incoming: Array.isArray(data.incoming) ? data.incoming : [],
    outgoing: Array.isArray(data.outgoing) ? data.outgoing : [],
    blocked: Array.isArray(data.blocked) ? data.blocked : [],
    error: null
  });
  return satelliteSnapshot();
}

function scheduleSatelliteReconnect(accountId = satelliteAccountId) {
  clearSatelliteReconnect();
  if (satelliteManualDisconnect || !accountId) return;
  satelliteReconnectTimer = setTimeout(async () => {
    satelliteReconnectTimer = null;
    const current = await loadSettings().catch(() => null);
    if (!current || current.selectedAccountId !== accountId) return;
    connectSatelliteForSelectedAccount({ force: true }).catch(() => {});
  }, SATELLITE_RECONNECT_MS);
  satelliteReconnectTimer.unref?.();
}

function normalizeSatelliteServerAddress(value) {
  return String(value || '').trim().replace(/^\//, '') || null;
}

function satellitePresenceActivity(presence) {
  return presence && typeof presence === 'object' && presence.activity && typeof presence.activity === 'object'
    ? presence.activity
    : {};
}

function satellitePresenceIsPlaying(presence) {
  if (!presence?.online) return false;
  const activity = satellitePresenceActivity(presence);
  const text = String(activity.text || '');
  return Boolean(activity.version) && (/^Playing SpectorClient/i.test(text) || Boolean(activity.server));
}

function satelliteDesktopNotificationsEnabled() {
  return normalizeSocialPresenceMode(satelliteState.presenceMode) !== 'dnd';
}

function maybeNotifyFriendPresence(friend, previousPresence, nextPresence) {
  if (!friend?.username || !previousPresence || !nextPresence || !satelliteDesktopNotificationsEnabled()) return;

  const previousActivity = satellitePresenceActivity(previousPresence);
  const nextActivity = satellitePresenceActivity(nextPresence);
  const wasPlaying = satellitePresenceIsPlaying(previousPresence);
  const isPlaying = satellitePresenceIsPlaying(nextPresence);
  const previousServer = normalizeSatelliteServerAddress(previousActivity.server);
  const nextServer = normalizeSatelliteServerAddress(nextActivity.server);

  if (!wasPlaying && isPlaying && nextActivity.version) {
    showNativeNotification(
      'Friend Online',
      `${friend.username} is now playing minecraft ${nextActivity.version}`,
      { kind: 'satellite-friend-playing' }
    );
  }

  if (nextPresence.online && nextServer && nextServer !== previousServer) {
    showNativeNotification(
      'Friend Connected',
      `${friend.username} connected to ${nextServer}`,
      { kind: 'satellite-friend-server' }
    );
  }
}

function detectServerAddressFromGameLog(line) {
  const text = String(line || '');
  let match = text.match(/Connecting to\s+([^\s,]+)\s*,\s*(\d{1,5})/i);
  if (match) return `${match[1]}:${match[2]}`;
  match = text.match(/Connecting to\s+([^\s]+:\d{1,5})/i);
  if (match) return normalizeSatelliteServerAddress(match[1]);
  return null;
}

function gameLogShowsServerDisconnect(line) {
  return /(?:Disconnected|Disconnecting from server|Lost connection|Connection closed)/i.test(String(line || ''));
}

function updateActiveGameServerFromLog(line) {
  if (!activeGameVersion) return;
  const detected = detectServerAddressFromGameLog(line);
  if (detected && detected !== activeGameServerAddress) {
    activeGameServerAddress = detected;
    log(`[Satellite] Detected server connection: ${detected}`, 'debug');
    void sendSatellitePresence();
    return;
  }
  if (activeGameServerAddress && gameLogShowsServerDisconnect(line)) {
    activeGameServerAddress = null;
    void sendSatellitePresence();
  }
}

async function sendSatellitePresence() {
  const current = await loadSettings().catch(() => defaultSettings());
  const presenceMode = normalizeSocialPresenceMode(current.socialPresenceMode);
  emitSatelliteState({ presenceMode });

  // Invisible keeps the authenticated Satellite session available for REST
  // actions (search/messages) but intentionally has no realtime socket. The
  // backend therefore reports this user as offline to friends.
  if (presenceMode === 'invisible') return false;
  if (!satelliteSocket || satelliteSocket.readyState !== WebSocket.OPEN) return false;

  const gameVersion = activeGameVersion || normalizeGameVersion(current.selectedGameVersion);
  const activity = activeGameVersion
    ? {
        server: normalizeSatelliteServerAddress(activeGameServerAddress),
        version: activeGameVersion,
        text: `Playing SpectorClient ${activeGameVersion}`
      }
    : {
        server: null,
        version: gameVersion,
        text: 'In SpectorClient Launcher'
      };
  try {
    satelliteSocket.send(JSON.stringify({ type: 'presence.set', status: presenceMode, activity }));
    return true;
  } catch {
    return false;
  }
}

function handleSatellitePacket(packet) {
  if (!packet || typeof packet !== 'object') return;
  send('social-event', packet);

  if (packet.type === 'hello') {
    emitSatelliteState({
      connection: 'online',
      me: packet.user || satelliteState.me,
      friends: Array.isArray(packet.friends) ? packet.friends : satelliteState.friends,
      incoming: Array.isArray(packet.incoming) ? packet.incoming : satelliteState.incoming,
      outgoing: Array.isArray(packet.outgoing) ? packet.outgoing : satelliteState.outgoing,
      blocked: Array.isArray(packet.blocked) ? packet.blocked : satelliteState.blocked,
      error: null
    });
    void sendSatellitePresence();
    return;
  }

  if (packet.type === 'friends.sync') {
    emitSatelliteState({
      friends: Array.isArray(packet.friends) ? packet.friends : [],
      incoming: Array.isArray(packet.incoming) ? packet.incoming : [],
      outgoing: Array.isArray(packet.outgoing) ? packet.outgoing : [],
      blocked: Array.isArray(packet.blocked) ? packet.blocked : [],
      error: null
    });
    return;
  }

  if (packet.type === 'presence.update') {
    const friend = (satelliteState.friends || []).find((entry) => String(entry.id) === String(packet.userId));
    const previousPresence = friend?.presence || null;
    const nextPresence = packet.presence || { online: false, status: 'offline', activity: null };
    updateSatelliteFriend(packet.userId, (entry) => ({ ...entry, presence: nextPresence }));
    if (friend && previousPresence) maybeNotifyFriendPresence(friend, previousPresence, nextPresence);
    return;
  }

  if (packet.type === 'profile.update' && packet.user?.id) {
    updateSatelliteFriend(packet.user.id, (friend) => ({ ...friend, ...packet.user }));
    return;
  }

  if (packet.type === 'message.new' && packet.message && String(packet.message.to) === String(satelliteState.me?.id || '')) {
    const sender = (satelliteState.friends || []).find((friend) => String(friend.id) === String(packet.message.from));
    const preview = String(packet.message.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (satelliteDesktopNotificationsEnabled()) {
      showNativeNotification(sender?.username || 'Spector Satellite', preview || 'New message', { kind: 'satellite-message' });
    }
  }
  if (packet.type === 'friend.request') {
    if (satelliteDesktopNotificationsEnabled()) {
      showNativeNotification('Friend Request', `${packet.from?.username || 'Someone'} sent you a SpectorClient friend request.`, { kind: 'satellite-friend-request' });
    }
  }

  if (['friend.request', 'friend.accepted', 'friend.denied', 'friend.removed'].includes(packet.type)) {
    refreshSatelliteFriends().catch((error) => log(`[Satellite] Could not refresh friends after ${packet.type}: ${error.message}`, 'debug'));
  }
}

async function connectSatelliteRealtime() {
  if (!satelliteSessionToken) throw new Error('Satellite is not authenticated.');
  const ticketResponse = await satelliteAuthedRequest('/v1/ws-ticket', { method: 'POST' });
  if (!ticketResponse.ticket) throw new Error('Satellite did not provide a realtime ticket.');

  closeSatelliteSocket();
  const wsUrl = new URL(SATELLITE_BASE_URL);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = '/v1/ws';
  wsUrl.search = '';
  wsUrl.searchParams.set('ticket', ticketResponse.ticket);

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl.toString(), { handshakeTimeout: SATELLITE_REQUEST_TIMEOUT_MS });
    satelliteSocket = socket;
    let settled = false;

    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error || 'Satellite realtime connection failed.')));
      }
    };

    socket.once('open', () => {
      settled = true;
      emitSatelliteState({ connection: 'online', error: null });
      void sendSatellitePresence();
      resolve();
    });
    socket.on('message', (raw) => {
      try { handleSatellitePacket(JSON.parse(String(raw))); }
      catch (error) { log(`[Satellite] Ignored invalid realtime packet: ${error.message}`, 'debug'); }
    });
    socket.on('error', (error) => {
      if (!settled) fail(error);
      else log(`[Satellite] Realtime socket error: ${error.message}`, 'debug');
    });
    socket.on('close', () => {
      if (satelliteSocket === socket) satelliteSocket = null;
      if (!satelliteManualDisconnect && satelliteAccountId) {
        emitSatelliteState({ connection: 'offline', error: 'Realtime connection lost. Reconnecting…' });
        scheduleSatelliteReconnect(satelliteAccountId);
      }
    });
  });
}

function resetSatelliteSession({ signedOut = false } = {}) {
  clearSatelliteReconnect();
  closeSatelliteSocket();
  satelliteSessionToken = null;
  satelliteSessionExpiresAt = 0;
  satelliteAccountId = null;
  emitSatelliteState({
    connection: signedOut ? 'signed-out' : 'disconnected',
    accountId: null,
    me: null,
    friends: [],
    incoming: [],
    outgoing: [],
    blocked: [],
    error: null
  });
}

async function connectSatelliteForSelectedAccount({ force = false } = {}) {
  const settings = await loadSettings();
  const account = settings.accounts.find((entry) => entry.id === settings.selectedAccountId) || null;
  if (!account) {
    satelliteManualDisconnect = true;
    resetSatelliteSession({ signedOut: true });
    return satelliteSnapshot();
  }

  const configuredPresenceMode = normalizeSocialPresenceMode(settings.socialPresenceMode);
  emitSatelliteState({ presenceMode: configuredPresenceMode });

  if (!force && satelliteAccountId === account.id && satelliteSessionToken) {
    if (configuredPresenceMode === 'invisible') return satelliteSnapshot();
    if (satelliteSocket?.readyState === WebSocket.OPEN) return satelliteSnapshot();
  }
  if (satelliteConnectPromise) {
    // Account switches can happen while a token exchange is in flight. Let that
    // request settle, then immediately connect the newly selected account rather
    // than accidentally keeping the previous account's Satellite session.
    if (String(satelliteState.accountId || '') !== String(account.id)) {
      await satelliteConnectPromise.catch(() => {});
      return connectSatelliteForSelectedAccount({ force: true });
    }
    return satelliteConnectPromise;
  }

  const targetAccountId = account.id;
  satelliteManualDisconnect = configuredPresenceMode === 'invisible';
  clearSatelliteReconnect();
  closeSatelliteSocket();
  emitSatelliteState({
    connection: 'connecting',
    accountId: targetAccountId,
    me: satelliteAccountId === targetAccountId ? satelliteState.me : null,
    friends: satelliteAccountId === targetAccountId ? satelliteState.friends : [],
    incoming: satelliteAccountId === targetAccountId ? satelliteState.incoming : [],
    outgoing: satelliteAccountId === targetAccountId ? satelliteState.outgoing : [],
    blocked: satelliteAccountId === targetAccountId ? satelliteState.blocked : [],
    error: null
  });

  satelliteConnectPromise = (async () => {
    // Refresh the Minecraft token from prismarine-auth, then exchange it for a
    // Satellite-only token. Satellite tokens never touch settings.json/disk.
    const minecraftSession = await getMinecraftSession(targetAccountId, false);
    const auth = await satelliteHttpRequest('/v1/auth/minecraft', {
      method: 'POST',
      token: minecraftSession.token
    });
    if (!auth.sessionToken) throw new Error('Satellite authentication did not return a session token.');

    const latestSettings = await loadSettings();
    if (latestSettings.selectedAccountId !== targetAccountId) throw new Error('Selected account changed during Satellite sign-in.');

    satelliteSessionToken = auth.sessionToken;
    satelliteSessionExpiresAt = Date.parse(auth.expiresAt || '') || (Date.now() + 30 * 24 * 60 * 60 * 1000);
    satelliteAccountId = targetAccountId;

    const me = await satelliteAuthedRequest('/v1/me', {}, false);
    emitSatelliteState({
      connection: 'connecting',
      accountId: targetAccountId,
      me: me.user || auth.user || null,
      friends: Array.isArray(me.friends) ? me.friends : [],
      incoming: Array.isArray(me.incoming) ? me.incoming : [],
      outgoing: Array.isArray(me.outgoing) ? me.outgoing : [],
      blocked: Array.isArray(me.blocked) ? me.blocked : [],
      error: null
    });
    const latestPresenceMode = normalizeSocialPresenceMode(latestSettings.socialPresenceMode);
    emitSatelliteState({ presenceMode: latestPresenceMode });
    if (latestPresenceMode === 'invisible') {
      satelliteManualDisconnect = true;
      emitSatelliteState({ connection: 'invisible', error: null, presenceMode: 'invisible' });
      log(`[Satellite] Connected as ${auth.user?.username || account.name} in Invisible mode.`, 'launcher');
    } else {
      satelliteManualDisconnect = false;
      await connectSatelliteRealtime();
      log(`[Satellite] Connected as ${auth.user?.username || account.name} to ${SATELLITE_BASE_URL}.`, 'launcher');
    }
    return satelliteSnapshot();
  })().catch((error) => {
    if (satelliteAccountId === targetAccountId || !satelliteAccountId) {
      emitSatelliteState({ connection: 'offline', accountId: targetAccountId, error: error.message || String(error) });
      scheduleSatelliteReconnect(targetAccountId);
    }
    throw error;
  }).finally(() => {
    satelliteConnectPromise = null;
  });

  return satelliteConnectPromise;
}

async function downloadFile(url, destination, label, { silent = false, headers = {} } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.download`;
  await fsp.rm(temp, { force: true }).catch(() => {});

  return new Promise((resolve, reject) => {
    const doDownload = (currentUrl, redirects = 8) => {
      const req = https.get(currentUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers }
      }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
          res.resume();
          doDownload(new URL(res.headers.location, currentUrl).toString(), redirects - 1);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`${label} download failed with HTTP ${status}.`));
          return;
        }

        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const out = fs.createWriteStream(temp);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const percent = Math.min(100, Math.round((received / total) * 100));
            if (!silent) send('install-state', { step: label, text: `Downloading ${label}… ${percent}%`, percent });
          }
        });
        res.pipe(out);
        out.on('finish', async () => {
          out.close();
          try {
            const stat = await fsp.stat(temp);
            if (!stat.size) throw new Error(`${label} downloaded as an empty file.`);
            await fsp.rm(destination, { force: true }).catch(() => {});
            await fsp.rename(temp, destination);
            log(`${label} ready: ${destination}`);
            resolve(destination);
          } catch (e) { reject(e); }
        });
        out.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error(`${label} download timed out.`)));
    };
    doDownload(url);
  }).catch(async (error) => {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  });
}

async function removeMatchingMods(gameVersion, prefix, keepPath) {
  const modsDir = getModsDir(gameVersion);
  const names = await fsp.readdir(modsDir).catch(() => []);
  for (const name of names) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase()) && name.toLowerCase().endsWith('.jar')) {
      const full = path.join(modsDir, name);
      if (path.resolve(full) !== path.resolve(keepPath)) await fsp.rm(full, { force: true }).catch(() => {});
    }
  }
}

async function ensureFabricProfile(gameVersion) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  send('install-state', { step: 'Fabric Loader', text: `Checking Fabric Loader for ${selectedVersion}…`, gameVersion: selectedVersion });
  const loaders = await request(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(selectedVersion)}`);
  if (!Array.isArray(loaders) || !loaders.length) throw new Error(`Fabric Loader does not currently list Minecraft ${selectedVersion}.`);

  const selected = loaders.find((x) => x?.loader?.stable) || loaders[0];
  const loaderVersion = selected?.loader?.version;
  if (!loaderVersion) throw new Error('Could not determine a Fabric Loader version.');

  const profile = await request(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(selectedVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  const versionId = profile?.id || `fabric-loader-${loaderVersion}-${selectedVersion}`;
  const versionDir = instancePath(selectedVersion, 'versions', versionId);
  const versionJson = path.join(versionDir, `${versionId}.json`);
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(versionJson, JSON.stringify(profile, null, 2));
  log(`Fabric Loader ${loaderVersion} profile prepared for ${selectedVersion} (${versionId}).`);
  return { loaderVersion, versionId, gameVersion: selectedVersion };
}

async function ensureFabricApi(gameVersion, { silent = false } = {}) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  if (fabricApiRefreshPromises.has(selectedVersion)) return fabricApiRefreshPromises.get(selectedVersion);

  const refreshPromise = (async () => {
    if (!silent) send('install-state', { step: 'Fabric API', text: `Checking Fabric API for ${selectedVersion}…`, gameVersion: selectedVersion });
    const params = new URLSearchParams({
      loaders: JSON.stringify(['fabric']),
      game_versions: JSON.stringify([selectedVersion]),
      include_changelog: 'false'
    });
    const versions = await request(`${MODRINTH_API}/project/${FABRIC_API_PROJECT}/version?${params.toString()}`);
    if (!Array.isArray(versions) || !versions.length) throw new Error(`No Fabric API build was found for Minecraft ${selectedVersion}.`);

    const sorted = [...versions].sort((a, b) => new Date(b.date_published || 0) - new Date(a.date_published || 0));
    const version = sorted[0];
    const file = version.files?.find((f) => f.primary && f.filename?.endsWith('.jar')) || version.files?.find((f) => f.filename?.endsWith('.jar'));
    if (!file?.url) throw new Error('Fabric API metadata did not contain a downloadable JAR.');

    const filename = path.basename(file.filename || `fabric-api-${version.version_number}.jar`);
    const destination = path.join(getModsDir(selectedVersion), filename);
    const registry = await loadModRegistry(selectedVersion);
    const previous = registry[FABRIC_API_PROJECT] || null;

    await removeMatchingMods(selectedVersion, 'fabric-api-', destination);

    let alreadyLatest = false;
    try {
      const stat = await fsp.stat(destination);
      alreadyLatest = previous?.versionId === version.id
        && stat.size > 0
        && (!file.size || stat.size === Number(file.size));
    } catch {}

    if (!alreadyLatest) {
      await downloadFile(file.url, destination, `Fabric API ${version.version_number}`, { silent });
    } else {
      log(`Fabric API already on latest compatible build for ${selectedVersion}: ${version.version_number}`);
    }

    registry[FABRIC_API_PROJECT] = {
      projectId: FABRIC_API_PROJECT,
      projectSlug: FABRIC_API_PROJECT,
      title: 'Fabric API',
      iconUrl: previous?.iconUrl || '',
      filename,
      versionId: version.id,
      versionNumber: version.version_number || '',
      dependency: false,
      installedAt: previous?.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveModRegistry(selectedVersion, registry);

    return { version: version.version_number, versionId: version.id, filename };
  })();

  fabricApiRefreshPromises.set(selectedVersion, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    fabricApiRefreshPromises.delete(selectedVersion);
  }
}

async function askContinueWithoutSpectorMod(gameVersion, error) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  log(`[SpectorClient ${selectedVersion}] Mod update failed: ${error?.message || error}`, 'warn');

  const result = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'warning',
    title: 'WARNING',
    message: 'WARNING',
    detail: 'We could not update the SpectorClient mod.\nDo you wanna continue without it?',
    buttons: ['YES', 'NO'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });

  return result.response === 0;
}

async function ensureSpectorMod(gameVersion) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const profile = getClientProfile(selectedVersion);
  const modsDir = getModsDir(selectedVersion);
  const destination = path.join(modsDir, SPECTOR_MOD_FILENAME);
  const stagedDestination = path.join(modsDir, `.spectorclient-${selectedVersion}-${process.pid}-${Date.now()}.jar`);
  send('install-state', { step: 'SpectorClient', text: `Refreshing SpectorClient ${selectedVersion} mod…`, gameVersion: selectedVersion });

  const spectorFiles = [SPECTOR_MOD_FILENAME, ...LEGACY_SPECTOR_MOD_FILENAMES];

  try {
    // Download into a staging filename first so a website/network failure does
    // not destroy the user's currently installed SpectorClient jar before they
    // choose whether to continue.
    await downloadFile(profile.modUrl, stagedDestination, `SpectorClient ${selectedVersion} mod`);

    for (const filename of spectorFiles) {
      await fsp.rm(path.join(modsDir, filename), { force: true }).catch(() => {});
    }
    await fsp.rename(stagedDestination, destination);
    log(`SpectorClient ${selectedVersion} mod refreshed from ${profile.modUrl}`);
    return { path: destination, skipped: false };
  } catch (error) {
    await fsp.rm(stagedDestination, { force: true }).catch(() => {});
    const continueWithout = await askContinueWithoutSpectorMod(selectedVersion, error);
    if (!continueWithout) {
      throw new Error(`SpectorClient ${selectedVersion} launch cancelled because the mod could not be updated.`);
    }

    // YES means genuinely continue without SpectorClient rather than silently
    // falling back to a potentially stale/incompatible jar.
    for (const filename of spectorFiles) {
      await fsp.rm(path.join(modsDir, filename), { force: true }).catch(() => {});
    }
    send('install-state', {
      step: 'SpectorClient',
      text: `Continuing Minecraft ${selectedVersion} without the SpectorClient mod.`,
      gameVersion: selectedVersion
    });
    log(`[SpectorClient ${selectedVersion}] User chose YES: continuing without the SpectorClient mod.`, 'warn');
    return { path: null, skipped: true };
  }
}

async function prepareClient(gameVersion = DEFAULT_GAME_VERSION) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  await ensureDirs();
  send('install-state', { step: 'Preparing', text: `Preparing SpectorClient for Minecraft ${selectedVersion}…`, percent: 0, gameVersion: selectedVersion });
  const fabric = await ensureFabricProfile(selectedVersion);
  const api = await ensureFabricApi(selectedVersion);
  const spectorMod = await ensureSpectorMod(selectedVersion);
  send('install-state', {
    step: 'Ready',
    text: spectorMod.skipped
      ? `Minecraft ${selectedVersion} ready without the SpectorClient mod.`
      : `SpectorClient ${selectedVersion} ready.`,
    percent: 100,
    gameVersion: selectedVersion
  });
  return { ...fabric, fabricApiVersion: api.version, spectorModSkipped: spectorMod.skipped, root: getInstanceRoot(selectedVersion) };
}

// ---------------------------
// Content manager: Modrinth + CurseForge
// ---------------------------

const CONTENT_TYPES = Object.freeze({
  mods: {
    key: 'mods', label: 'Mods', singular: 'mod', modrinthType: 'mod', curseForgeClassId: 6,
    extensions: ['.jar'], shared: false, folderName: 'mods', fabricOnly: true
  },
  resourcepacks: {
    key: 'resourcepacks', label: 'Resource Packs', singular: 'resource pack', modrinthType: 'resourcepack', curseForgeClassId: 12,
    extensions: ['.zip'], shared: true, folderName: 'resourcepacks', fabricOnly: false
  },
  shaders: {
    key: 'shaders', label: 'Shaders', singular: 'shader', modrinthType: 'shader', curseForgeClassId: 6552,
    extensions: ['.zip'], shared: true, folderName: 'shaderpacks', fabricOnly: false
  }
});

function normalizeContentType(value) {
  const key = String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'resourcepack' || key === 'resourcepacks') return 'resourcepacks';
  if (key === 'shader' || key === 'shaders' || key === 'shaderpack' || key === 'shaderpacks') return 'shaders';
  return 'mods';
}

function normalizeContentProvider(value) {
  return String(value || '').toLowerCase() === 'curseforge' ? 'curseforge' : 'modrinth';
}

function getContentConfig(contentType) {
  return CONTENT_TYPES[normalizeContentType(contentType)];
}

function getContentDir(contentType, gameVersion = DEFAULT_GAME_VERSION) {
  const config = getContentConfig(contentType);
  return config.shared ? path.join(APPDATA_ROOT, config.folderName) : getModsDir(gameVersion);
}

function getContentRegistryPath(contentType, gameVersion = DEFAULT_GAME_VERSION) {
  const type = normalizeContentType(contentType);
  if (type === 'mods') return getModRegistryPath(gameVersion);
  return launcherDataPath(`${type}-registry.json`);
}

function registryStorageKey(contentType, source, projectId) {
  const type = normalizeContentType(contentType);
  const provider = normalizeContentProvider(source);
  const id = String(projectId || '');
  // Keep the old Modrinth mod registry key format so existing users retain update state.
  return type === 'mods' && provider === 'modrinth' ? id : `${provider}:${id}`;
}

function registryEntryFor(registry, contentType, source, projectId) {
  const provider = normalizeContentProvider(source);
  const id = String(projectId || '');
  return registry[registryStorageKey(contentType, provider, id)]
    || (provider === 'modrinth' ? registry[id] : null)
    || null;
}

async function loadContentRegistry(contentType, gameVersion = DEFAULT_GAME_VERSION) {
  await ensureDirs();
  try {
    const data = JSON.parse(await fsp.readFile(getContentRegistryPath(contentType, gameVersion), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveContentRegistry(contentType, gameVersion, registry) {
  await fsp.writeFile(getContentRegistryPath(contentType, gameVersion), JSON.stringify(registry, null, 2));
}

async function loadModRegistry(gameVersion = DEFAULT_GAME_VERSION) {
  return loadContentRegistry('mods', gameVersion);
}

async function saveModRegistry(gameVersion, registry) {
  return saveContentRegistry('mods', gameVersion, registry);
}

function isCoreModFilename(filename) {
  const lower = String(filename).toLowerCase();
  return lower.startsWith('fabric-api-') || lower === SPECTOR_MOD_FILENAME.toLowerCase() || LEGACY_SPECTOR_MOD_FILENAMES.map((name) => name.toLowerCase()).includes(lower);
}

function contentFilenameAllowed(contentType, filename) {
  const lower = String(filename || '').toLowerCase();
  return getContentConfig(contentType).extensions.some((extension) => lower.endsWith(extension));
}

async function listInstalledContent(gameVersion = DEFAULT_GAME_VERSION, contentType = 'mods') {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  await ensureDirs();
  const registry = await loadContentRegistry(type, selectedVersion);
  const directory = getContentDir(type, selectedVersion);
  await fsp.mkdir(directory, { recursive: true });
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (type === 'mods' && (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar'))) continue;
    if (type !== 'mods' && !entry.isDirectory() && (!entry.isFile() || !contentFilenameAllowed(type, entry.name))) continue;
    const stat = await fsp.stat(path.join(directory, entry.name)).catch(() => null);
    if (!stat) continue;
    const registered = Object.values(registry).find((item) => item?.filename === entry.name) || null;
    const source = registered?.source || (registered?.projectId ? 'modrinth' : '');
    files.push({
      filename: entry.name,
      size: entry.isFile() ? stat.size : 0,
      directory: entry.isDirectory(),
      core: type === 'mods' && isCoreModFilename(entry.name),
      projectId: registered?.projectId ? String(registered.projectId) : '',
      projectSlug: registered?.projectSlug || '',
      pageUrl: registered?.pageUrl || '',
      source,
      contentType: type,
      title: registered?.title || entry.name.replace(/\.(jar|zip)$/i, ''),
      versionNumber: registered?.versionNumber || '',
      versionId: registered?.versionId ? String(registered.versionId) : '',
      iconUrl: registered?.iconUrl || '',
      dependency: Boolean(registered?.dependency),
      gameVersion: selectedVersion
    });
  }

  files.sort((a, b) => Number(b.core) - Number(a.core) || a.title.localeCompare(b.title));
  return files;
}

async function listInstalledMods(gameVersion = DEFAULT_GAME_VERSION) {
  return listInstalledContent(gameVersion, 'mods');
}

function buildModrinthFacets(gameVersion, contentType) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const config = getContentConfig(contentType);
  const facets = [
    [`project_type:${config.modrinthType}`],
    [`versions:${selectedVersion}`]
  ];
  if (config.fabricOnly) {
    facets.splice(1, 0, ['categories:fabric']);
    facets.push([
      'environment:client_and_server',
      'environment:client_only',
      'environment:client_only_server_optional',
      'environment:client_or_server',
      'environment:client_or_server_prefers_both',
      'environment:unknown'
    ]);
  }
  return facets;
}

function modrinthPageUrl(contentType, slug) {
  const config = getContentConfig(contentType);
  const segment = config.modrinthType === 'resourcepack' ? 'resourcepack' : config.modrinthType;
  return slug ? `https://modrinth.com/${segment}/${encodeURIComponent(slug)}` : 'https://modrinth.com/';
}

async function searchModrinthContent(gameVersion, contentType, query, page = 1) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  const q = String(query || '').trim().slice(0, 100);
  const safePage = Math.max(1, Math.min(10000, Number.parseInt(page, 10) || 1));
  const offset = (safePage - 1) * MODRINTH_PAGE_SIZE;
  const params = new URLSearchParams({
    query: q,
    facets: JSON.stringify(buildModrinthFacets(selectedVersion, type)),
    limit: String(MODRINTH_PAGE_SIZE),
    offset: String(offset),
    index: q ? 'relevance' : 'downloads'
  });
  const data = await request(`${MODRINTH_API}/search?${params.toString()}`);
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  const total = Math.max(0, Number(data?.total_hits ?? (offset + hits.length)) || 0);
  const totalPages = Math.max(1, Math.ceil(total / MODRINTH_PAGE_SIZE));
  return {
    provider: 'modrinth', contentType: type, gameVersion: selectedVersion,
    items: hits.map((hit) => ({
      source: 'modrinth', contentType: type, projectId: String(hit.project_id || ''), slug: hit.slug || '',
      pageUrl: modrinthPageUrl(type, hit.slug || ''), title: hit.title || hit.slug || `Untitled ${config.singular}`,
      description: hit.description || '', author: hit.author || '', iconUrl: hit.icon_url || '', downloads: Number(hit.downloads || 0),
      categories: Array.isArray(hit.display_categories) ? hit.display_categories.slice(0, 5) : []
    })),
    total, page: Math.min(safePage, totalPages), pageSize: MODRINTH_PAGE_SIZE, totalPages
  };
}

function isCurseForgeAuthError(error) {
  const status = Number(error?.status || 0);
  return status === 401 || status === 403 || /API Key missing or invalid/i.test(String(error?.message || ''));
}

async function curseForgeCoreRequest(endpoint) {
  if (!CURSEFORGE_API_KEY) {
    const error = new Error('CurseForge Core API key is unavailable.');
    error.status = 403;
    throw error;
  }
  const url = endpoint.startsWith('http') ? endpoint : `${CURSEFORGE_API}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  return request(url, { headers: { 'x-api-key': CURSEFORGE_API_KEY } });
}

async function curseForgeWebRequest(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${CURSEFORGE_WEB_API}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  return request(url, {
    headers: {
      Referer: 'https://www.curseforge.com/minecraft/',
      'Cache-Control': 'no-cache'
    }
  });
}

async function curseForgeRequest(endpoint, { webFallback = true } = {}) {
  if (!curseForgeCoreRejected) {
    try {
      return await curseForgeCoreRequest(endpoint);
    } catch (error) {
      if (!isCurseForgeAuthError(error) || !webFallback) throw error;
      curseForgeCoreRejected = true;
      log('[Content] CurseForge Core API rejected the bundled key; switching to CurseForge web fallback.', 'launcher');
    }
  }
  if (!webFallback) return curseForgeCoreRequest(endpoint);
  return curseForgeWebRequest(endpoint);
}

async function searchCurseForgeContent(gameVersion, contentType, query, page = 1) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  const q = String(query || '').trim().slice(0, 100);
  const safePage = Math.max(1, Math.min(417, Number.parseInt(page, 10) || 1));
  const index = (safePage - 1) * CURSEFORGE_PAGE_SIZE;
  const params = new URLSearchParams({
    gameId: String(CURSEFORGE_GAME_ID),
    classId: String(config.curseForgeClassId),
    gameVersion: selectedVersion,
    index: String(index),
    pageSize: String(CURSEFORGE_PAGE_SIZE),
    sortField: '2',
    sortOrder: 'desc'
  });
  if (q) params.set('searchFilter', q);
  if (config.fabricOnly) params.set('modLoaderType', '4');
  const data = await curseForgeRequest(`/mods/search?${params.toString()}`);
  const hits = Array.isArray(data?.data) ? data.data : [];
  for (const hit of hits) {
    const id = String(hit?.id || '');
    if (id) curseForgeProjectCache.set(id, hit);
  }
  const total = Math.max(0, Number(data?.pagination?.totalCount ?? (index + hits.length)) || 0);
  const totalPages = Math.max(1, Math.ceil(total / CURSEFORGE_PAGE_SIZE));
  return {
    provider: 'curseforge', contentType: type, gameVersion: selectedVersion,
    items: hits.map((hit) => ({
      source: 'curseforge', contentType: type, projectId: String(hit.id || ''), slug: hit.slug || '',
      pageUrl: hit?.links?.websiteUrl || `https://www.curseforge.com/minecraft/${type === 'mods' ? 'mc-mods' : type === 'resourcepacks' ? 'texture-packs' : 'shaders'}/${encodeURIComponent(hit.slug || '')}`, title: hit.name || hit.slug || `Untitled ${config.singular}`,
      description: hit.summary || '', author: hit?.authors?.[0]?.name || '',
      iconUrl: hit?.logo?.thumbnailUrl || hit?.logo?.url || '', downloads: Number(hit.downloadCount || 0),
      categories: Array.isArray(hit.categories) ? hit.categories.slice(0, 5).map((item) => item?.name || '').filter(Boolean) : []
    })),
    total, page: Math.min(safePage, totalPages), pageSize: CURSEFORGE_PAGE_SIZE, totalPages
  };
}

async function searchContent(gameVersion, contentType, provider, query, page = 1) {
  return normalizeContentProvider(provider) === 'curseforge'
    ? searchCurseForgeContent(gameVersion, contentType, query, page)
    : searchModrinthContent(gameVersion, contentType, query, page);
}

async function getCompatibleModrinthProjectVersion(gameVersion, contentType, projectId, preferRelease = true) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  const params = new URLSearchParams({
    game_versions: JSON.stringify([selectedVersion]),
    include_changelog: 'false'
  });
  if (config.fabricOnly) params.set('loaders', JSON.stringify(['fabric']));
  const versions = await request(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
  if (!Array.isArray(versions) || !versions.length) {
    throw new Error(`No compatible Minecraft ${selectedVersion} ${config.singular} version is available.`);
  }
  const sorted = [...versions].sort((a, b) => new Date(b.date_published || 0) - new Date(a.date_published || 0));
  return preferRelease ? (sorted.find((v) => v.version_type === 'release') || sorted[0]) : sorted[0];
}

async function getCompatibleProjectVersion(gameVersion, projectId, preferRelease = true) {
  return getCompatibleModrinthProjectVersion(gameVersion, 'mods', projectId, preferRelease);
}

async function getCurseForgeProject(projectId) {
  const id = String(projectId || '');
  const cached = curseForgeProjectCache.get(id);
  if (cached) return cached;
  try {
    const data = await curseForgeCoreRequest(`/mods/${encodeURIComponent(id)}`);
    if (data?.data) {
      curseForgeProjectCache.set(id, data.data);
      return data.data;
    }
  } catch (error) {
    if (!isCurseForgeAuthError(error)) throw error;
    curseForgeCoreRejected = true;
  }
  return {
    id: Number(id) || id,
    name: `CurseForge Project ${id}`,
    slug: '',
    links: { websiteUrl: 'https://www.curseforge.com/minecraft' },
    logo: null
  };
}

function curseForgeFileMatches(file, selectedVersion, config) {
  if (!file || file.isAvailable === false) return false;
  const versions = Array.isArray(file.gameVersions) ? file.gameVersions.map((v) => String(v).toLowerCase()) : [];
  if (versions.length && !versions.includes(String(selectedVersion).toLowerCase())) return false;
  if (config.fabricOnly && versions.length && !versions.some((v) => v === 'fabric' || v.includes('fabric'))) return false;
  return true;
}

async function getCompatibleCurseForgeFile(gameVersion, contentType, projectId) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  let data;
  if (!curseForgeCoreRejected) {
    const params = new URLSearchParams({ gameVersion: selectedVersion, pageSize: '50' });
    if (config.fabricOnly) params.set('modLoaderType', '4');
    try {
      data = await curseForgeCoreRequest(`/mods/${encodeURIComponent(projectId)}/files?${params.toString()}`);
    } catch (error) {
      if (!isCurseForgeAuthError(error)) throw error;
      curseForgeCoreRejected = true;
      log('[Content] CurseForge file lookup switched to the web fallback.', 'launcher');
    }
  }
  if (!data) {
    const webParams = new URLSearchParams({
      pageIndex: '0', pageSize: '50', sort: 'dateCreated', sortDescending: 'true', removeAlphas: 'false'
    });
    data = await curseForgeWebRequest(`/mods/${encodeURIComponent(projectId)}/files?${webParams.toString()}`);
  }
  const files = Array.isArray(data?.data) ? data.data.filter((file) => curseForgeFileMatches(file, selectedVersion, config)) : [];
  if (!files.length) throw new Error(`No compatible CurseForge ${config.singular} file was found for Minecraft ${selectedVersion}.`);
  files.sort((a, b) => {
    const releaseDelta = Number(a.releaseType || 9) - Number(b.releaseType || 9);
    return releaseDelta || (new Date(b.fileDate || b.dateCreated || 0) - new Date(a.fileDate || a.dateCreated || 0));
  });
  return files[0];
}

async function getContentStatuses(gameVersion, contentType, provider, projectIds) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const source = normalizeContentProvider(provider);
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 60);
  const registry = await loadContentRegistry(type, selectedVersion);
  const statuses = {};
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const installed = registryEntryFor(registry, type, source, id);
      try {
        const latest = source === 'curseforge'
          ? await getCompatibleCurseForgeFile(selectedVersion, type, id)
          : await getCompatibleModrinthProjectVersion(selectedVersion, type, id, id !== FABRIC_API_PROJECT);
        const latestVersionId = source === 'curseforge' ? String(latest?.id || '') : String(latest?.id || '');
        const latestVersionNumber = source === 'curseforge' ? (latest?.displayName || latest?.fileName || '') : (latest?.version_number || '');
        statuses[id] = {
          projectId: id, source, installed: Boolean(installed),
          installedVersionId: installed?.versionId ? String(installed.versionId) : '',
          installedVersionNumber: installed?.versionNumber || '', latestVersionId, latestVersionNumber,
          updateAvailable: Boolean(installed?.versionId && latestVersionId && String(installed.versionId) !== latestVersionId)
        };
      } catch (error) {
        statuses[id] = {
          projectId: id, source, installed: Boolean(installed),
          installedVersionId: installed?.versionId ? String(installed.versionId) : '',
          installedVersionNumber: installed?.versionNumber || '', latestVersionId: '', latestVersionNumber: '',
          updateAvailable: false, error: error.message
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, ids.length || 1) }, () => worker()));
  return statuses;
}

async function getModrinthProjectStatuses(gameVersion, projectIds) {
  return getContentStatuses(gameVersion, 'mods', 'modrinth', projectIds);
}

function pickModrinthContentFile(version, contentType) {
  const type = normalizeContentType(contentType);
  const files = Array.isArray(version?.files) ? version.files : [];
  const config = getContentConfig(type);
  const allowed = (file) => config.extensions.some((ext) => String(file?.filename || '').toLowerCase().endsWith(ext));
  return files.find((file) => file.primary && allowed(file) && !file.file_type)
    || files.find((file) => allowed(file) && !file.file_type)
    || files.find(allowed)
    || null;
}

function pickVersionJar(version) {
  return pickModrinthContentFile(version, 'mods');
}

async function resolveRequiredDependencyVersion(gameVersion, dep) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  if (dep?.version_id) {
    const exact = await request(`${MODRINTH_API}/version/${encodeURIComponent(dep.version_id)}`);
    const exactLoaders = Array.isArray(exact?.loaders) ? exact.loaders : [];
    const exactGameVersions = Array.isArray(exact?.game_versions) ? exact.game_versions : [];
    const exactCompatible = (!exactLoaders.length || exactLoaders.includes('fabric'))
      && (!exactGameVersions.length || exactGameVersions.includes(selectedVersion));
    if (exactCompatible) return exact;
    if (dep.project_id) return getCompatibleModrinthProjectVersion(selectedVersion, 'mods', dep.project_id);
    throw new Error(`Pinned dependency version is not compatible with Fabric ${selectedVersion}.`);
  }
  if (dep?.project_id) return getCompatibleModrinthProjectVersion(selectedVersion, 'mods', dep.project_id);
  if (dep?.file_name) throw new Error(`Required dependency ${dep.file_name} has no Modrinth project/version ID and cannot be downloaded automatically.`);
  throw new Error('A required dependency is missing its Modrinth project/version ID.');
}

async function installModrinthContentVersion(gameVersion, contentType, version, { dependency = false, visited = new Set() } = {}) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  if (!version?.id) throw new Error('Invalid Modrinth version metadata.');
  const visitKey = `modrinth:${type}:${version.id}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  if (type === 'mods') {
    const loaders = Array.isArray(version.loaders) ? version.loaders : [];
    const gameVersions = Array.isArray(version.game_versions) ? version.game_versions : [];
    if (loaders.length && !loaders.includes('fabric')) throw new Error('A required dependency is not available for Fabric.');
    if (gameVersions.length && !gameVersions.includes(selectedVersion)) throw new Error(`A required dependency is not compatible with Minecraft ${selectedVersion}.`);
    const requiredDependencies = (version.dependencies || []).filter((d) => d.dependency_type === 'required');
    for (const dep of requiredDependencies) {
      const depVersion = await resolveRequiredDependencyVersion(selectedVersion, dep);
      send('mod-install-state', { state: 'dependency', projectId: version.project_id, dependencyProjectId: depVersion?.project_id || dep.project_id || '', gameVersion: selectedVersion, contentType: type, text: `Installing required dependency for ${selectedVersion}…` });
      await installModrinthContentVersion(selectedVersion, 'mods', depVersion, { dependency: true, visited });
    }
  }

  const project = await request(`${MODRINTH_API}/project/${encodeURIComponent(version.project_id)}`);
  if (type === 'mods' && project?.slug === FABRIC_API_PROJECT) {
    await ensureFabricApi(selectedVersion);
    return { title: project.title || 'Fabric API', core: true, source: 'modrinth', projectId: FABRIC_API_PROJECT };
  }

  const file = pickModrinthContentFile(version, type);
  if (!file?.url || !file?.filename) throw new Error(`This Modrinth ${config.singular} version does not contain an installable ${config.extensions.join('/')} file.`);
  const filename = path.basename(file.filename);
  const directory = getContentDir(type, selectedVersion);
  const destination = path.join(directory, filename);
  const registry = await loadContentRegistry(type, selectedVersion);
  const key = registryStorageKey(type, 'modrinth', version.project_id);
  const previous = registry[key] || (type === 'mods' ? registry[String(version.project_id)] : null);

  if (previous?.filename && previous.filename !== filename && !(type === 'mods' && isCoreModFilename(previous.filename))) {
    await fsp.rm(path.join(directory, path.basename(previous.filename)), { force: true, recursive: true }).catch(() => {});
  }

  let alreadyInstalled = false;
  try {
    const stat = await fsp.stat(destination);
    alreadyInstalled = previous?.versionId === version.id && stat.size > 0 && (!file.size || stat.size === Number(file.size));
  } catch {}

  if (!alreadyInstalled) {
    send('mod-install-state', { state: 'downloading', projectId: version.project_id, gameVersion: selectedVersion, contentType: type, provider: 'modrinth', text: `Installing ${project?.title || filename} from Modrinth…` });
    await downloadFile(file.url, destination, project?.title || filename);
  }

  registry[key] = {
    source: 'modrinth', contentType: type, projectId: String(version.project_id), projectSlug: project?.slug || '',
    pageUrl: modrinthPageUrl(type, project?.slug || ''), title: project?.title || filename.replace(/\.(jar|zip)$/i, ''),
    iconUrl: project?.icon_url || '', filename, versionId: String(version.id), versionNumber: version.version_number || '',
    dependency: Boolean(dependency), installedAt: previous?.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  if (key !== String(version.project_id) && registry[String(version.project_id)]?.source === 'modrinth') delete registry[String(version.project_id)];
  await saveContentRegistry(type, selectedVersion, registry);
  log(`${alreadyInstalled ? 'Verified' : 'Installed'} ${selectedVersion} Modrinth ${config.singular}: ${registry[key].title} ${registry[key].versionNumber}`);
  return registry[key];
}

async function installModrinthContent(gameVersion, contentType, projectId) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  const id = String(projectId || '').trim();
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(id)) throw new Error('Invalid Modrinth project ID.');
  if (type === 'mods') await ensureFabricApi(selectedVersion, { silent: true });
  const registryBefore = await loadContentRegistry(type, selectedVersion);
  const previous = registryEntryFor(registryBefore, type, 'modrinth', id);
  send('mod-install-state', { state: 'resolving', projectId: id, gameVersion: selectedVersion, contentType: type, provider: 'modrinth', text: `Finding a compatible Modrinth ${config.singular} for ${selectedVersion}…` });
  const version = await getCompatibleModrinthProjectVersion(selectedVersion, type, id);
  const installed = await installModrinthContentVersion(selectedVersion, type, version, { dependency: false, visited: new Set() });
  const action = previous ? (String(previous.versionId) === String(version.id) ? 'verified' : 'updated') : 'installed';
  send('mod-install-state', { state: 'complete', projectId: id, gameVersion: selectedVersion, contentType: type, provider: 'modrinth', text: `${installed?.title || config.label} ${action} from Modrinth.` });
  return { installed, action, gameVersion: selectedVersion, contentType: type, provider: 'modrinth', items: await listInstalledContent(selectedVersion, type) };
}

async function installModrinthProject(gameVersion, projectId) {
  const result = await installModrinthContent(gameVersion, 'mods', projectId);
  return { ...result, mods: result.items };
}

async function getCurseForgeDownloadUrl(projectId, fileId) {
  if (!curseForgeCoreRejected) {
    try {
      const response = await curseForgeCoreRequest(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download-url`);
      const url = String(response?.data || '').trim();
      if (/^https:\/\//i.test(url)) return { url, useApiKey: true };
    } catch (error) {
      if (!isCurseForgeAuthError(error)) throw error;
      curseForgeCoreRejected = true;
      log('[Content] CurseForge download switched to the web fallback.', 'launcher');
    }
  }
  return {
    url: `${CURSEFORGE_WEB_API}/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download`,
    useApiKey: false
  };
}

async function installCurseForgeContent(gameVersion, contentType, projectId, { dependency = false, visited = new Set() } = {}) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const config = getContentConfig(type);
  const id = String(projectId || '').trim();
  if (!/^\d{1,12}$/.test(id)) throw new Error('Invalid CurseForge project ID.');
  const visitKey = `curseforge:${type}:${id}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);
  if (type === 'mods' && !dependency) await ensureFabricApi(selectedVersion, { silent: true });

  const project = await getCurseForgeProject(id);
  if (!project) throw new Error('CurseForge project metadata was unavailable.');
  if (type === 'mods' && String(project.slug || '').toLowerCase() === FABRIC_API_PROJECT) {
    await ensureFabricApi(selectedVersion);
    return { title: project.name || 'Fabric API', core: true, source: 'modrinth', projectId: FABRIC_API_PROJECT };
  }
  const file = await getCompatibleCurseForgeFile(selectedVersion, type, id);

  if (type === 'mods') {
    const requiredDeps = (Array.isArray(file.dependencies) ? file.dependencies : []).filter((dep) => Number(dep?.relationType) === 3 && dep?.modId);
    for (const dep of requiredDeps) {
      send('mod-install-state', { state: 'dependency', projectId: id, dependencyProjectId: String(dep.modId), gameVersion: selectedVersion, contentType: type, provider: 'curseforge', text: `Installing required CurseForge dependency for ${selectedVersion}…` });
      await installCurseForgeContent(selectedVersion, 'mods', String(dep.modId), { dependency: true, visited });
    }
  }

  const filename = path.basename(String(file.fileName || ''));
  if (!filename || !contentFilenameAllowed(type, filename)) throw new Error(`The selected CurseForge file is not a supported ${config.extensions.join('/')} file.`);
  const directory = getContentDir(type, selectedVersion);
  const destination = path.join(directory, filename);
  const registry = await loadContentRegistry(type, selectedVersion);
  const key = registryStorageKey(type, 'curseforge', id);
  const previous = registry[key] || null;
  if (previous?.filename && previous.filename !== filename) {
    await fsp.rm(path.join(directory, path.basename(previous.filename)), { force: true, recursive: true }).catch(() => {});
  }

  let alreadyInstalled = false;
  try {
    const stat = await fsp.stat(destination);
    alreadyInstalled = String(previous?.versionId || '') === String(file.id || '') && stat.size > 0 && (!file.fileLength || stat.size === Number(file.fileLength));
  } catch {}

  if (!alreadyInstalled) {
    send('mod-install-state', { state: 'downloading', projectId: id, gameVersion: selectedVersion, contentType: type, provider: 'curseforge', text: `Installing ${project.name || filename} from CurseForge…` });
    const download = await getCurseForgeDownloadUrl(id, file.id);
    await downloadFile(download.url, destination, project.name || filename, {
      headers: download.useApiKey ? { 'x-api-key': CURSEFORGE_API_KEY } : { Referer: 'https://www.curseforge.com/minecraft/' }
    });
  }

  registry[key] = {
    source: 'curseforge', contentType: type, projectId: id, projectSlug: project.slug || '',
    pageUrl: project?.links?.websiteUrl || '', title: project.name || filename.replace(/\.(jar|zip)$/i, ''),
    iconUrl: project?.logo?.thumbnailUrl || project?.logo?.url || '', filename, versionId: String(file.id || ''),
    versionNumber: file.displayName || file.fileName || '', dependency: Boolean(dependency),
    installedAt: previous?.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await saveContentRegistry(type, selectedVersion, registry);
  log(`${alreadyInstalled ? 'Verified' : 'Installed'} ${selectedVersion} CurseForge ${config.singular}: ${registry[key].title}`);
  return registry[key];
}

async function installContent(gameVersion, contentType, provider, projectId) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const source = normalizeContentProvider(provider);
  const registryBefore = await loadContentRegistry(type, selectedVersion);
  const previous = registryEntryFor(registryBefore, type, source, projectId);
  const installed = source === 'curseforge'
    ? await installCurseForgeContent(selectedVersion, type, projectId, { dependency: false, visited: new Set() })
    : (await installModrinthContent(selectedVersion, type, projectId)).installed;
  const latestVersionId = installed?.versionId ? String(installed.versionId) : '';
  const action = previous ? (String(previous.versionId || '') === latestVersionId ? 'verified' : 'updated') : 'installed';
  return { installed, action, gameVersion: selectedVersion, contentType: type, provider: source, items: await listInstalledContent(selectedVersion, type) };
}

async function removeInstalledContent(gameVersion, contentType, filename) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  const safeName = path.basename(String(filename || ''));
  if (!safeName || safeName !== String(filename || '')) throw new Error('Invalid content filename.');
  if (type === 'mods') {
    if (!safeName.toLowerCase().endsWith('.jar')) throw new Error('Invalid mod filename.');
    if (isCoreModFilename(safeName)) throw new Error('Fabric API and SpectorClient are required core mods and cannot be removed here.');
  }
  const directory = getContentDir(type, selectedVersion);
  await fsp.rm(path.join(directory, safeName), { force: true, recursive: true });
  const registry = await loadContentRegistry(type, selectedVersion);
  for (const [key, item] of Object.entries(registry)) {
    if (item?.filename === safeName) delete registry[key];
  }
  await saveContentRegistry(type, selectedVersion, registry);
  log(`Removed ${selectedVersion} ${getContentConfig(type).singular}: ${safeName}`);
  return listInstalledContent(selectedVersion, type);
}

async function removeInstalledMod(gameVersion, filename) {
  return removeInstalledContent(gameVersion, 'mods', filename);
}

async function searchModrinthMods(gameVersion, query, page = 1) {
  return searchModrinthContent(gameVersion, 'mods', query, page);
}

// ---------------------------
// Microsoft authentication
// ---------------------------

function buildMicrosoftDirectVerificationUrl(code) {
  const userCode = code.user_code || code.userCode || '';
  const verificationUri = code.verification_uri || code.verificationUri || 'https://microsoft.com/link';
  const providedComplete = code.verification_uri_complete || code.verificationUriComplete || code.direct_verification_uri || code.directVerificationUri || '';

  // Prefer a complete URI supplied by the identity provider when available.
  if (providedComplete) return providedComplete;
  if (!userCode) return verificationUri;

  // Microsoft's consumer/link page accepts an OTC value that pre-populates the
  // device code. Keep the plain verification URI as a fallback in the UI.
  try {
    const url = new URL(verificationUri);
    const host = url.hostname.toLowerCase();
    if (host === 'microsoft.com' || host.endsWith('.microsoft.com') || host === 'microsoftonline.com' || host.endsWith('.microsoftonline.com')) {
      url.searchParams.set('otc', userCode);
      return url.toString();
    }
  } catch (_) {
    // Fall through to the known Microsoft link endpoint.
  }

  return `https://www.microsoft.com/link?otc=${encodeURIComponent(userCode)}`;
}

function authFlowFor(accountId, forceRefresh = false) {
  const cacheDir = launcherDataPath('accounts', accountId);
  fs.mkdirSync(cacheDir, { recursive: true });

  return new Authflow(
    accountId,
    cacheDir,
    forceRefresh ? { flow: 'live', forceRefresh: true } : undefined,
    (code) => {
      const userCode = code.user_code || code.userCode || '';
      const verificationUri = code.verification_uri || code.verificationUri || 'https://microsoft.com/link';
      const directVerificationUri = buildMicrosoftDirectVerificationUrl(code);
      const payload = {
        userCode,
        verificationUri,
        directVerificationUri,
        message: userCode
          ? 'Microsoft sign-in opened with your code prefilled. Sign in and continue.'
          : (code.message || '')
      };
      send('auth-code', payload);
      if (directVerificationUri) shell.openExternal(directVerificationUri);
    }
  );
}

async function getMinecraftSession(accountId, forceRefresh = false) {
  const flow = authFlowFor(accountId, forceRefresh);
  const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
  if (!result?.token || !result?.profile) {
    throw new Error('Microsoft sign-in completed, but no Minecraft Java profile was returned. Make sure the account owns Minecraft Java Edition.');
  }
  return result;
}

function toMclcAuthorization(session) {
  return {
    access_token: session.token,
    client_token: crypto.randomUUID(),
    uuid: session.profile.id,
    name: session.profile.name,
    user_properties: '{}',
    meta: { type: 'msa', demo: false, xuid: '', clientId: '' }
  };
}

function bindLauncherEvents() {
  if (launcherEventsBound) return;
  launcherEventsBound = true;
  launcher.on('debug', (line) => log(line, 'debug'));
  launcher.on('data', (line) => {
    log(line, 'game');
    updateActiveGameServerFromLog(line);
  });
}

// ---------------------------
// IPC
// ---------------------------

ipcMain.handle('settings:get', async () => ({ ...(await loadSettings()), gameDirectory: APPDATA_ROOT }));
ipcMain.handle('settings:save', async (_event, next) => {
  const saved = await saveSettings(next);
  applyUiScale(saved.uiScale);
  pushThemeToLogWindow(saved.theme);
  return { ...saved, gameDirectory: APPDATA_ROOT };
});
ipcMain.handle('appearance:set-theme', async (_event, theme) => {
  const normalized = normalizeLauncherTheme(theme);
  const current = await loadSettings();
  const saved = await saveSettings({ ...current, theme: normalized });
  pushThemeToLogWindow(normalized);
  return { ...saved, gameDirectory: APPDATA_ROOT };
});
ipcMain.handle('logs:open', async (_event, theme) => {
  let normalized = normalizeLauncherTheme(theme);
  if (!theme) normalized = normalizeLauncherTheme((await loadSettings()).theme);
  createLogWindow(normalized);
  return true;
});
ipcMain.handle('logs:get-history', async () => logBuffer.slice());
ipcMain.handle('logs:clear', async () => {
  logBuffer.length = 0;
  send('logs-cleared', true);
  if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('logs-cleared', true);
  return true;
});

ipcMain.handle('account:skin-data', async (_event, accountId) => {
  const settings = await loadSettings();
  const account = settings.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Account not found.');

  const preferred = /^https:\/\//i.test(account.skinUrl || '')
    ? account.skinUrl
    : `https://mc-heads.net/skin/${encodeURIComponent(account.uuid)}`;
  try {
    const bytes = await request(preferred, { binary: true });
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch (error) {
    const fallback = `https://mc-heads.net/skin/${encodeURIComponent(account.uuid)}`;
    if (preferred === fallback) throw error;
    const bytes = await request(fallback, { binary: true });
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }
});

ipcMain.handle('client:info', async () => ({
  productName: PRODUCT_NAME,
  platform: process.platform,
  gameDirectory: APPDATA_ROOT,
  defaultGameVersion: DEFAULT_GAME_VERSION,
  supportedVersions: Object.keys(CLIENT_PROFILES).map((gameVersion) => ({
    gameVersion,
    label: CLIENT_PROFILES[gameVersion].label,
    modsDirectory: getModsDir(gameVersion),
    resourcepacksDirectory: getContentDir('resourcepacks', gameVersion),
    shadersDirectory: getContentDir('shaders', gameVersion),
    modUrl: CLIENT_PROFILES[gameVersion].modUrl,
    javaMajor: CLIENT_PROFILES[gameVersion].javaMajor
  })),
  managedJavaPaths: {
    25: managedJavaPath(25),
    21: managedJavaPath(21)
  }
}));
ipcMain.handle('client:prepare', async (_event, gameVersion) => prepareClient(gameVersion));
ipcMain.handle('game:get-status', async () => ({
  running: Boolean(activeGameProcess && activeGameProcess.exitCode == null),
  pid: activeGameProcess?.pid || null,
  gameVersion: activeGameVersion
}));

ipcMain.handle('window:control', async (_event, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  else if (action === 'close') mainWindow.close();
  else throw new Error('Unknown window action.');
  return true;
});

ipcMain.handle('dialog:choose-java', async (_event, major = 25) => {
  const expectedMajor = Number(major) === 21 ? 21 : 25;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Select Java ${expectedMajor} executable`,
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : []
  });
  if (result.canceled) return null;

  const selected = result.filePaths[0];
  const inspection = await inspectJava(selected, expectedMajor);
  if (!inspection.ok) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: `Invalid Java ${expectedMajor}`,
      message: `That executable cannot be used for Java ${expectedMajor}.`,
      detail: inspection.reason || `The selected executable does not report Java ${expectedMajor}.`
    });
    return null;
  }
  return selected;
});

ipcMain.handle('folder:open-client', async () => {
  await ensureDirs();
  await shell.openPath(APPDATA_ROOT);
  return true;
});

ipcMain.handle('folder:open-mods', async (_event, gameVersion) => {
  const selectedVersion = normalizeGameVersion(gameVersion);
  await ensureDirs();
  await shell.openPath(getModsDir(selectedVersion));
  return true;
});
ipcMain.handle('folder:open-content', async (_event, gameVersion, contentType) => {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  await ensureDirs();
  const directory = getContentDir(type, selectedVersion);
  await fsp.mkdir(directory, { recursive: true });
  await shell.openPath(directory);
  return true;
});

ipcMain.handle('content:list', async (_event, gameVersion, contentType) => {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const type = normalizeContentType(contentType);
  if (type === 'mods') await ensureFabricApi(selectedVersion, { silent: true }).catch((error) => log(`Fabric API ${selectedVersion} content-list update check failed: ${error.message}`, 'debug'));
  return listInstalledContent(selectedVersion, type);
});
ipcMain.handle('content:search', async (_event, gameVersion, contentType, provider, query, page) => searchContent(gameVersion, contentType, provider, query, page));
ipcMain.handle('content:statuses', async (_event, gameVersion, contentType, provider, projectIds) => getContentStatuses(gameVersion, contentType, provider, projectIds));
ipcMain.handle('content:install', async (_event, gameVersion, contentType, provider, projectId) => installContent(gameVersion, contentType, provider, projectId));
ipcMain.handle('content:remove', async (_event, gameVersion, contentType, filename) => removeInstalledContent(gameVersion, contentType, filename));

// Backward-compatible Modrinth mod IPC names used by older renderer builds.
ipcMain.handle('mods:list', async (_event, gameVersion) => listInstalledContent(gameVersion, 'mods'));
ipcMain.handle('mods:search', async (_event, gameVersion, query, page) => searchModrinthContent(gameVersion, 'mods', query, page));
ipcMain.handle('mods:statuses', async (_event, gameVersion, projectIds) => getContentStatuses(gameVersion, 'mods', 'modrinth', projectIds));
ipcMain.handle('mods:install', async (_event, gameVersion, projectId) => installModrinthProject(gameVersion, projectId));
ipcMain.handle('mods:remove', async (_event, gameVersion, filename) => removeInstalledMod(gameVersion, filename));


ipcMain.handle('social:get-state', async () => satelliteSnapshot());
ipcMain.handle('social:connect', async () => connectSatelliteForSelectedAccount({ force: false }));
ipcMain.handle('social:reconnect', async () => connectSatelliteForSelectedAccount({ force: true }));
ipcMain.handle('social:search', async (_event, query) => {
  const q = String(query || '').trim();
  if (!q) return { ok: true, users: [] };
  return satelliteAuthedRequest(`/v1/users/search?q=${encodeURIComponent(q)}`);
});
ipcMain.handle('social:friend-request', async (_event, userId) => {
  const result = await satelliteAuthedRequest('/v1/friends/request', { method: 'POST', body: { userId: String(userId || '') } });
  await refreshSatelliteFriends();
  return result;
});
ipcMain.handle('social:friend-accept', async (_event, userId) => {
  const result = await satelliteAuthedRequest('/v1/friends/accept', { method: 'POST', body: { userId: String(userId || '') } });
  await refreshSatelliteFriends();
  return result;
});
ipcMain.handle('social:friend-deny', async (_event, userId) => {
  const result = await satelliteAuthedRequest('/v1/friends/deny', { method: 'POST', body: { userId: String(userId || '') } });
  await refreshSatelliteFriends();
  return result;
});
ipcMain.handle('social:friend-remove', async (_event, userId) => {
  const result = await satelliteAuthedRequest('/v1/friends/remove', { method: 'POST', body: { userId: String(userId || '') } });
  await refreshSatelliteFriends();
  return result;
});
ipcMain.handle('social:get-messages', async (_event, userId, limit = 50, before = '') => {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const suffix = before ? `&before=${encodeURIComponent(String(before))}` : '';
  return satelliteAuthedRequest(`/v1/messages/${encodeURIComponent(String(userId || ''))}?limit=${safeLimit}${suffix}`);
});
ipcMain.handle('social:send-message', async (_event, userId, message) => {
  return satelliteAuthedRequest(`/v1/messages/${encodeURIComponent(String(userId || ''))}`, {
    method: 'POST',
    body: { message: String(message || '') }
  });
});
ipcMain.handle('social:mark-read', async (_event, userId) => {
  return satelliteAuthedRequest(`/v1/messages/${encodeURIComponent(String(userId || ''))}/read`, { method: 'POST' });
});
ipcMain.handle('social:typing', async (_event, userId, typing) => {
  if (!satelliteSocket || satelliteSocket.readyState !== WebSocket.OPEN) return { ok: false, connected: false };
  satelliteSocket.send(JSON.stringify({ type: 'typing', userId: String(userId || ''), typing: Boolean(typing) }));
  return { ok: true, connected: true };
});
ipcMain.handle('social:set-status', async (_event, statusMessage) => {
  const result = await satelliteAuthedRequest('/v1/profile/status', {
    method: 'POST',
    body: { statusMessage: String(statusMessage || '').slice(0, 120) }
  });
  emitSatelliteState({ me: result.user || satelliteState.me });
  return result;
});

ipcMain.handle('social:set-presence-mode', async (_event, requestedMode) => {
  const mode = normalizeSocialPresenceMode(requestedMode);
  const current = await loadSettings();
  current.socialPresenceMode = mode;
  await saveSettings(current);
  emitSatelliteState({ presenceMode: mode, error: null });

  if (mode === 'invisible') {
    satelliteManualDisconnect = true;
    clearSatelliteReconnect();
    closeSatelliteSocket();
    emitSatelliteState({ connection: 'invisible', presenceMode: mode, error: null });
    // Refreshing over REST is still allowed while invisible so the local UI
    // can show the latest friend/request state without revealing presence.
    await refreshSatelliteFriends().catch(() => {});
    emitSatelliteState({ connection: 'invisible', presenceMode: mode, error: null });
    return satelliteSnapshot();
  }

  satelliteManualDisconnect = false;
  if (!satelliteSocket || satelliteSocket.readyState !== WebSocket.OPEN) {
    await connectSatelliteForSelectedAccount({ force: true });
  } else {
    await sendSatellitePresence();
  }
  emitSatelliteState({ presenceMode: mode, error: null });
  return satelliteSnapshot();
});

ipcMain.handle('account:add', async () => {
  const settings = await loadSettings();
  const accountId = crypto.randomUUID();
  send('auth-state', { state: 'starting' });
  try {
    const session = await getMinecraftSession(accountId, false);
    const profile = session.profile;
    const account = {
      id: accountId,
      uuid: profile.id,
      name: profile.name,
      skinUrl: profile.skins?.find((s) => s.state === 'ACTIVE')?.url || profile.skins?.[0]?.url || ''
    };
    settings.accounts = [...settings.accounts.filter((a) => a.uuid !== account.uuid), account];
    settings.selectedAccountId = account.id;
    await saveSettings(settings);
    setTimeout(() => connectSatelliteForSelectedAccount({ force: true }).catch((error) => log(`[Satellite] Account connect failed: ${error.message}`, 'debug')), 250).unref?.();
    send('auth-state', { state: 'complete', account });
    return account;
  } catch (error) {
    await fsp.rm(launcherDataPath('accounts', accountId), { recursive: true, force: true }).catch(() => {});
    send('auth-state', { state: 'error', message: error.message });
    throw error;
  }
});

ipcMain.handle('account:select', async (_event, accountId) => {
  const settings = await loadSettings();
  if (!settings.accounts.some((a) => a.id === accountId)) throw new Error('Account not found.');
  settings.selectedAccountId = accountId;
  await saveSettings(settings);
  setTimeout(() => connectSatelliteForSelectedAccount({ force: true }).catch((error) => log(`[Satellite] Account switch connect failed: ${error.message}`, 'debug')), 100).unref?.();
  return true;
});

ipcMain.handle('account:remove', async (_event, accountId) => {
  const settings = await loadSettings();
  settings.accounts = settings.accounts.filter((a) => a.id !== accountId);
  if (settings.selectedAccountId === accountId) settings.selectedAccountId = settings.accounts[0]?.id || null;
  await saveSettings(settings);
  await fsp.rm(launcherDataPath('accounts', accountId), { recursive: true, force: true }).catch(() => {});
  setTimeout(() => connectSatelliteForSelectedAccount({ force: true }).catch((error) => log(`[Satellite] Account removal reconnect failed: ${error.message}`, 'debug')), 100).unref?.();
  return { ...settings, gameDirectory: APPDATA_ROOT };
});

ipcMain.handle('game:stop', async () => {
  const child = activeGameProcess;
  if (!child || child.exitCode != null) {
    activeGameProcess = null;
    activeGameVersion = null;
    activeGameServerAddress = null;
    void sendSatellitePresence();
    send('game-state', { state: 'stopped', text: 'SpectorClient is not running.' });
    return { ok: false, alreadyStopped: true };
  }

  send('game-state', { state: 'stopping', text: 'Stopping SpectorClient…' });

  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve, reject) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
        // If the process exited while taskkill was starting, treat that as success.
        if (error && activeGameProcess === child && child.exitCode == null) reject(error);
        else resolve();
      });
    });
  } else {
    const stopped = child.kill('SIGTERM');
    if (!stopped && child.exitCode == null) throw new Error('Could not stop the Minecraft process.');

    // Escalate only if the Java process ignores SIGTERM.
    setTimeout(() => {
      if (activeGameProcess === child && child.exitCode == null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000).unref?.();
  }

  return { ok: true };
});

ipcMain.handle('game:launch', async (_event, launchInput = {}) => {
  if (activeGameProcess || gameLaunchInProgress) throw new Error('SpectorClient is already running or launching.');
  if (updateInstallPending && !updateInstallStarting) {
    installDownloadedUpdateWhenSafe('Play was pressed while an update was ready');
    throw new Error('A SpectorClient update is installing. The launcher will restart automatically.');
  }

  gameLaunchInProgress = true;

  try {
    const settings = await loadSettings();
    const merged = { ...settings, ...launchInput };
    const selectedGameVersion = normalizeGameVersion(merged.selectedGameVersion);
    merged.selectedGameVersion = selectedGameVersion;

    // v1.5.7+: always open the detached Logs window at the very start of launch
    // so Java/client/auth/game output is visible without a sidebar Logs button.
    createLogWindow(merged.theme || settings.theme || 'classic');
    const account = settings.accounts.find((a) => a.id === merged.selectedAccountId);
    if (!account) throw new Error('Sign in with a Microsoft account first.');

    const minRam = Math.max(2, Number(merged.minRamGb) || 4);
    const maxRam = Math.max(minRam, Number(merged.maxRamGb) || 6);

    const requiredJavaMajor = getClientProfile(selectedGameVersion).javaMajor;
    const javaOverrideKey = javaSettingsKey(requiredJavaMajor);
    let javaExecutable = String(merged[javaOverrideKey] || '').trim();
    if (javaExecutable) {
      const inspection = await inspectJava(javaExecutable, requiredJavaMajor);
      if (!inspection.ok) {
        throw new Error(`Custom Java ${requiredJavaMajor} is invalid: ${inspection.reason}`);
      }
      log(`[Java] Using custom Java ${requiredJavaMajor}: ${javaExecutable}`, 'launcher');
    } else {
      send('game-state', { state: 'installing', text: `Preparing Java ${requiredJavaMajor}…` });
      javaExecutable = await ensureManagedJava(requiredJavaMajor);
    }

    // Persist only after any manually-entered Java override has passed validation.
    await saveSettings(merged);

    // A few Minecraft/user files are intentionally shared between all client
    // versions. Reconcile them immediately before launch in case Minecraft
    // replaced a hard link during its previous shutdown.
    send('game-state', { state: 'installing', text: 'Syncing shared settings…' });
    await ensureSharedDataForVersion(selectedGameVersion);

    send('game-state', { state: 'installing', text: 'Checking client files…' });
    const fabric = await prepareClient(selectedGameVersion);

    send('game-state', { state: 'authenticating', text: 'Refreshing Microsoft/Minecraft session…' });
    const session = await getMinecraftSession(account.id, false);
    const authorization = toMclcAuthorization(session);

    const opts = {
      authorization,
      root: getInstanceRoot(selectedGameVersion),
      version: {
        number: selectedGameVersion,
        type: 'release',
        custom: fabric.versionId
      },
      memory: { min: `${minRam}G`, max: `${maxRam}G` },
      window: {
        width: String(Math.max(640, Number(merged.width) || 1280)),
        height: String(Math.max(480, Number(merged.height) || 720)),
        fullscreen: Boolean(merged.fullscreen)
      },
      customLaunchArgs: [],
      customArgs: []
    };

    opts.javaPath = javaExecutable;
    if (merged.serverAddress?.trim()) {
      opts.quickPlay = { type: 'multiplayer', identifier: merged.serverAddress.trim() };
    }

    bindLauncherEvents();
    send('game-state', { state: 'launching', text: `Launching SpectorClient ${selectedGameVersion}…`, gameVersion: selectedGameVersion });

    const child = await launcher.launch(opts);
    activeGameProcess = child;
    activeGameVersion = selectedGameVersion;
    activeGameServerAddress = normalizeSatelliteServerAddress(merged.serverAddress);
    gameLaunchInProgress = false;
    send('game-state', { state: 'running', text: `SpectorClient ${selectedGameVersion} is running.`, gameVersion: selectedGameVersion });
    void sendSatellitePresence();
    showNativeNotification(
      'Minecraft Started',
      `SpectorClient ${selectedGameVersion} has started successfully.`,
      { version: selectedGameVersion, kind: 'game-started' }
    );
    if (merged.closeLauncherOnStart && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

    child.once('exit', async (code) => {
      activeGameProcess = null;
      const exitedVersion = activeGameVersion || selectedGameVersion;
      activeGameVersion = null;
      activeGameServerAddress = null;
      void sendSatellitePresence();

      try {
        await ensureSharedDataForVersion(exitedVersion);
      } catch (error) {
        log(`[Shared data] Could not reconcile ${exitedVersion} after Minecraft exited: ${error.message}`, 'launcher');
      }

      send('game-state', { state: 'stopped', text: `SpectorClient ${exitedVersion} exited${code == null ? '' : ` with code ${code}`}.`, gameVersion: exitedVersion });

      // If an update arrived while the user was playing, install it immediately
      // now that Java/Minecraft has fully exited.
      if (updateInstallPending) {
        installDownloadedUpdateWhenSafe('Minecraft exited');
        return;
      }

      if (backgroundForUpdate && updateDownloadInProgress) {
        log('[Updater] Minecraft closed. Finishing the launcher update download before installing.', 'updater');
        return;
      }

      backgroundForUpdate = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    });
    return { ok: true };
  } catch (error) {
    gameLaunchInProgress = false;
    if (!activeGameProcess) send('game-state', { state: 'error', text: error.message });

    // If an update completed while launch preparation was in progress but the
    // launch failed, it is now safe to install instead of leaving it pending.
    if (updateInstallPending && !isMinecraftRunning()) {
      setTimeout(() => installDownloadedUpdateWhenSafe('game launch ended'), 300).unref?.();
    }
    throw error;
  }
});

ipcMain.handle('notifications:permission-help', async () => {
  return showNotificationPermissionHelp();
});

ipcMain.handle('notifications:status', async () => ({
  supported: Notification.isSupported(),
  platform: process.platform,
  appId: process.platform === 'win32' ? WINDOWS_APP_ID : null
}));

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { ok: false, development: true };
  if (updateInstallPending || updateInstallStarting) {
    return { ok: true, pendingInstall: true, updateInfo: downloadedUpdateInfo };
  }
  const result = await autoUpdater.checkForUpdates();
  return { ok: true, updateInfo: makeIpcSafe(result?.updateInfo || null) };
});

ipcMain.handle('external:open', async (_event, url) => {
  if (!/^https:\/\//i.test(url)) throw new Error('Only HTTPS links are allowed.');
  await shell.openExternal(url);
  return true;
});

app.on('second-instance', () => {
  if (!hasSingleInstanceLock) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.setName(PRODUCT_NAME);
  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_ID);
    if (typeof app.setToastActivatorCLSID === 'function') app.setToastActivatorCLSID(WINDOWS_TOAST_CLSID);
  }
  configureNotificationPermissions();
  await ensureDirs();
  createWindow();
  setupAutoUpdater();

  // Warm up Java 25 for the default 26.2 client. SpectorClient 26.3 also
  // uses Java 25; Java 21 is installed automatically for SpectorClient 1.21.11.
  setTimeout(() => {
    ensureManagedJava(25).catch((error) => log(`Automatic Java 25 installation failed: ${error.message}`, 'debug'));
  }, 450);

  // Fabric API is a required core mod. Keep the currently selected client version current at startup.
  setTimeout(async () => {
    const startupSettings = await loadSettings();
    const gameVersion = normalizeGameVersion(startupSettings.selectedGameVersion);
    ensureFabricApi(gameVersion, { silent: true }).catch((error) => log(`Fabric API ${gameVersion} startup update check failed: ${error.message}`, 'debug'));
  }, 1200);

  // Connect the social rail after the main launcher is visible. Authentication
  // reuses the selected Minecraft account and does not require another prompt
  // while prismarine-auth still has a valid cached Microsoft session.
  setTimeout(() => {
    connectSatelliteForSelectedAccount({ force: false }).catch((error) => log(`[Satellite] Startup connect failed: ${error.message}`, 'debug'));
  }, 1500).unref?.();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  satelliteManualDisconnect = true;
  clearSatelliteReconnect();
  closeSatelliteSocket();
  clearUpdaterPolling();
});

app.on('window-all-closed', () => {
  // During an update we intentionally destroy the windows before
  // autoUpdater.quitAndInstall(). Do not race that call with app.quit().
  if (updateInstallStarting) return;
  if (process.platform !== 'darwin') app.quit();
});
