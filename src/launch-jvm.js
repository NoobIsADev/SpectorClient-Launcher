'use strict';

// Minecraft-launcher-core 3.18.2 sends its assembled, mutable Java argument
// array through the `arguments` event immediately BEFORE spawning Java.
// customArgs are JVM options; customLaunchArgs are *game* options. Never put
// -XX flags in customLaunchArgs and never spawn a second, untracked process.

const MIN_STACK_SHADOW_PAGES_263 = 32;
const SUPPORTED_VERSIONS = new Set(['1.21.11', '26.2', '26.3']);
const STACK_SHADOW_OPTION = /^-XX:StackShadowPages(?:=(.*))?$/;
const JVM_BOUNDARIES = new Set(['-cp', '-classpath', '--class-path', '-jar', '-m', '--module']);
const JVM_FIELDS = ['customArgs', 'jvmArgs', 'jvmArguments', 'javaArgs', 'javaArguments', 'customJvmArgs', 'customJavaArgs'];
const GAME_FIELDS = ['customLaunchArgs', 'gameArgs', 'gameArguments'];

function minecraftVersion(value) {
  if (value && typeof value === 'object') {
    // A profile display name is not the underlying Minecraft version.
    // Prefer actual version.number / minecraftVersion / gameVersion metadata.
    for (const field of ['number', 'minecraftVersion', 'gameVersion', 'version', 'id', 'name', 'label']) {
      if (value[field] !== undefined && value[field] !== value) {
        const resolved = minecraftVersion(value[field]);
        if (SUPPORTED_VERSIONS.has(resolved)) return resolved;
      }
    }
    return '';
  }
  const candidate = String(value == null ? '' : value).trim();
  if (SUPPORTED_VERSIONS.has(candidate)) return candidate;
  // Compatibility with human-readable selections saved by older launchers.
  // Do not classify arbitrary names containing a version somewhere in them.
  const match = /^SpectorClient\s+(1\.21\.11|26\.2|26\.3)$/i.exec(candidate);
  return match ? match[1] : candidate;
}

function isMinecraft263(versionOrLaunchOptions) {
  if (versionOrLaunchOptions && typeof versionOrLaunchOptions === 'object') {
    const version = versionOrLaunchOptions.version;
    if (version && typeof version === 'object' && version.number != null) {
      return minecraftVersion(version.number) === '26.3';
    }
  }
  return minecraftVersion(versionOrLaunchOptions) === '26.3';
}

// Separate string JVM arguments while preserving quoted values, for example
// -Dsome.property="hello world". Arrays already contain individual argv entries,
// so preserve their entries exactly (including strings with spaces).
function splitCommandLine(source) {
  const result = [];
  let current = '';
  let quote = null;
  let tokenStarted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && source[i + 1] === quote) {
        current += source[++i];
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; tokenStarted = true; continue; }
    if (/\s/.test(ch)) {
      if (tokenStarted) { result.push(current); current = ''; tokenStarted = false; }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }
  if (quote) throw new Error('Custom JVM arguments contain an unmatched quotation mark.');
  if (tokenStarted) result.push(current);
  return result;
}

function asArgList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(v => {
    if (Array.isArray(v)) return asArgList(v);
    // Arrays are already argv vectors: do NOT break quoted -D values apart.
    return typeof v === 'string' && v.length ? [v] : [];
  });
  if (typeof value === 'string') return splitCommandLine(value);
  return [];
}

function findSavedProfile(config) {
  const profileId = config?.selectedLaunchProfileId ?? config?.selectedProfileId ?? config?.profileId;
  const selection = config?.selectedLaunchProfile ?? config?.activeLaunchProfile ?? config?.selectedProfile;
  if (selection && typeof selection === 'object') return selection;
  const key = profileId ?? (typeof selection === 'string' ? selection : null);
  if (key == null) return null;
  for (const field of ['launchProfiles', 'gameProfiles', 'savedProfiles', 'profiles']) {
    const entries = config[field];
    if (Array.isArray(entries)) {
      const found = entries.find(p => p && [p.id, p.name, p.label].some(v => String(v) === String(key)));
      if (found) return found;
    } else if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      if (entries[key] && typeof entries[key] === 'object') return entries[key];
    }
  }
  return null;
}

function collectFields(source, keys) {
  const args = [];
  if (!source || typeof source !== 'object') return args;
  for (const key of keys) args.push(...asArgList(source[key]));
  return args;
}

function getCustomLaunchArguments(config) {
  // Explicitly selected profile first, then globally saved custom arguments.
  // Preserve all user options; only StackShadowPages is normalized on 26.3.
  const profile = findSavedProfile(config);
  const savedJvm = [...collectFields(profile, JVM_FIELDS), ...collectFields(config, JVM_FIELDS)];
  const savedGame = [...collectFields(profile, GAME_FIELDS), ...collectFields(config, GAME_FIELDS)];
  // Legacy configurations occasionally mislabeled a JVM option as a game
  // argument. Move ONLY StackShadowPages into the JVM section, leaving every
  // genuine game argument in its original order after the Java main class.
  const misplaced = stripStackShadowPages(savedGame);
  if (misplaced.removed) savedJvm.push(`-XX:StackShadowPages=${misplaced.pages}`);
  return { jvm: savedJvm, game: misplaced.remaining };
}

function positivePageCount(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function stripStackShadowPages(argv) {
  const remaining = [];
  let pages = 0;
  let removed = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    const match = typeof value === 'string' ? STACK_SHADOW_OPTION.exec(value) : null;
    if (!match) { remaining.push(value); continue; }
    removed += 1;
    let raw = match[1];
    // Older launch settings sometimes stored this incorrectly as two tokens.
    if (raw === undefined && i + 1 < argv.length && typeof argv[i + 1] === 'string' && /^\d+$/.test(argv[i + 1])) {
      raw = argv[++i];
    }
    pages = Math.max(pages, positivePageCount(raw));
  }
  return { remaining, pages, removed };
}

function normalizeCustomJvmArgs(argv, gameVersion) {
  const result = argv.slice();
  if (!isMinecraft263(gameVersion)) return result;
  const { remaining, pages } = stripStackShadowPages(result);
  remaining.push(`-XX:StackShadowPages=${Math.max(MIN_STACK_SHADOW_PAGES_263, pages)}`);
  return remaining;
}

// Locate the structure built by minecraft-launcher-core 3.18.2:
//   <JVM options> -cp <classpath> <Fabric main class> <Minecraft game options>
// This is a positional check on the real Java argv, not on a profile display
// name. Abort before spawn if the classpath/main-class structure is broken.
function javaLaunchStructure(argv) {
  const boundary = argv.findIndex(value => typeof value === 'string' && JVM_BOUNDARIES.has(value));
  if (boundary === -1) {
    throw new Error('Cannot locate the Java classpath/main-class boundary; refusing to launch 26.3 without verified JVM arguments.');
  }
  const classpathForm = ['-cp', '-classpath', '--class-path'].includes(argv[boundary]);
  const mainClassIndex = boundary + (classpathForm ? 2 : 1);
  const mainClass = argv[mainClassIndex];
  if (classpathForm && (typeof argv[boundary + 1] !== 'string' || !argv[boundary + 1].length)) {
    throw new Error('Java classpath is missing; refusing to launch 26.3 with an unverified command.');
  }
  if (typeof mainClass !== 'string' || !mainClass.length || mainClass.startsWith('-')) {
    throw new Error('Java main class is missing; refusing to launch 26.3 with an unverified command.');
  }
  return { boundary, mainClassIndex, mainClass };
}

function enforceFinalJvmArguments(argv, launchOptions) {
  if (!Array.isArray(argv)) throw new TypeError('The assembled Java command must be an argv array.');
  if (!isMinecraft263(launchOptions)) return { applied: false };

  const originalStructure = javaLaunchStructure(argv);
  // JVM flags must precede -cp, and game flags follow the real main class.
  // Do not disturb either section except for StackShadowPages. In particular,
  // keep -Xmx/-Xms, native flags, classpath, Fabric entrypoint and all game
  // arguments in their original order.
  const originalJvm = stripStackShadowPages(argv.slice(0, originalStructure.boundary));
  const originalGame = stripStackShadowPages(argv.slice(originalStructure.mainClassIndex + 1));
  const effectivePages = Math.max(MIN_STACK_SHADOW_PAGES_263, originalJvm.pages, originalGame.pages);
  const fixed = `-XX:StackShadowPages=${effectivePages}`;

  // Even if a saved profile or mod supplied a JVM flag in *game* arguments,
  // move that flag before the Fabric main class and keep every other game arg.
  // Mutate the SAME array that MCLC passes to child_process.spawn. Never spawn
  // another process or change the Java executable.
  const rebuilt = [
    ...originalJvm.remaining,
    fixed,
    ...argv.slice(originalStructure.boundary, originalStructure.mainClassIndex + 1),
    ...originalGame.remaining
  ];
  const verifiedStructure = javaLaunchStructure(rebuilt);
  const flagIndex = rebuilt.indexOf(fixed);
  const foundFlags = rebuilt.filter(value => typeof value === 'string' && STACK_SHADOW_OPTION.test(value));
  if (foundFlags.length !== 1 || flagIndex >= verifiedStructure.boundary ||
      verifiedStructure.mainClass !== originalStructure.mainClass || effectivePages < MIN_STACK_SHADOW_PAGES_263) {
    throw new Error('Could not verify exactly one valid StackShadowPages JVM argument before the Java main class for 26.3.');
  }
  argv.splice(0, argv.length, ...rebuilt);

  return {
    applied: true,
    pages: effectivePages,
    removed: originalJvm.removed + originalGame.removed,
    relocatedFromGameArgs: originalGame.removed,
    flagIndex,
    mainClassIndex: verifiedStructure.mainClassIndex,
    mainClass: verifiedStructure.mainClass
  };
}

module.exports = {
  MIN_STACK_SHADOW_PAGES_263,
  minecraftVersion,
  isMinecraft263,
  splitCommandLine,
  asArgList,
  getCustomLaunchArguments,
  normalizeCustomJvmArgs,
  enforceFinalJvmArguments
};
