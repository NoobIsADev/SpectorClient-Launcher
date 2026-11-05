// SpectorClient v1.6.52: real local-network regression tests for the resilient
// official mod download (does not use the public website or Electron).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  downloadSpectorJar,
  verifyFabricJar,
  installVerifiedSpectorJar,
  isRetryableModError
} = require('../src/spector-mod-network');

function makeFabricJar(name) {
  const entries = [
    ['fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'spectorclient', version: name }))],
    ['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\n')],
    ['com/spectorclient/Stub.class', Buffer.from('CAFE BABE mock data')]
  ];
  const locals = [];
  const centrals = [];
  let pos = 0;
  for (const [fileName, content] of entries) {
    const file = Buffer.from(fileName);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(file.length, 26);
    locals.push(local, file, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(pos, 42);
    centrals.push(central, file);
    pos += local.length + file.length + content.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(pos, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function run() {
  const pkg = require('../package.json');
  assert(Number(pkg.version.split('.').at(-1)) >= 52, 'v1.6.52 network fix must remain in later releases');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert(main.includes("require('./spector-mod-network')"), 'Launcher must use resilient downloader');
  assert(main.includes('askAfterSpectorModDownloadFailure'), 'Installed-mod fallback prompt must remain');
  assert(main.includes('moveInstalledSpectorModsToBackup'), 'Explicit without-mod choice must preserve a backup');
  assert(main.includes('LEGACY_SPECTOR_MOD_FILENAMES'), 'Legacy Spector mods remain managed');
  for (const endpoint of ['/mod/download', '/mod/download/26.3', '/mod/download/1.21.11']) {
    assert(main.includes(endpoint), `Required mod URL missing: ${endpoint}`);
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'spector-mod-v1652-'));
  const existing = makeFabricJar('old');
  const latest = makeFabricJar('new');
  const attempted = new Map();
  const server = http.createServer((req, res) => {
    const route = req.url;
    attempted.set(route, (attempted.get(route) || 0) + 1);
    if (route === '/mod/download') {
      if (attempted.get(route) === 1) { res.writeHead(503); res.end('Temporary outage'); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': latest.length });
      res.end(latest);
      return;
    }
    if (route === '/mod/download/26.3') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); return; }
    if (route === '/mod/download/1.21.11') { res.writeHead(404); res.end('Not found'); return; }
    if (route === '/broken') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': latest.length });
      res.write(latest.subarray(0, 40));
      res.destroy();
      return;
    }
    if (route === '/redirect') { res.writeHead(302, { Location: 'https://spectorclient.test/mod/download' }); res.end(); return; }
    if (route === '/insecure') { res.writeHead(302, { Location: 'http://spectorclient.test/mod/download' }); res.end(); return; }
    res.writeHead(500); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // Client URLs remain HTTPS; only the injected transport maps them to a
  // trusted loopback fixture server for this no-internet unit test.
  const get = (url, options, cb) => http.get(`http://127.0.0.1:${port}${new URL(url).pathname}`, options, cb);
  const fastSleep = async () => {};
  const jar = path.join(tmp, 'spectorclient.jar');
  const stagedFiles = () => fs.readdirSync(tmp).filter(name => name.endsWith('.part'));
  try {
    await fsp.writeFile(jar, existing);
    let retries = 0;
    const result = await downloadSpectorJar('https://spectorclient.test/mod/download', jar, {
      get, sleep: fastSleep, onRetry: () => { retries += 1; }
    });
    assert.equal(result.attempt, 2);
    assert.equal(retries, 1);
    assert.equal(attempted.get('/mod/download'), 2);
    assert.deepEqual(await fsp.readFile(jar), existing, 'Existing mod must remain untouched during download');
    await verifyFabricJar(result.path);
    await installVerifiedSpectorJar(result.path, jar);
    assert.deepEqual(await fsp.readFile(jar), latest, 'Verified mod should replace existing copy');
    assert.deepEqual(stagedFiles(), [], 'No .part files after successful install');

    await assert.rejects(downloadSpectorJar('https://spectorclient.test/mod/download/26.3', jar, {
      get, sleep: fastSleep
    }), /valid Fabric mod JAR/);
    assert.equal(attempted.get('/mod/download/26.3'), 3, 'Invalid 200 HTML should retry');
    assert.deepEqual(await fsp.readFile(jar), latest, 'Malformed HTTP 200 must not corrupt installed mod');
    assert.deepEqual(stagedFiles(), [], 'No orphan partial files on invalid response');

    await assert.rejects(downloadSpectorJar('https://spectorclient.test/mod/download/1.21.11', jar, {
      get, sleep: fastSleep
    }), /HTTP 404/);
    assert.equal(attempted.get('/mod/download/1.21.11'), 1, 'Permanent HTTP 404 should not retry');
    assert.deepEqual(await fsp.readFile(jar), latest, 'Permanent HTTP error must preserve previous mod');

    const redirect = await downloadSpectorJar('https://spectorclient.test/redirect', jar, { get, sleep: fastSleep });
    await verifyFabricJar(redirect.path);
    await fsp.rm(redirect.path);
    await assert.rejects(downloadSpectorJar('https://spectorclient.test/insecure', jar, {
      get, sleep: fastSleep
    }), /HTTPS/);
    assert.equal(isRetryableModError({ code: 'EAI_AGAIN' }), true);
    assert.equal(isRetryableModError({ status: 503 }), true);
    assert.equal(isRetryableModError({ status: 403 }), false);
    await assert.rejects(downloadSpectorJar('https://spectorclient.test/broken', jar, {
      get, sleep: fastSleep
    }));
    assert.deepEqual(await fsp.readFile(jar), latest, 'Connection drop must preserve existing JAR');
    assert.deepEqual(stagedFiles(), [], 'All tests must clean up partial downloads');
    assert.equal(crypto.createHash('sha256').update(await fsp.readFile(jar)).digest('hex'), crypto.createHash('sha256').update(latest).digest('hex'));
    console.log('PASS: retry 503, reject HTML, fail fast 404, HTTPS redirects, connection reset, preserve old JAR, ZIP verification, atomic swap, cleanup.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
