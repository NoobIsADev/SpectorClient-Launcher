'use strict';
// v1.6.62: verify Satellite quiet mode and Steve / grey SIGN IN behavior.
// Runs without Electron or Minecraft dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const src = Object.fromEntries(['main.js','renderer.js','index.html','refinements-v1662.css'].map(n => [n,fs.readFileSync(path.join(root,'src',n),'utf8')]));
const pkg = require('../package.json');
assert(Number(pkg.version.split('.')[2]) >= 62, 'v1.6.62 features remain in newer releases');
assert(pkg.scripts['verify:ui'].includes('verify-v1662.js'));
assert(!/sat(?:a|e)lite|satillite/i.test(src['renderer.js']+src['main.js']+src['index.html']), 'Satellite spelled correctly in app source');
assert(src['index.html'].includes('href="refinements-v1662.css"'));
assert(src['index.html'].includes('id="playBtn" class="play-main signed-out"'));
assert(src['index.html'].includes('<b>SIGN IN</b>'));
assert(src['index.html'].includes('id="topAccountAvatar" class="tiny-avatar" src="assets/steve-head.png"'));
assert(!src['index.html'].includes('<span>?</span>'), 'Signed-out player placeholder must not be a question mark');
assert(src['refinements-v1662.css'].includes('.play-main.signed-out'));
assert(src['refinements-v1662.css'].includes('background: linear-gradient(180deg, #434b58, #313743)'));

for(const [name,w,h] of [['steve-default.png',64,64],['steve-body.png',256,512],['steve-head.png',64,64]]) {
  const buf=fs.readFileSync(path.join(root,'src/assets',name));
  assert(buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),name+' has PNG header');
  assert.equal(buf.readUInt32BE(16),w,name+' width');
  assert.equal(buf.readUInt32BE(20),h,name+' height');
}
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'src/assets/home-player-background.png'))).digest('hex'), 'ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793');

function fn(source,name,asyncFn=false) {
  const begin=`${asyncFn?'async ':''}function ${name}(`;
  const i=source.indexOf(begin);
  assert(i>=0,'Missing function '+name);
  const j=source.indexOf('\n}\n',i);
  assert(j>i,'No function end: '+name);
  return source.slice(i,j+2);
}

// Evaluate the real main-process notification functions with a mock running
// child, simulated launch-preparation state, DND and ordinary game/update toasts.
let delivered=[];
class MockNotification {
  constructor(info){this.info=info;delivered.push(info);}
  static isSupported(){return true;}
  on(){}
  show(){}
}
const mainCtx=vm.createContext({
  activeGameProcess:null,gameLaunchInProgress:false,
  satelliteState:{presenceMode:'online'},
  Notification:MockNotification,
  BRAND_IMAGE_PATH:'/dummy/brand.png',
  PRODUCT_NAME:'SpectorClient',
  lastNativeUpdateNoticeVersion:'',lastNativeInstallNoticeVersion:'',
  mainWindow:null,process:{platform:'win32'},log(){},
  normalizeSocialPresenceMode(v){return String(v||'online');}
});
for(const name of ['isMinecraftRunning','satelliteDesktopNotificationsEnabled','showNativeNotification']) vm.runInContext(fn(src['main.js'],name),mainCtx);
function native(kind){return vm.runInContext(`showNativeNotification('Test', 'Body', { kind: ${JSON.stringify(kind)} })`,mainCtx);}
const satKinds=['satellite-message','satellite-friend-request','satellite-friend-playing','satellite-friend-server','satellite-new-future-type'];
for(const stage of ['preparing','running']){
  mainCtx.gameLaunchInProgress=stage==='preparing';
  mainCtx.activeGameProcess=stage==='running'?{exitCode:null}:null;
  assert.equal(vm.runInContext('satelliteDesktopNotificationsEnabled()',mainCtx),false,stage+' should be quiet');
  for(const k of satKinds) assert.equal(native(k),false,`${stage}/${k}`);
  assert.equal(delivered.length,0,'No native Satellite notifications during Minecraft');
  assert.equal(native('game-started'),true,'Minecraft startup notification remains allowed');
  delivered.length=0;
}
mainCtx.activeGameProcess={exitCode:0};mainCtx.gameLaunchInProgress=false;
assert.equal(vm.runInContext('isMinecraftRunning()',mainCtx),false,'Exited game must not suppress notifications');
assert.equal(vm.runInContext('satelliteDesktopNotificationsEnabled()',mainCtx),true);
assert.equal(native('satellite-message'),true,'Satellite notifications resume after exit');
assert.equal(delivered.length,1);delivered=[];
mainCtx.satelliteState.presenceMode='dnd';
assert.equal(vm.runInContext('satelliteDesktopNotificationsEnabled()',mainCtx),false,'DND still suppresses');
mainCtx.satelliteState.presenceMode='online';

// Test the real renderer's play-button state logic: grey SIGN IN when signed
// out, normal PLAY when signed in, STOP preserved during a running game.
function fakeClassList(){const s=new Set();return {toggle:(k,v)=>v?s.add(k):s.delete(k),add:(k)=>s.add(k),remove:(k)=>s.delete(k),contains:k=>s.has(k)};}
const button={disabled:true,classList:fakeClassList(),attributes:{},setAttribute(n,v){this.attributes[n]=v;},querySelector(q){return q==='.play-icon'?icon:q==='b'?label:null;}};
const icon={textContent:''},label={textContent:''},sub={textContent:''};
const renderCtx=vm.createContext({
  settings:{selectedAccountId:null,accounts:[]},
  selectedAccount(){return this.settings?.accounts?.find(a=>a.id===this.settings?.selectedAccountId)||null;},
  // Avoid relying on `this` binding from a window/DOM callback.
  selectedGameVersion:()=> '26.3',
  $:id=>id==='playBtn'?button:id==='playSubtext'?sub:undefined,
  launching:false,gameRunning:false,stoppingGame:false,runningGameVersion:null
});
renderCtx.selectedAccount=()=>renderCtx.settings.accounts.find(a=>a.id===renderCtx.settings.selectedAccountId)||null;
vm.runInContext(fn(src['renderer.js'],'updatePlayState'),renderCtx);
vm.runInContext('updatePlayState()',renderCtx);
assert.equal(label.textContent,'SIGN IN');
assert.equal(button.disabled,false,'Grey sign-in action must be usable');
assert.equal(button.classList.contains('signed-out'),true);
assert.equal(icon.textContent,'');
assert(sub.textContent.toLowerCase().includes('microsoft'));
renderCtx.settings={selectedAccountId:'user',accounts:[{id:'user',name:'Player'}]};
vm.runInContext('updatePlayState()',renderCtx);
assert.equal(label.textContent,'PLAY');
assert.equal(button.classList.contains('signed-out'),false);
assert.equal(button.disabled,false);
renderCtx.gameRunning=true;
vm.runInContext('updatePlayState()',renderCtx);
assert.equal(label.textContent,'STOP','Existing game must remain stoppable');
renderCtx.gameRunning=false;renderCtx.settings={selectedAccountId:null,accounts:[]};

// Verify the same 3D player viewer is used for signed-out Steve and that
// the signed-in texture still comes from the account's existing backend.
let loadedSkins=[],remoteSkinFetches=0;
const viewer={controls:{},loadSkin:async url=>{loadedSkins.push(url);}};
const skinCtx=vm.createContext({ensureSkinViewer:()=>viewer,skinLoadSerial:0,window:{launcher:{getSkinData:async id=>{remoteSkinFetches++;return 'data:image/png;base64,abc-'+id;}}}});
vm.runInContext(fn(src['renderer.js'],'loadInteractiveSkin',true),skinCtx);
(async()=>{
  assert.equal(await vm.runInContext('loadInteractiveSkin(null)',skinCtx),true);
  assert.equal(loadedSkins[0],'assets/steve-default.png');
  assert.equal(remoteSkinFetches,0,'Steve must be bundled and offline-capable');
  assert.equal(await vm.runInContext('loadInteractiveSkin({id:"user"})',skinCtx),true);
  assert.equal(loadedSkins[1],'data:image/png;base64,abc-user');
  assert.equal(remoteSkinFetches,1);
  // Unsolicited Satellite message, friend request and acceptance toasts must
  // be silent while running, but the message stream and statuses remain live.
  let toasts=[],callback;
  const eventCtx=vm.createContext({
    window:{launcher:{onSocialEvent:fn=>{callback=fn;},markMessagesRead:async()=>{}}},
    socialState:{me:{id:'me'}},selectedAccount:()=>({uuid:'me'}),
    socialChatUserId:null,socialMessages:[],socialTypingTimer:null,
    socialFriendById:()=>({username:'Friend'}),
    showToast:(s)=>toasts.push(s),
    gameRunning:true,launching:false,stoppingGame:false,
    closeSocialChat:()=>{},renderSocialMessages:()=>{},clearTimeout:()=>{},setTimeout:()=>0,
    $:()=>({classList:{toggle(){},add(){}},textContent:''})
  });
  vm.runInContext(fn(src['renderer.js'],'satelliteToastNotificationsEnabled'),eventCtx);
  let eventStart=src['renderer.js'].indexOf('window.launcher.onSocialEvent((packet) => {');
  let eventEnd=src['renderer.js'].indexOf('\n});',eventStart);
  assert(eventStart>=0&&eventEnd>eventStart);
  vm.runInContext(src['renderer.js'].slice(eventStart,eventEnd+4),eventCtx);
  callback({type:'message.new',message:{id:'m1',from:'friend',to:'me',text:'Hi'}});
  callback({type:'friend.request',from:{username:'Friend'}});
  callback({type:'friend.accepted',user:{username:'Friend'}});
  assert.equal(toasts.length,0,'No renderer Satellite toasts while game runs');
  eventCtx.gameRunning=false;
  callback({type:'message.new',message:{id:'m2',from:'friend',to:'me',text:'Hello again'}});
  assert.equal(toasts.length,1,'Satellite toasts resume after game closes');
  eventCtx.gameRunning=true;
  eventCtx.socialChatUserId='friend';
  callback({type:'message.new',message:{id:'m3',from:'friend',to:'me',text:'Visible chat still works'}});
  assert.equal(eventCtx.socialMessages.length,1,'Messages still reach an open chat during gameplay');
  assert.equal(toasts.length,1,'Active-chat messages have no extra toasts');
  assert(src['renderer.js'].includes("if (!gameRunning && !selectedAccount()) {\n    await startAddAccount();"),'SIGN IN action must actually start Microsoft login');
  console.log('PASS: v1.6.62 native Satellite quiet mode, renderer toasts, signed-out Steve, grey SIGN IN, normal Play/Stop, asset integrity and account sign-in.');
})().catch(e=>{console.error(e);process.exitCode=1;});
