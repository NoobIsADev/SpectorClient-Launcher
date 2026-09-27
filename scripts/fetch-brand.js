const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { PNG } = require('pngjs');
const { version: LAUNCHER_VERSION } = require('../package.json');

const BRAND_URL = 'https://i.imgur.com/nP9aVFe.png';
const PLAYER_BACKGROUND_URL = 'https://i.imgur.com/QS6Qx8V.png';
const ROOT = path.resolve(__dirname, '..');
const UI_PNG_PATH = path.join(ROOT, 'src', 'assets', 'spector-logo.png');
const PLAYER_BACKGROUND_PATH = path.join(ROOT, 'src', 'assets', 'player-background.png');
const BUILD_PNG_PATH = path.join(ROOT, 'build', 'icon.png');
const OLD_ICO_PATH = path.join(ROOT, 'build', 'icon.ico');

function fetchBuffer(url, redirects = 8, referer = undefined) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': `SpectorClient-Launcher/${LAUNCHER_VERSION}`,
      'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.7'
    };
    if (referer) headers.Referer = referer;

    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
        const nextUrl = new globalThis.URL(res.headers.location, url).toString();
        res.resume();
        return fetchBuffer(nextUrl, redirects - 1, referer).then(resolve, reject);
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`Asset download failed with HTTP ${status}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Asset download timed out')));
  });
}

function pngDimensions(png) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 24 || !png.subarray(0, 8).equals(sig)) {
    throw new Error('Downloaded branding is not a PNG image.');
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}



function zoomPng(buffer, zoom = 1.10) {
  const source = PNG.sync.read(buffer);
  const cropWidth = Math.max(1, Math.round(source.width / zoom));
  const cropHeight = Math.max(1, Math.round(source.height / zoom));
  const cropX = Math.max(0, Math.floor((source.width - cropWidth) / 2));
  const cropY = Math.max(0, Math.floor((source.height - cropHeight) / 2));
  const output = new PNG({ width: source.width, height: source.height });

  // Bilinear resampling keeps the logo clean at taskbar sizes while making
  // the artwork itself 10% larger inside the same PNG canvas.
  for (let y = 0; y < output.height; y += 1) {
    const sy = cropY + (y / Math.max(1, output.height - 1)) * Math.max(0, cropHeight - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < output.width; x += 1) {
      const sx = cropX + (x / Math.max(1, output.width - 1)) * Math.max(0, cropWidth - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sx - x0;
      const outIndex = (output.width * y + x) << 2;

      const i00 = (source.width * y0 + x0) << 2;
      const i10 = (source.width * y0 + x1) << 2;
      const i01 = (source.width * y1 + x0) << 2;
      const i11 = (source.width * y1 + x1) << 2;

      for (let channel = 0; channel < 4; channel += 1) {
        const top = source.data[i00 + channel] * (1 - fx) + source.data[i10 + channel] * fx;
        const bottom = source.data[i01 + channel] * (1 - fx) + source.data[i11 + channel] * fx;
        output.data[outIndex + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }

  return PNG.sync.write(output, { colorType: 6 });
}

async function prepareLogo() {
  let png;
  try {
    png = await fetchBuffer(BRAND_URL, 8, 'https://imgur.com/');
    const { width, height } = pngDimensions(png);
    if (width < 256 || height < 256) {
      throw new Error(`Logo is ${width}x${height}; Windows builds need at least 256x256.`);
    }
    png = zoomPng(png, 1.10);
    await fsp.writeFile(UI_PNG_PATH, png);
    process.stdout.write(`SpectorClient logo updated with 10% zoom: ${UI_PNG_PATH}\n`);
  } catch (error) {
    if (!fs.existsSync(UI_PNG_PATH)) throw error;
    png = await fsp.readFile(UI_PNG_PATH);
    const { width, height } = pngDimensions(png);
    if (width < 256 || height < 256) {
      throw new Error(`Cached logo is ${width}x${height}; Windows builds need at least 256x256.`);
    }
    process.stderr.write(`Logo refresh skipped (${error.message}); using cached copy.\n`);
  }

  await fsp.writeFile(BUILD_PNG_PATH, png);
  await fsp.rm(OLD_ICO_PATH, { force: true });
  process.stdout.write(`Windows icon source prepared: ${BUILD_PNG_PATH}\n`);
}

async function preparePlayerBackground() {
  try {
    const image = await fetchBuffer(PLAYER_BACKGROUND_URL, 8, 'https://media.essential.gg/');
    if (image.length < 4096) throw new Error('Downloaded player background is unexpectedly small.');
    await fsp.writeFile(PLAYER_BACKGROUND_PATH, image);
    process.stdout.write(`Player scene background updated: ${PLAYER_BACKGROUND_PATH}\n`);
  } catch (error) {
    if (!fs.existsSync(PLAYER_BACKGROUND_PATH)) throw error;
    process.stderr.write(`Player background refresh skipped (${error.message}); using cached copy.\n`);
  }
}

(async () => {
  await Promise.all([
    fsp.mkdir(path.dirname(UI_PNG_PATH), { recursive: true }),
    fsp.mkdir(path.dirname(BUILD_PNG_PATH), { recursive: true })
  ]);

  await Promise.all([prepareLogo(), preparePlayerBackground()]);
})().catch((error) => {
  console.error(`Could not prepare SpectorClient assets: ${error.message}`);
  process.exitCode = 1;
});
