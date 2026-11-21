'use strict';

// Forge 1.8.9 uses LaunchWrapper and Java 8. minecraft-launcher-core 3.18.2
// specifically requires the UNIVERSAL JAR (not the installer) for <=1.12.2.
// This is the latest official Forge release listed for Minecraft 1.8.9.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

const MINECRAFT_VERSION = '1.8.9';
const FORGE_VERSION = '11.15.1.2318';
const FORGE_COORDINATE = `1.8.9-${FORGE_VERSION}-1.8.9`;
const FORGE_UNIVERSAL_FILENAME = `forge-${FORGE_COORDINATE}-universal.jar`;
const FORGE_UNIVERSAL_URL = `https://maven.minecraftforge.net/net/minecraftforge/forge/${FORGE_COORDINATE}/${FORGE_UNIVERSAL_FILENAME}`;
const FORGE_UNIVERSAL_SHA1 = 'beda619c465af293e63952dd573c137c17c0a4cd';
const MAX_FORGE_BYTES = 32 * 1024 * 1024;

function zipEntries(buffer) {
  if (buffer.length < 100 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Forge archive is not a JAR file.');
  }
  let eocd = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--) {
    if (buffer.readUInt32LE(p) === 0x06054b50 && p + 22 + buffer.readUInt16LE(p + 20) === buffer.length) {
      eocd = p; break;
    }
  }
  if (eocd < 0) throw new Error('Forge archive has no valid ZIP central directory.');
  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  const size = buffer.readUInt32LE(eocd + 12);
  const end = offset + size;
  if (!count || end > eocd || offset >= eocd) throw new Error('Forge archive has invalid ZIP metadata.');
  const result = new Set();
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('Forge JAR has invalid ZIP entries.');
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw new Error('Forge JAR has truncated ZIP entries.');
    result.add(buffer.toString('utf8', p + 46, p + 46 + nameLen));
    p = next;
  }
  if (p !== end) throw new Error('Forge JAR has mismatched ZIP metadata.');
  return result;
}

async function verifyForgeUniversal(file, expectedSha1 = FORGE_UNIVERSAL_SHA1) {
  const stat = await fsp.stat(file);
  if (!stat.size || stat.size > MAX_FORGE_BYTES) throw new Error('Forge universal JAR has an invalid size.');
  const bytes = await fsp.readFile(file);
  const checksum = crypto.createHash('sha1').update(bytes).digest('hex');
  if (checksum.toLowerCase() !== String(expectedSha1).toLowerCase()) throw new Error('Forge universal JAR SHA-1 mismatch.');
  const entries = zipEntries(bytes);
  // MCLC reads version.json from this JAR to prepare the actual Forge JVM main class.
  if (!entries.has('version.json')) throw new Error('Forge universal JAR is missing version.json.');
  return { sha1: checksum, bytes: bytes.length };
}

function requireHttps(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Forge downloads must use HTTPS.');
  return parsed.toString();
}

async function transferForgeJar(url, target, { get = https.get, maxRedirects = 6, timeoutMs = 60000 } = {}) {
  let current = requireHttps(url);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const req = get(current, { headers: { 'User-Agent': 'SpectorClient Launcher', Accept: 'application/java-archive,application/octet-stream,*/*' } }, res => {
        settled = true;
        resolve(res);
      });
      req.on('error', err => { if (!settled) reject(err); });
      req.setTimeout?.(timeoutMs, () => req.destroy(new Error('Forge download timed out.')));
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.resume();
      if (redirects === maxRedirects) throw new Error('Too many Forge download redirects.');
      current = requireHttps(new URL(response.headers.location, current).toString());
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`Forge download returned HTTP ${response.statusCode}.`);
    }
    const total = Number(response.headers['content-length'] || 0);
    if (total > MAX_FORGE_BYTES) { response.resume(); throw new Error('Forge download exceeds safe limit.'); }
    let received = 0;
    response.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_FORGE_BYTES) response.destroy(new Error('Forge download exceeds safe limit.'));
    });
    await pipeline(response, fs.createWriteStream(target, { flags: 'wx' }));
    if (!received || (total && received !== total)) throw new Error('Incomplete Forge universal JAR download.');
    return;
  }
  throw new Error('Forge download redirected too many times.');
}

async function ensureForgeUniversal(instanceRoot, {
  url = FORGE_UNIVERSAL_URL,
  sha1 = FORGE_UNIVERSAL_SHA1,
  transfer = transferForgeJar,
  onStatus = () => {}
} = {}) {
  const dir = path.join(instanceRoot, 'forge');
  const destination = path.join(dir, FORGE_UNIVERSAL_FILENAME);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const result = await verifyForgeUniversal(destination, sha1);
    onStatus(`Forge ${FORGE_VERSION} is already installed and verified.`);
    return { forgePath: destination, forgeVersion: FORGE_VERSION, ...result, cached: true };
  } catch {
    // Never trust a partially downloaded or otherwise invalid JAR.
  }
  const staged = path.join(dir, `.forge-download-${crypto.randomUUID()}.part`);
  try {
    onStatus(`Downloading Forge ${FORGE_VERSION} for Minecraft ${MINECRAFT_VERSION}…`);
    await transfer(url, staged);
    const result = await verifyForgeUniversal(staged, sha1);
    // The previously verified file, if any, is preserved until validation succeeded.
    const old = `${destination}.pre-update-${crypto.randomUUID()}.bak`;
    const existed = await fsp.stat(destination).then(() => true, () => false);
    if (existed) await fsp.rename(destination, old);
    try { await fsp.rename(staged, destination); }
    catch (error) {
      if (existed) await fsp.rename(old, destination).catch(() => {});
      throw error;
    }
    if (existed) await fsp.rm(old, { force: true }).catch(() => {});
    onStatus(`Forge ${FORGE_VERSION} verified and ready.`);
    return { forgePath: destination, forgeVersion: FORGE_VERSION, ...result, cached: false };
  } finally {
    await fsp.rm(staged, { force: true }).catch(() => {});
  }
}

module.exports = {
  MINECRAFT_VERSION, FORGE_VERSION, FORGE_COORDINATE, FORGE_UNIVERSAL_URL,
  FORGE_UNIVERSAL_SHA1, FORGE_UNIVERSAL_FILENAME, zipEntries,
  verifyForgeUniversal, ensureForgeUniversal
};
