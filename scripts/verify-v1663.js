'use strict';
// v1.6.63: source-level regression for exact user-supplied signed-out skin
// and the SAME draggable skinview3d canvas used for signed-in account skins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const pkg=require('../package.json');
assert.equal(pkg.version,'1.6.63');
assert(pkg.scripts['verify:ui'].includes('verify-v1663.js'));

const skin=fs.readFileSync(path.join(root,'src/assets/steve-default.png'));
const hash=crypto.createHash('sha256').update(skin).digest('hex');
assert.equal(hash,'026b457125b520ab384990254bbbf9cb3415f06c5335ee9de7074c7c5dc96f6b','Original uploaded skin PNG must be byte-for-byte preserved');
assert.equal(skin.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
assert.equal(skin.readUInt32BE(16),64);
assert.equal(skin.readUInt32BE(20),64);
for (const [name,w,h] of [['steve-head.png',64,64],['steve-body.png',256,512]]){
  const buf=fs.readFileSync(path.join(root,'src/assets',name));
  assert.equal(buf.subarray(0,8).toString('hex'),'89504e470d0a1a0a',name);
  assert.equal(buf.readUInt32BE(16),w,name+' width');
  assert.equal(buf.readUInt32BE(20),h,name+' height');
}
const html=read('src/index.html');
const css=read('src/refinements-v1663.css');
const renderer=read('src/renderer.js');
const assetModule=read('src/steve-skin-data.js');
const foundData=assetModule.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
assert(foundData,'Data URL embedded for guaranteed local/offline 3D skin');
assert(Buffer.from(foundData[1],'base64').equals(skin),'Data URL uses exact uploaded bytes');
assert(html.includes('src="steve-skin-data.js"'),'Skin data loads before renderer');
assert(html.includes('refinements-v1663.css'));
assert(html.includes('id="skinViewerCanvas"'));
assert(html.includes('Drag to rotate your Minecraft character'));
assert(css.includes('#view-home #skinViewerCanvas:not(.hidden)'));
assert(css.includes('pointer-events: auto !important'));
assert(css.includes('touch-action: none'));
assert(css.includes('-webkit-app-region: no-drag'));
assert(css.includes('pointer-events: none'));
assert.equal((html.match(/id="skinViewerCanvas"/g)||[]).length,1,'Only ONE 3D canvas for both account modes');
const findFunction=(name,asyncName=false)=>{
  const start=renderer.indexOf(`${asyncName?'async ':''}function ${name}(`);
  assert(start>=0,`${name} present`);
  const end=renderer.indexOf('\n}\n',start);
  assert(end>start,`${name} body found`);
  return renderer.slice(start,end+2);
};
function classList(initial=[]){
  const v=new Set(initial);
  return {add:k=>v.add(k),remove:k=>v.delete(k),contains:k=>v.has(k)};
}
const canvas={classList:classList(['hidden']),style:{}};
const fallback={classList:classList(['hidden']),src:'',alt:'',removeAttribute(k){if(k==='src')this.src='';}};
const placeholder={classList:classList(['hidden'])};
const elements={skinViewerCanvas:canvas,playerSkinFallback:fallback,skinPlaceholder:placeholder,homeAccountName:{textContent:''}};
let created=0,loaded=[],currentAccount=null,getSkinCalls=0;
class MockSkinViewer{
  constructor(opts){
    assert.equal(opts.canvas,canvas);
    created++;
    this.controls={enabled:false,enableRotate:false,enableZoom:true,enablePan:true};
    this.renderer={setClearColor(){}};
  }
  async loadSkin(texture,opts){loaded.push({texture,opts});}
}
const ctx=vm.createContext({
  skinview3d:{SkinViewer:MockSkinViewer},
  spectorDefaultSteveSkinDataUrl: `data:image/png;base64,${foundData[1]}`, 
  skinViewer:null,skinLoadSerial:0,
  $:id=>elements[id],
  selectedAccount:()=>currentAccount,
  window:{launcher:{getSkinData:async id=>{getSkinCalls++;return `data:image/png;base64,skin-${id}`;}}},
  skinBodyUrl:()=> 'https://example.test/body',
  console
});
for(const [name,asyncName] of [['ensureSkinViewer',false],['loadInteractiveSkin',true],['renderPlayer',true]]) vm.runInContext(findFunction(name,asyncName),ctx);
(async()=>{
  await vm.runInContext('renderPlayer()',ctx);
  assert.equal(created,1,'Signed-out view creates the same interactive viewer');
  assert.equal(loaded.length,1);
  assert.equal(loaded[0].texture,`data:image/png;base64,${foundData[1]}`,'Signed-out 3D uses the EXACT uploaded PNG through inline data URL');
  assert.equal(loaded[0].opts.model,'default','Classic Steve arm model');
  assert.equal(ctx.skinViewer.controls.enabled,true);
  assert.equal(ctx.skinViewer.controls.enableRotate,true);
  assert.equal(ctx.skinViewer.controls.enableZoom,false);
  assert.equal(ctx.skinViewer.controls.enablePan,false);
  assert.equal(canvas.style.touchAction,'none');
  assert.equal(canvas.classList.contains('hidden'),false,'3D canvas visible for signed-out Steve');
  assert.equal(fallback.classList.contains('hidden'),true,'Static fallback remains hidden when WebGL works');
  assert.equal(getSkinCalls,0,'No Microsoft skin request when signed out');

  currentAccount={id:'minecraft-user',name:'Player'};
  await vm.runInContext('renderPlayer()',ctx);
  assert.equal(created,1,'Signed-in view REUSES the SAME viewer');
  assert.equal(loaded[1].texture,'data:image/png;base64,skin-minecraft-user');
  assert.equal(loaded[1].opts,undefined,'Signed-in load options unchanged');
  assert.equal(getSkinCalls,1);
  assert.equal(ctx.skinViewer.controls.enabled,true);
  assert.equal(ctx.skinViewer.controls.enableRotate,true);
  assert.equal(canvas.classList.contains('hidden'),false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'src/assets/home-player-background.png'))).digest('hex'),'ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793','Original user landscape unchanged');
  console.log('PASS v1.6.63: exact skin upload bytes, matching fallback images, signed-out mouse/touch drag, shared 3D canvas, account skins unchanged, background unchanged.');
})().catch(e=>{ console.error(e);process.exitCode=1; });
