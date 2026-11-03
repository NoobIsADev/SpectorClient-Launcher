'use strict';

// SpectorClient's own Fabric mod requires a more resilient download path than
// general-purpose Modrinth/CurseForge content. Keep this module dependency-free
// so Electron builds on Windows, macOS and Linux package it automatically.
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const MAX_MOD_BYTES = 128 * 1024 * 1024;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'
]);

function isRetryableModError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.status) return TRANSIENT_HTTP_STATUSES.has(Number(error.status));
  if (TRANSIENT_NETWORK_CODES.has(String(error.code || ''))) return true;
  if (error.code === 'ERR_SSL_WRONG_VERSION_NUMBER' || error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return false;
  if (error.cause && error.cause !== error) return isRetryableModError(error.cause);
  return false;
}

function retryDelayMs(attempt) {
  // Bounded exponential backoff, with a little jitter to reduce bursts during
  // a short outage. The caller can replace the sleeper for isolated tests.
  return Math.min(4200, 650 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250);
}

function requireHttpsUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:') throw new Error('SpectorClient mod downloads must use HTTPS (including redirects).');
  return parsed.toString();
}

async function getResponse(url, { get, userAgent, headerTimeoutMs, idleTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = get(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/java-archive, application/zip, application/octet-stream, */*' },
      autoSelectFamily: true
    }, response => {
      if (settled) { response.resume(); return; }
      settled = true;
      clearTimeout(headerTimer);
      resolve(response);
    });
    const headerTimer = setTimeout(() => {
      const error = new Error('SpectorClient mod server did not respond in time.');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    }, headerTimeoutMs);
    headerTimer.unref?.();
    request.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      reject(error);
    });
    request.setTimeout?.(idleTimeoutMs, () => {
      const error = new Error('SpectorClient mod transfer stopped responding.');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
  });
}

async function streamOneDownload(sourceUrl, tempPath, {
  get = https.get,
  userAgent = 'SpectorClient Launcher',
  onProgress = () => {},
  headerTimeoutMs = 25000,
  idleTimeoutMs = 60000,
  maxRedirects = 7
} = {}) {
  let currentUrl = requireHttpsUrl(sourceUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await getResponse(currentUrl, { get, userAgent, headerTimeoutMs, idleTimeoutMs });
    const status = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.resume();
      if (redirect === maxRedirects) throw new Error('SpectorClient mod URL redirected too many times.');
      currentUrl = requireHttpsUrl(new URL(response.headers.location, currentUrl).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      const error = new Error(`SpectorClient mod server returned HTTP ${status}.`);
      error.status = status;
      throw error;
    }
    const total = Number(response.headers['content-length'] || 0);
    if (total > MAX_MOD_BYTES) {
      response.resume();
      throw new Error('Server returned a mod download larger than the safe 128 MB limit.');
    }
    let received = 0;
    let previousProgress = -1;
    response.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_MOD_BYTES) {
        response.destroy(new Error('SpectorClient mod download exceeded the 128 MB limit.'));
        return;
      }
      if (total > 0) {
        const progress = Math.min(100, Math.round(received / total * 100));
        if (progress !== previousProgress && (progress === 100 || progress - previousProgress >= 3)) {
          previousProgress = progress;
          try { onProgress(progress); } catch { /* UI updates must not cancel a download. */ }
        }
      }
    });
    await pipeline(response, fs.createWriteStream(tempPath, { flags: 'wx' }));
    if (total > 0 && total !== received) {
      const error = new Error(`Incomplete mod download: received ${received} of ${total} bytes.`);
      error.code = 'ERR_STREAM_PREMATURE_CLOSE';
      throw error;
    }
    return { received, finalUrl: currentUrl };
  }
  throw new Error('Too many SpectorClient mod redirects.');
}

async function verifyFabricJar(file) {
  const stat = await fsp.stat(file);
  if (stat.size > MAX_MOD_BYTES) {
    throw new Error('SpectorClient mod JAR is unexpectedly large.');
  }
  const data = await fsp.readFile(file);
  if (data.length < 100 || data.readUInt32LE(0) !== 0x04034b50) {
    throw Object.assign(new Error('Server did not return a valid Fabric mod JAR (possibly an HTML error page).'), { retryable: true });
  }
  // Read the ZIP end-of-central-directory record instead of trusting a .jar
  // extension or HTTP Content-Type (Fabric JARs normally use application/zip).
  let eocd = -1;
  const limit = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= limit; i -= 1) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw Object.assign(new Error('SpectorClient mod JAR is incomplete or corrupted.'), { retryable: true });
  }
  const count = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  const end = centralOffset + centralSize;
  if (centralOffset >= eocd || end > eocd || count < 1) {
    throw Object.assign(new Error('SpectorClient mod JAR has an invalid ZIP directory.'), { retryable: true });
  }
  let pos = centralOffset;
  let foundModJson = false;
  for (let entry = 0; entry < count; entry += 1) {
    if (pos + 46 > end || data.readUInt32LE(pos) !== 0x02014b50) {
      throw Object.assign(new Error('SpectorClient mod JAR contains invalid ZIP entries.'), { retryable: true });
    }
    const nameLen = data.readUInt16LE(pos + 28);
    const extraLen = data.readUInt16LE(pos + 30);
    const commentLen = data.readUInt16LE(pos + 32);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > end) {
      throw Object.assign(new Error('SpectorClient mod JAR contains truncated ZIP entries.'), { retryable: true });
    }
    const name = data.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (name === 'fabric.mod.json') foundModJson = true;
    pos = next;
  }
  if (pos !== end || !foundModJson) {
    throw Object.assign(new Error('Downloaded archive does not contain a Fabric mod (fabric.mod.json missing).'), { retryable: true });
  }
  return { bytes: data.length };
}

async function downloadSpectorJar(url, destination, {
  attempts = 3,
  get = https.get,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  userAgent = 'SpectorClient Launcher',
  onProgress = () => {},
  onRetry = () => {},
  headerTimeoutMs = 25000,
  idleTimeoutMs = 60000
} = {}) {
  requireHttpsUrl(url);
  const count = Math.max(1, Math.min(5, Math.floor(attempts) || 3));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const staged = path.join(path.dirname(destination), `.spector-download-${crypto.randomUUID()}.part`);
    let keepStaged = false;
    try {
      const result = await streamOneDownload(url, staged, {
        get, userAgent, headerTimeoutMs, idleTimeoutMs,
        onProgress: percent => onProgress({ attempt, attempts: count, percent })
      });
      const verification = await verifyFabricJar(staged);
      keepStaged = true;
      return { path: staged, attempt, ...result, ...verification };
    } catch (error) {
      lastError = error;
      if (attempt < count && isRetryableModError(error)) {
        const delayMs = retryDelayMs(attempt);
        try { onRetry({ attempt, attempts: count, delayMs, error }); } catch { /* logging/UI callback is best effort */ }
        await sleep(delayMs);
      } else {
        break;
      }
    } finally {
      if (!keepStaged) await fsp.rm(staged, { force: true }).catch(() => {});
    }
  }
  throw lastError || new Error('SpectorClient mod download failed.');
}

// Swap a verified new JAR into place without deleting the last working mod
// before the replacement is safely on disk. A failed move restores the backup.
async function installVerifiedSpectorJar(staged, destination, { legacyFiles = [] } = {}) {
  await verifyFabricJar(staged);
  const backup = `${destination}.pre-update-${crypto.randomUUID()}.bak`;
  const exists = await fsp.stat(destination).then(() => true).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) await fsp.rename(destination, backup);
  try {
    await fsp.rename(staged, destination);
  } catch (error) {
    if (exists) {
      try { await fsp.rename(backup, destination); }
      catch (restoreError) {
        error.message += `; unable to restore old mod automatically: ${restoreError.message}. Backup: ${backup}`;
      }
    }
    throw error;
  }
  // Only after successful replacement should legacy copies be removed.
  for (const filename of legacyFiles) {
    const full = path.join(path.dirname(destination), filename);
    if (full !== destination) await fsp.rm(full, { force: true }).catch(() => {});
  }
  if (exists) await fsp.rm(backup, { force: true }).catch(() => {});
  return destination;
}

module.exports = { downloadSpectorJar, verifyFabricJar, isRetryableModError, installVerifiedSpectorJar };
