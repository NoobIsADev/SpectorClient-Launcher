// Regression checks for v1.6.48 minimal Mods controls and centered logo asset.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const { centerVisibleArtwork } = require('./center-logo-artwork');
const html = read('src/index.html');
const renderer = read('src/renderer.js');
const styles = read('src/refinements-v1648.css');
const assets = read('scripts/fetch-brand.js');
const pkg = require('../package.json');
assert(Number(pkg.version.split('.')[2]) >= 48, 'v1.6.48 logo/menu baseline must remain');
assert(html.includes('<link rel="stylesheet" href="refinements-v1648.css" />'));
assert.equal((html.match(/id="changeModVersionBtn"/g)||[]).length, 1);
assert(html.includes('id="changeModVersionBtn"') && html.includes('>Change version</button>'));
assert(!html.includes('FABRIC CONTENT'), 'No Fabric Content badge');
assert(!html.includes('class="mod-target-indicator"'), 'Remove badge markup');
assert(html.includes('id="modSelectedVersionLabel" hidden'), 'Keep existing version state ID');
assert(renderer.includes("$('changeModVersionBtn').textContent = 'Change version'"));
assert(html.includes('id="modVersionChooser"'), 'Keep mod version selection');
assert(html.includes('id="modManagerContent"'), 'Keep mod list');
assert(renderer.includes("$('modVersionChooser')?.classList.add('hidden')"));
assert(styles.includes('background: transparent !important;'), 'Remove heavy background bars');
assert(styles.includes('.version-featured-logo') && styles.includes('.rail-logo'), 'Center logos across menus');
assert(assets.includes("const BRAND_URL = 'https://i.imgur.com/nP9aVFe.png'"), 'Preserve original logo URL');
assert(assets.includes('centerVisibleArtwork(PNG.sync.read(zoomPng(png, 1.10)))'), 'Center actual PNG pixels during asset prep');
assert(assets.includes('centerVisibleArtwork(PNG.sync.read(png))'), 'Also center cached PNG when offline');

const createImage = (w,h,coords) => {
  const data = Buffer.alloc(w*h*4);
  for (const [x,y] of coords) {
    const i=(y*w+x)*4; data[i]=15; data[i+1]=160; data[i+2]=255; data[i+3]=255;
  }
  return {width:w,height:h,data};
};
const offcenter = createImage(15,15,[[1,8],[2,8],[3,8],[1,9],[2,9],[3,9]]);
const balanced = centerVisibleArtwork(offcenter);
let sumX=0, sumY=0, total=0;
for (let y=0;y<15;y++) for (let x=0;x<15;x++) if (balanced.data[(y*15+x)*4+3]) {sumX+=x;sumY+=y;total++;}
assert.equal(total,6,'Never lose visible logo pixels');
assert.equal(sumX/total,7,'Center visible X pixels');
assert(Math.abs(sumY/total-7)<=0.5,'Center visible Y pixels to within a half-pixel');
assert.strictEqual(centerVisibleArtwork(balanced),balanced,'Centered image remains unchanged');
const empty=createImage(8,8,[]);
assert.strictEqual(centerVisibleArtwork(empty),empty,'Transparent image safe');
const solid=createImage(2,2,[[0,0],[0,1],[1,0],[1,1]]);
assert.strictEqual(centerVisibleArtwork(solid),solid,'Opaque image safe');
assert.throws(()=>centerVisibleArtwork({width:2,height:2,data:Buffer.alloc(2)}));
console.log('PASS: v1.6.48 compact version control, bar removal, logo centering and original asset URL.');
