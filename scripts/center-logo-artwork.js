// Center the logo's *visible pixels*, not merely its (possibly asymmetrically
// padded) PNG canvas. This stays dependency-free so it can be unit-tested
// without downloading anything or changing the brand artwork/URL.
'use strict';

function centerVisibleArtwork(image) {
  const { width, height, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !data || data.length !== width * height * 4) {
    throw new Error('Expected RGBA logo image data');
  }
  let minX = width, minY = height, maxX = -1, maxY = -1;
  // Small alpha shadows shouldn't determine the geometric center.
  const alphaThreshold = 32;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < alphaThreshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return image;

  const shiftX = Math.round((width - 1 - minX - maxX) / 2);
  const shiftY = Math.round((height - 1 - minY - maxY) / 2);
  // Do not clip opaque artwork: retain the entire visible bounding box.
  const dx = Math.max(-minX, Math.min(width - 1 - maxX, shiftX));
  const dy = Math.max(-minY, Math.min(height - 1 - maxY, shiftY));
  if (dx === 0 && dy === 0) return image;
  const result = Buffer.alloc(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
      const from = (y * width + x) * 4;
      const to = (ty * width + tx) * 4;
      result[to] = data[from];
      result[to + 1] = data[from + 1];
      result[to + 2] = data[from + 2];
      result[to + 3] = data[from + 3];
    }
  }
  return { width, height, data: result };
}

module.exports = { centerVisibleArtwork };
