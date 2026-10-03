const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { Authflow } = require('prismarine-auth');
const { Client } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');

// Keep only one SpectorClient process alive. Multiple launcher processes can
// keep files in the install directory locked and make NSIS fail while replacing
// an older version. A second launch focuses the existing window instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const PRODUCT_NAME = 'SpectorClient';
const DEFAULT_GAME_VERSION = '26.2';
const CLIENT_PROFILES = Object.freeze({
  '26.2': { label: 'SpectorClient 26.2', modUrl: 'https://spectorclient.com/mod/download' },
  '1.21.11': { label: 'SpectorClient 1.21.11', modUrl: 'https://spectorclient.com/mod/download/1.21.11' }
});
const SPECTOR_MOD_FILENAME = 'spectorclient.jar';
const LEGACY_SPECTOR_MOD_FILENAMES = ['spectorclient-1.0.0.jar'];
const BRAND_IMAGE_URL = 'https://i.imgur.com/nP9aVFe.png';
const BRAND_IMAGE_PATH = path.join(__dirname, 'assets', 'spector-logo.png');
const FABRIC_API_PROJECT = 'fabric-api';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = `SpectorClient/${app.getVersion()} (Electron Minecraft launcher)`;
const MODRINTH_PAGE_SIZE = 24;
const JAVA_MAJOR = 25;
const UPDATE_REPO_OWNER = 'NoobIsADev';
const UPDATE_REPO_NAME = 'SpectorClient-Launcher';

// Keep this client completely separate from the normal .minecraft folder.
const APPDATA_ROOT = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'spectorclient')
  : path.join(app.getPath('appData'), 'spectorclient');
const LAUNCHER_DATA = path.join(APPDATA_ROOT, 'launcher-data');
app.setPath('userData', LAUNCHER_DATA);
const JAVA_RUNTIME_DIR = path.join(APPDATA_ROOT, 'runtime', 'java-25');
const JAVA_RUNTIME_DOWNLOAD_DIR = path.join(LAUNCHER_DATA, 'downloads');

let mainWindow;
let logWindow;
const logBuffer = [];
const MAX_LOG_LINES = 2500;
let activeGameProcess = null;
let activeGameVersion = null;
let launcherEventsBound = false;
let preferredUiScale = 1;
let effectiveUiScale = 1;
let scaleResizeTimer = null;
const fabricApiRefreshPromises = new Map();
let javaInstallPromise = null;
let updaterInitialized = false;
let updaterInterval = null;
let updaterCheckPromise = null;
let lastUpdaterProgressBucket = -1;
let downloadedUpdateInfo = null;
let updateInstallPending = false;
let updateInstallStarting = false;
let updateDownloadInProgress = false;
let backgroundForUpdate = false;
let gameLaunchInProgress = false;
let lastUpdaterErrorFingerprint = '';
let lastUpdaterErrorAt = 0;
let lastNativeUpdateNoticeVersion = '';
let lastNativeInstallNoticeVersion = '';

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
  // Keep 26.2 on the original root so existing users retain their mods/configs.
  return gameVersion === DEFAULT_GAME_VERSION
    ? APPDATA_ROOT
    : path.join(APPDATA_ROOT, 'instances', gameVersion);
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

function defaultSettings() {
  return {
    selectedAccountId: null,
    selectedGameVersion: DEFAULT_GAME_VERSION,
    minRamGb: 4,
    maxRamGb: 6,
    javaPath: '',
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
    accounts: []
  };
}

async function ensureDirs() {
  const versionRoots = Object.keys(CLIENT_PROFILES).map((gameVersion) => getInstanceRoot(gameVersion));
  const versionDirs = versionRoots.flatMap((root) => [
    fsp.mkdir(root, { recursive: true }),
    fsp.mkdir(path.join(root, 'mods'), { recursive: true }),
    fsp.mkdir(path.join(root, 'versions'), { recursive: true })
  ]);
  await Promise.all([
    fsp.mkdir(APPDATA_ROOT, { recursive: true }),
    fsp.mkdir(LAUNCHER_DATA, { recursive: true }),
    fsp.mkdir(launcherDataPath('accounts'), { recursive: true }),
    fsp.mkdir(path.join(APPDATA_ROOT, 'instances'), { recursive: true }),
    fsp.mkdir(path.join(APPDATA_ROOT, 'runtime'), { recursive: true }),
    fsp.mkdir(JAVA_RUNTIME_DOWNLOAD_DIR, { recursive: true }),
    ...versionDirs
  ]);
}

function temurinArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'aarch64';
  throw new Error(`Automatic Java 25 installation does not support Windows ${process.arch}.`);
}

function managedJavaPath() {
  if (process.platform === 'win32') return path.join(JAVA_RUNTIME_DIR, 'bin', 'javaw.exe');
  return path.join(JAVA_RUNTIME_DIR, 'bin', 'java');
}

function managedJavaConsolePath() {
  if (process.platform === 'win32') return path.join(JAVA_RUNTIME_DIR, 'bin', 'java.exe');
  return managedJavaPath();
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

async function isJava25(javaExecutable) {
  if (!(await pathExists(javaExecutable))) return false;
  try {
    const { stdout, stderr } = await execFilePromise(javaExecutable, ['-version'], { timeout: 15000 });
    const output = `${stdout || ''}\n${stderr || ''}`;
    return /(?:openjdk|java) version ["']25(?:[.\-+_][^"']*)?["']/i.test(output) || /version ["']25(?:\.|["'])/i.test(output);
  } catch {
    return false;
  }
}

function downloadJavaArchive(url, destination, { redirects = 8, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = (currentUrl, remaining) => {
      const req = https.get(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/octet-stream,*/*;q=0.8'
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

        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        const output = fs.createWriteStream(destination);
        output.on('error', reject);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.on('error', reject);
        output.on('finish', () => output.close(() => resolve(destination)));
        res.pipe(output);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('Java download timed out.')));
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

async function installManagedJava25() {
  if (process.platform !== 'win32') {
    throw new Error('Automatic Java 25 installation is currently supported on Windows only. Select Java 25 manually in Settings on this platform.');
  }

  await ensureDirs();
  const arch = temurinArch();
  const downloadPath = path.join(JAVA_RUNTIME_DOWNLOAD_DIR, `temurin-${JAVA_MAJOR}-${arch}-${process.pid}.zip`);
  const stagingDir = path.join(APPDATA_ROOT, 'runtime', `.java-25-install-${process.pid}-${Date.now()}`);
  const jreUrl = `https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/windows/${arch}/jre/hotspot/normal/eclipse`;
  const jdkUrl = `https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/windows/${arch}/jdk/hotspot/normal/eclipse`;

  log(`Installing managed Java ${JAVA_MAJOR} (${arch}) from Eclipse Temurin…`);
  send('install-state', { step: 'Java 25', message: 'Downloading Java 25…' });

  await fsp.rm(downloadPath, { force: true }).catch(() => {});
  await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(stagingDir, { recursive: true });

  let lastPercent = -1;
  const onProgress = (received, total) => {
    if (!total) return;
    const percent = Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
    if (percent === lastPercent || percent % 5 !== 0) return;
    lastPercent = percent;
    send('install-state', { step: 'Java 25', message: `Downloading Java 25… ${percent}%`, percent });
  };

  try {
    try {
      await downloadJavaArchive(jreUrl, downloadPath, { onProgress });
    } catch (error) {
      log(`Temurin JRE download failed (${error.message}); trying the Java 25 JDK package.`, 'debug');
      await fsp.rm(downloadPath, { force: true }).catch(() => {});
      await downloadJavaArchive(jdkUrl, downloadPath, { onProgress });
    }

    const fd = await fsp.open(downloadPath, 'r');
    const header = Buffer.alloc(4);
    await fd.read(header, 0, 4, 0);
    await fd.close();
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error('Downloaded Java package is not a valid ZIP archive.');
    }

    send('install-state', { step: 'Java 25', message: 'Installing Java 25…' });
    await execFilePromise('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(downloadPath)} -DestinationPath ${JSON.stringify(stagingDir)} -Force`
    ], { timeout: 180000, maxBuffer: 1024 * 1024 * 4 });

    const extractedHome = await findJavaHome(stagingDir);
    if (!extractedHome) throw new Error('Java 25 extracted, but bin\\java.exe could not be found.');

    const extractedJava = path.join(extractedHome, 'bin', 'java.exe');
    if (!(await isJava25(extractedJava))) throw new Error('The downloaded runtime did not report Java 25.');

    await fsp.rm(JAVA_RUNTIME_DIR, { recursive: true, force: true }).catch(() => {});
    if (path.resolve(extractedHome) === path.resolve(stagingDir)) {
      await fsp.rename(stagingDir, JAVA_RUNTIME_DIR);
    } else {
      await fsp.rename(extractedHome, JAVA_RUNTIME_DIR);
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }

    const launchJava = managedJavaPath();
    const fallbackJava = managedJavaConsolePath();
    const resolved = await pathExists(launchJava) ? launchJava : fallbackJava;
    if (!(await pathExists(resolved))) throw new Error('Managed Java 25 installation completed without a Java executable.');

    log(`Managed Java 25 is ready: ${resolved}`);
    send('install-state', { step: 'Java 25', message: 'Java 25 ready.', percent: 100 });
    return resolved;
  } finally {
    await fsp.rm(downloadPath, { force: true }).catch(() => {});
    if (await pathExists(stagingDir)) await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureManagedJava25({ force = false } = {}) {
  if (!force && await isJava25(managedJavaConsolePath())) {
    const launchJava = managedJavaPath();
    return await pathExists(launchJava) ? launchJava : managedJavaConsolePath();
  }

  if (!javaInstallPromise) {
    javaInstallPromise = installManagedJava25().finally(() => {
      javaInstallPromise = null;
    });
  }
  return javaInstallPromise;
}

async function loadSettings() {
  await ensureDirs();
  try {
    const parsed = JSON.parse(await fsp.readFile(launcherDataPath('settings.json'), 'utf8'));
    return {
      ...defaultSettings(),
      ...parsed,
      selectedGameVersion: normalizeGameVersion(parsed.selectedGameVersion),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(settings) {
  const safe = { ...defaultSettings(), ...settings };
  safe.selectedGameVersion = normalizeGameVersion(safe.selectedGameVersion);
  delete safe.gameDirectory;
  delete safe.clientId;
  delete safe.selectedVersion;
  delete safe.versionType;
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


function showNativeWindowsNotification(title, body, { version = '', kind = 'update' } = {}) {
  if (process.platform !== 'win32' || !Notification.isSupported()) {
    log(`[Updater] Windows notification unavailable: ${title} — ${body}`, 'updater');
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
    log(`[Updater] Could not show Windows notification: ${error?.message || error}`, 'updater');
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

function installDownloadedUpdateWhenSafe(reason = 'update downloaded') {
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

  updateInstallStarting = true;
  clearUpdaterPolling();
  log(`[Updater] Installing SpectorClient ${version} now (${reason})…`, 'updater');
  showNativeWindowsNotification(
    'SpectorClient Update Installing',
    `Installing SpectorClient ${version} now. The launcher will restart automatically when it is finished.`,
    { version, kind: 'installing' }
  );
  emitUpdateState('installing-update', {
    version,
    text: `Installing SpectorClient ${version} now…`
  });

  // Give the renderer/log window a brief moment to paint the final status.
  // Then close every BrowserWindow ourselves before handing control to NSIS.
  // This avoids renderer/GPU handles keeping files locked during replacement.
  setTimeout(() => {
    try {
      if (logWindow && !logWindow.isDestroyed()) logWindow.destroy();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      app.releaseSingleInstanceLock();

      // isSilent=true: no installer wizard. forceRunAfter=true: restart the
      // updated launcher once NSIS has replaced the installed application.
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
  const missingLatestMetadata = /latest\.yml/i.test(raw) && (/(?:404|not found)/i.test(raw) || /cannot find latest\.yml/i.test(raw));
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
    if (!app.isPackaged) log(`[Updater] Development build ${app.getVersion()} detected; automatic app replacement is disabled. Install the NSIS EXE to test auto-updates.`, 'updater');
    return;
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
  // Reliability over bandwidth: always download the complete NSIS installer.
  // This removes differential/blockmap patching as a possible failure point.
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
    showNativeWindowsNotification(
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

function request(url, { binary = false, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: binary ? '*/*' : 'application/json'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        request(next, { binary, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => reject(new Error(`HTTP ${status} from ${new URL(url).hostname}: ${body.slice(0, 180)}`)));
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

async function downloadFile(url, destination, label, { silent = false } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.download`;
  await fsp.rm(temp, { force: true }).catch(() => {});

  return new Promise((resolve, reject) => {
    const doDownload = (currentUrl, redirects = 8) => {
      const req = https.get(currentUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
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

async function ensureSpectorMod(gameVersion) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const profile = getClientProfile(selectedVersion);
  const modsDir = getModsDir(selectedVersion);
  const destination = path.join(modsDir, SPECTOR_MOD_FILENAME);
  send('install-state', { step: 'SpectorClient', text: `Refreshing SpectorClient ${selectedVersion} mod…`, gameVersion: selectedVersion });

  const spectorFiles = [SPECTOR_MOD_FILENAME, ...LEGACY_SPECTOR_MOD_FILENAMES];
  for (const filename of spectorFiles) {
    await fsp.rm(path.join(modsDir, filename), { force: true }).catch(() => {});
  }

  await downloadFile(profile.modUrl, destination, `SpectorClient ${selectedVersion} mod`);
  log(`SpectorClient ${selectedVersion} mod refreshed from ${profile.modUrl}`);
  return destination;
}

async function prepareClient(gameVersion = DEFAULT_GAME_VERSION) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  await ensureDirs();
  send('install-state', { step: 'Preparing', text: `Preparing SpectorClient for Minecraft ${selectedVersion}…`, percent: 0, gameVersion: selectedVersion });
  const fabric = await ensureFabricProfile(selectedVersion);
  const api = await ensureFabricApi(selectedVersion);
  await ensureSpectorMod(selectedVersion);
  send('install-state', { step: 'Ready', text: `SpectorClient ${selectedVersion} ready.`, percent: 100, gameVersion: selectedVersion });
  return { ...fabric, fabricApiVersion: api.version, root: getInstanceRoot(selectedVersion) };
}

// ---------------------------
// Modrinth mod manager
// ---------------------------

async function loadModRegistry(gameVersion = DEFAULT_GAME_VERSION) {
  await ensureDirs();
  try {
    const data = JSON.parse(await fsp.readFile(getModRegistryPath(gameVersion), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveModRegistry(gameVersion, registry) {
  await fsp.writeFile(getModRegistryPath(gameVersion), JSON.stringify(registry, null, 2));
}

function isCoreModFilename(filename) {
  const lower = String(filename).toLowerCase();
  return lower.startsWith('fabric-api-') || lower === SPECTOR_MOD_FILENAME.toLowerCase() || LEGACY_SPECTOR_MOD_FILENAMES.map((name) => name.toLowerCase()).includes(lower);
}

async function listInstalledMods(gameVersion = DEFAULT_GAME_VERSION) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  await ensureDirs();
  const registry = await loadModRegistry(selectedVersion);
  const modsDir = getModsDir(selectedVersion);
  const entries = await fsp.readdir(modsDir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
    const stat = await fsp.stat(path.join(modsDir, entry.name)).catch(() => null);
    if (!stat) continue;
    const registered = Object.values(registry).find((item) => item?.filename === entry.name) || null;
    files.push({
      filename: entry.name,
      size: stat.size,
      core: isCoreModFilename(entry.name),
      projectId: registered?.projectId || '',
      projectSlug: registered?.projectSlug || '',
      title: registered?.title || entry.name.replace(/\.jar$/i, ''),
      versionNumber: registered?.versionNumber || '',
      versionId: registered?.versionId || '',
      iconUrl: registered?.iconUrl || '',
      dependency: Boolean(registered?.dependency),
      gameVersion: selectedVersion
    });
  }

  files.sort((a, b) => Number(b.core) - Number(a.core) || a.title.localeCompare(b.title));
  return files;
}

async function searchModrinthMods(gameVersion, query, page = 1) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const q = String(query || '').trim().slice(0, 100);
  const safePage = Math.max(1, Math.min(10000, Number.parseInt(page, 10) || 1));
  const offset = (safePage - 1) * MODRINTH_PAGE_SIZE;
  const facets = [
    ['project_type:mod'],
    ['categories:fabric'],
    [`versions:${selectedVersion}`],
    [
      'environment:client_and_server',
      'environment:client_only',
      'environment:client_only_server_optional',
      'environment:client_or_server',
      'environment:client_or_server_prefers_both',
      'environment:unknown'
    ]
  ];
  const params = new URLSearchParams({
    query: q,
    facets: JSON.stringify(facets),
    limit: String(MODRINTH_PAGE_SIZE),
    offset: String(offset),
    index: q ? 'relevance' : 'downloads'
  });
  const data = await request(`${MODRINTH_API}/search?${params.toString()}`);
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  const total = Math.max(0, Number(data?.total_hits ?? (offset + hits.length)) || 0);
  const totalPages = Math.max(1, Math.ceil(total / MODRINTH_PAGE_SIZE));
  return {
    gameVersion: selectedVersion,
    items: hits.map((hit) => ({
      projectId: hit.project_id,
      slug: hit.slug || '',
      title: hit.title || hit.slug || 'Untitled mod',
      description: hit.description || '',
      author: hit.author || '',
      iconUrl: hit.icon_url || '',
      downloads: Number(hit.downloads || 0),
      categories: Array.isArray(hit.display_categories) ? hit.display_categories.slice(0, 5) : []
    })),
    total,
    page: Math.min(safePage, totalPages),
    pageSize: MODRINTH_PAGE_SIZE,
    totalPages
  };
}

async function getCompatibleProjectVersion(gameVersion, projectId, preferRelease = true) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const params = new URLSearchParams({
    loaders: JSON.stringify(['fabric']),
    game_versions: JSON.stringify([selectedVersion]),
    include_changelog: 'false'
  });
  const versions = await request(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
  if (!Array.isArray(versions) || !versions.length) {
    throw new Error(`No Fabric ${selectedVersion} version is available for this mod.`);
  }
  const sorted = [...versions].sort((a, b) => new Date(b.date_published || 0) - new Date(a.date_published || 0));
  return preferRelease ? (sorted.find((v) => v.version_type === 'release') || sorted[0]) : sorted[0];
}

async function getModrinthProjectStatuses(gameVersion, projectIds) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^[A-Za-z0-9_-]{2,80}$/.test(id)))].slice(0, 60);
  const registry = await loadModRegistry(selectedVersion);
  const statuses = {};
  const concurrency = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const installed = registry[id] || null;
      try {
        const latest = await getCompatibleProjectVersion(selectedVersion, id, id !== FABRIC_API_PROJECT);
        statuses[id] = {
          projectId: id,
          installed: Boolean(installed),
          installedVersionId: installed?.versionId || '',
          installedVersionNumber: installed?.versionNumber || '',
          latestVersionId: latest?.id || '',
          latestVersionNumber: latest?.version_number || '',
          updateAvailable: Boolean(installed?.versionId && latest?.id && installed.versionId !== latest.id)
        };
      } catch (error) {
        statuses[id] = {
          projectId: id,
          installed: Boolean(installed),
          installedVersionId: installed?.versionId || '',
          installedVersionNumber: installed?.versionNumber || '',
          latestVersionId: '',
          latestVersionNumber: '',
          updateAvailable: false,
          error: error.message
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, () => worker()));
  return statuses;
}

function pickVersionJar(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  return files.find((f) => f.primary && String(f.filename).toLowerCase().endsWith('.jar') && !f.file_type)
    || files.find((f) => String(f.filename).toLowerCase().endsWith('.jar') && !f.file_type)
    || files.find((f) => String(f.filename).toLowerCase().endsWith('.jar'));
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
    if (dep.project_id) return getCompatibleProjectVersion(selectedVersion, dep.project_id);
    throw new Error(`Pinned dependency version is not compatible with Fabric ${selectedVersion}.`);
  }
  if (dep?.project_id) return getCompatibleProjectVersion(selectedVersion, dep.project_id);
  if (dep?.file_name) {
    throw new Error(`Required dependency ${dep.file_name} has no Modrinth project/version ID and cannot be downloaded automatically.`);
  }
  throw new Error('A required dependency is missing its Modrinth project/version ID.');
}

async function installModrinthVersion(gameVersion, version, { dependency = false, visited = new Set() } = {}) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  if (!version?.id) throw new Error('Invalid Modrinth version metadata.');
  if (visited.has(version.id)) return null;
  visited.add(version.id);

  const loaders = Array.isArray(version.loaders) ? version.loaders : [];
  const gameVersions = Array.isArray(version.game_versions) ? version.game_versions : [];
  if (loaders.length && !loaders.includes('fabric')) throw new Error('A required dependency is not available for Fabric.');
  if (gameVersions.length && !gameVersions.includes(selectedVersion)) throw new Error(`A required dependency is not compatible with Minecraft ${selectedVersion}.`);

  const requiredDependencies = (version.dependencies || []).filter((d) => d.dependency_type === 'required');
  for (const dep of requiredDependencies) {
    try {
      const depVersion = await resolveRequiredDependencyVersion(selectedVersion, dep);
      send('mod-install-state', {
        state: 'dependency',
        projectId: version.project_id,
        dependencyProjectId: depVersion?.project_id || dep.project_id || '',
        gameVersion: selectedVersion,
        text: `Installing required dependency for ${selectedVersion}…`
      });
      await installModrinthVersion(selectedVersion, depVersion, { dependency: true, visited });
    } catch (error) {
      throw new Error(`Could not install a required dependency: ${error.message}`);
    }
  }

  const project = await request(`${MODRINTH_API}/project/${encodeURIComponent(version.project_id)}`);
  if (project?.slug === FABRIC_API_PROJECT) {
    await ensureFabricApi(selectedVersion);
    return { title: project.title || 'Fabric API', core: true };
  }

  const file = pickVersionJar(version);
  if (!file?.url || !file?.filename) throw new Error('This Modrinth version does not contain an installable JAR.');
  const filename = path.basename(file.filename);
  const modsDir = getModsDir(selectedVersion);
  const destination = path.join(modsDir, filename);
  const registry = await loadModRegistry(selectedVersion);
  const registryKey = String(version.project_id);
  const previous = registry[registryKey];

  if (previous?.filename && previous.filename !== filename && !isCoreModFilename(previous.filename)) {
    await fsp.rm(path.join(modsDir, path.basename(previous.filename)), { force: true }).catch(() => {});
  }

  let alreadyInstalled = false;
  try {
    const stat = await fsp.stat(destination);
    alreadyInstalled = previous?.versionId === version.id
      && stat.size > 0
      && (!file.size || stat.size === Number(file.size));
  } catch {}

  if (!alreadyInstalled) {
    send('mod-install-state', { state: 'downloading', projectId: version.project_id, gameVersion: selectedVersion, text: `Installing ${project?.title || filename} for ${selectedVersion}…` });
    await downloadFile(file.url, destination, project?.title || filename);
  }

  registry[registryKey] = {
    projectId: version.project_id,
    projectSlug: project?.slug || '',
    title: project?.title || filename.replace(/\.jar$/i, ''),
    iconUrl: project?.icon_url || '',
    filename,
    versionId: version.id,
    versionNumber: version.version_number || '',
    dependency: Boolean(dependency),
    installedAt: new Date().toISOString()
  };
  await saveModRegistry(selectedVersion, registry);
  log(`${alreadyInstalled ? 'Verified' : 'Installed'} ${selectedVersion} Modrinth mod: ${registry[registryKey].title} ${registry[registryKey].versionNumber}`);
  return registry[registryKey];
}

async function installModrinthProject(gameVersion, projectId) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const id = String(projectId || '').trim();
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(id)) throw new Error('Invalid Modrinth project ID.');
  await ensureFabricApi(selectedVersion, { silent: true });
  const registryBefore = await loadModRegistry(selectedVersion);
  const previous = registryBefore[id] || null;
  send('mod-install-state', { state: 'resolving', projectId: id, gameVersion: selectedVersion, text: `Finding a Fabric ${selectedVersion} build and required dependencies…` });
  const version = await getCompatibleProjectVersion(selectedVersion, id);
  const installed = await installModrinthVersion(selectedVersion, version, { dependency: false, visited: new Set() });
  const action = previous ? (previous.versionId === version.id ? 'verified' : 'updated') : 'installed';
  const verb = action === 'updated' ? 'updated' : action === 'verified' ? 'verified' : 'installed';
  send('mod-install-state', { state: 'complete', projectId: id, gameVersion: selectedVersion, text: `${installed?.title || 'Mod'} ${verb} for ${selectedVersion}; required dependencies checked.` });
  return { installed, action, gameVersion: selectedVersion, mods: await listInstalledMods(selectedVersion) };
}

async function removeInstalledMod(gameVersion, filename) {
  const selectedVersion = normalizeGameVersion(gameVersion);
  const safeName = path.basename(String(filename || ''));
  if (!safeName.toLowerCase().endsWith('.jar') || safeName !== String(filename || '')) throw new Error('Invalid mod filename.');
  if (isCoreModFilename(safeName)) throw new Error('Fabric API and SpectorClient are required core mods and cannot be removed here.');

  await fsp.rm(path.join(getModsDir(selectedVersion), safeName), { force: true });
  const registry = await loadModRegistry(selectedVersion);
  for (const [key, item] of Object.entries(registry)) {
    if (item?.filename === safeName) delete registry[key];
  }
  await saveModRegistry(selectedVersion, registry);
  log(`Removed ${selectedVersion} mod: ${safeName}`);
  return listInstalledMods(selectedVersion);
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
  launcher.on('data', (line) => log(line, 'game'));
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
  gameDirectory: APPDATA_ROOT,
  defaultGameVersion: DEFAULT_GAME_VERSION,
  supportedVersions: Object.keys(CLIENT_PROFILES).map((gameVersion) => ({
    gameVersion,
    label: CLIENT_PROFILES[gameVersion].label,
    modsDirectory: getModsDir(gameVersion),
    modUrl: CLIENT_PROFILES[gameVersion].modUrl
  })),
  managedJavaPath: managedJavaPath(),
  javaMajor: JAVA_MAJOR
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

ipcMain.handle('dialog:choose-java', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Java 25 executable',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : []
  });
  return result.canceled ? null : result.filePaths[0];
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

ipcMain.handle('mods:list', async (_event, gameVersion) => {
  const selectedVersion = normalizeGameVersion(gameVersion);
  await ensureFabricApi(selectedVersion, { silent: true }).catch((error) => log(`Fabric API ${selectedVersion} mod-list update check failed: ${error.message}`, 'debug'));
  return listInstalledMods(selectedVersion);
});
ipcMain.handle('mods:search', async (_event, gameVersion, query, page) => searchModrinthMods(gameVersion, query, page));
ipcMain.handle('mods:statuses', async (_event, gameVersion, projectIds) => getModrinthProjectStatuses(gameVersion, projectIds));
ipcMain.handle('mods:install', async (_event, gameVersion, projectId) => installModrinthProject(gameVersion, projectId));
ipcMain.handle('mods:remove', async (_event, gameVersion, filename) => removeInstalledMod(gameVersion, filename));

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
  return true;
});

ipcMain.handle('account:remove', async (_event, accountId) => {
  const settings = await loadSettings();
  settings.accounts = settings.accounts.filter((a) => a.id !== accountId);
  if (settings.selectedAccountId === accountId) settings.selectedAccountId = settings.accounts[0]?.id || null;
  await saveSettings(settings);
  await fsp.rm(launcherDataPath('accounts', accountId), { recursive: true, force: true }).catch(() => {});
  return { ...settings, gameDirectory: APPDATA_ROOT };
});

ipcMain.handle('game:stop', async () => {
  const child = activeGameProcess;
  if (!child || child.exitCode != null) {
    activeGameProcess = null;
    activeGameVersion = null;
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
    await saveSettings(merged);

    let javaExecutable = merged.javaPath?.trim() || '';
    if (!javaExecutable) {
      send('game-state', { state: 'installing', text: 'Preparing Java 25…' });
      javaExecutable = await ensureManagedJava25();
    }

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
    gameLaunchInProgress = false;
    send('game-state', { state: 'running', text: `SpectorClient ${selectedGameVersion} is running.`, gameVersion: selectedGameVersion });
    if (merged.closeLauncherOnStart && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

    child.once('exit', (code) => {
      activeGameProcess = null;
      const exitedVersion = activeGameVersion || selectedGameVersion;
      activeGameVersion = null;
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
  if (process.platform === 'win32') app.setAppUserModelId('client.spector.launcher');
  await ensureDirs();
  createWindow();
  setupAutoUpdater();

  // Install SpectorClient's private Java 25 runtime automatically on first launch.
  // It lives under %APPDATA%\spectorclient and does not require a system-wide Java install.
  setTimeout(() => {
    ensureManagedJava25().catch((error) => log(`Automatic Java 25 installation failed: ${error.message}`, 'debug'));
  }, 450);

  // Fabric API is a required core mod. Keep the currently selected client version current at startup.
  setTimeout(async () => {
    const startupSettings = await loadSettings();
    const gameVersion = normalizeGameVersion(startupSettings.selectedGameVersion);
    ensureFabricApi(gameVersion, { silent: true }).catch((error) => log(`Fabric API ${gameVersion} startup update check failed: ${error.message}`, 'debug'));
  }, 1200);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  clearUpdaterPolling();
});

app.on('window-all-closed', () => {
  // During an update we intentionally destroy the windows before
  // autoUpdater.quitAndInstall(). Do not race that call with app.quit().
  if (updateInstallStarting) return;
  if (process.platform !== 'darwin') app.quit();
});
