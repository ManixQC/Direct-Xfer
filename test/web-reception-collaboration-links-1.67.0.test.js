'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createWebStorageShareTools } = require('../lib/web-storage-share');
const { createWebStorageWritableTools, createWebStorageUploadHandler, connectorStatus } = require('../lib/web-storage-writable');
const { StorageConnectorService } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js');
const app = read('public/app.js');
const html = read('public/index.html');
const pages = read('lib/server/public-pages.js');
const storage = read('lib/storage-connectors.js');
const writableSource = read('lib/web-storage-writable.js');

function fakeShare(type='inbox') {
  return { id:'s1', type, webStorage:{ connectorId:'c1', connectorName:'Cloud', connectorType:'webdav', remote:'cloud', root:'base', path:'target', isDir:true, readOnly:false } };
}
function makeTools(serviceOverrides={}) {
  const service = {
    async stat(_connector, rel) {
      if (rel.endsWith('taken.txt')) return { name:'taken.txt', path:rel, isDir:false, size:1, id:'x' };
      const err=Object.assign(new Error('not found'),{code:'remote-not-found'}); throw err;
    },
    async list(){ return []; },
    async exportFile(){ return {ok:true}; },
    async mkdir(){ return {ok:true}; },
    async remove(){ return {ok:true}; },
    async metrics(){ return {bytes:1,files:1}; },
    ...serviceOverrides,
  };
  const shares = createWebStorageShareTools({ storageConnectorService:service });
  const writable = createWebStorageWritableTools({ storageConnectorService:service, shareMeta:shares.shareMeta, joinedPath:shares.joinedPath, stat:shares.stat });
  return {service, shares, writable};
}

test('admin exposes dedicated web reception and web collaboration creation actions', () => {
  assert.match(html, /id="new-web-inbox-btn"/);
  assert.match(html, /id="new-web-collab-btn"/);
  assert.match(app, /openWebStorageModal\('inbox'\)/);
  assert.match(app, /openWebStorageModal\('collab'\)/);
  assert.match(app, /\/api\/inbox\/web-storage/);
  assert.match(app, /\/api\/collab\/web-storage/);
  assert.match(app, /webStorageMode==='inbox'\?await api\('POST',endpoint,payload\):await apiWithDlpOverride\('POST',endpoint,payload\)/);
});

test('write modes require selecting a directory and filter read-only connectors', () => {
  assert.match(app, /if\(writable\) connectors=connectors\.filter\(\(connector\)=>connector && !connector\.readOnly\)/);
  assert.match(app, /webStorageMode!==['"]share['"] && !webStorageSelectedIsDir/);
  assert.match(app, /else if\(webStorageMode==='share'\) webStorageSetSelection\(entry\.path,false,entry\.name\)/);
  assert.match(app, /webStorageSetSelection\(webStoragePath,true,webStoragePath\|\|'\/'\)/);
});

test('web reception/collaboration creation freezes a writable connector and directory route', () => {
  const block=server.slice(server.indexOf('async function createWebWritableShare'), server.indexOf("adminRouter.post('/shares/web-storage'"));
  assert.match(block, /connector\.readOnly/);
  assert.match(block, /remote-not-directory/);
  assert.match(block, /connector-changed-during-create/);
  assert.match(block, /webStorage:\{\.\.\.webStorageConnectorSnapshot\(connector\),path:remotePath,isDir:true/);
  assert.match(block, /moderated===true/);
  assert.match(block, /encrypted===true/);
});

test('web collaboration creation uses DLP but web reception remains write-only and ungated at creation', () => {
  const block=server.slice(server.indexOf('async function createWebWritableShare'), server.indexOf("adminRouter.post('/shares/web-storage'"));
  assert.match(block, /if\(type==='collab'&&webStorageDlpGate\(req,res,body,share\)\)return/);
  assert.doesNotMatch(block, /type==='inbox'&&webStorageDlpGate/);
});

test('share metadata supports web-storage, inbox and collab while carrying connector read-only state', () => {
  const { shares }=makeTools();
  for (const type of ['web-storage','inbox','collab']) {
    const meta=shares.shareMeta(fakeShare(type));
    assert.equal(meta.remote,'cloud');
    assert.equal(meta.path,'target');
    assert.equal(meta.isDir,true);
    assert.equal(meta.readOnly,false);
  }
});

test('writable helper publishes through the frozen route and never trusts a new browser path', async () => {
  let exported=null;
  const { writable }=makeTools({ async exportFile(meta, local, remote){ exported={meta,local,remote}; return exported; } });
  await writable.publishFile(fakeShare('inbox'), '/tmp/local.bin', 'docs/new.txt');
  assert.equal(exported.remote,'target/docs/new.txt');
  assert.equal(exported.meta.remote,'cloud');
  assert.equal(exported.meta.root,'base');
});

test('writable helper rejects read-only frozen connector metadata', async () => {
  const { writable }=makeTools();
  const share=fakeShare('inbox'); share.webStorage.readOnly=true;
  await assert.rejects(()=>writable.publishFile(share,'/tmp/x','x.txt'), (err)=>err && err.code==='read-only');
  assert.equal(connectorStatus({code:'read-only'}),409);
});

test('writable helper reserves a unique non-clobbering cloud name', async () => {
  const { writable }=makeTools();
  assert.equal(await writable.reserveUnique(fakeShare('inbox'),'docs','taken.txt'),'docs/taken (1).txt');
  assert.equal(await writable.reserveUnique(fakeShare('inbox'),'docs','free.txt'),'docs/free.txt');
});

test('rclone export uses immutable mode so another link/external writer cannot be overwritten', () => {
  const block=storage.slice(storage.indexOf('async exportFile'), storage.indexOf('async mkdir'));
  assert.match(block, /'--immutable'/);
});

test('cloud collaboration has list, file, folder and delete branches with ZIP/checksum disabled', () => {
  assert.match(server, /if\(s\.webStorage\).*webStorageList\(s/);
  assert.match(server, /serveWebStorageFile\(req,res,s/);
  assert.match(server, /webStorageWritable\.mkdir\(s/);
  assert.match(server, /webStorageWritable\.remove\(s/);
  assert.match(server, /if\(s\.webStorage\).*return sendError\(req,res,404/);
  assert.match(pages, /allowZip: !share\.webStorage && share\.allowZip !== false/);
  assert.match(pages, /const sumsBtn = share\.webStorage \? ''/);
  assert.match(app, /\$\('edit-allowzip'\)\.disabled = !!s\.webStorage/);
  assert.match(app, /\$\('edit-rx-rejectdup'\)\.disabled = !!s\.webStorage/);
  assert.match(app, /\$\('edit-rx-moderated'\)\.disabled = !!s\.webStorage/);
});

test('cloud reception/collaboration upload handler stages locally then publishes and removes the part', () => {
  assert.match(server, /if\(s\.webStorage\)return webStorageUploadHandler\(req,res,s\)/);
  assert.match(writableSource, /fs\.createWriteStream\(part/);
  assert.match(writableSource, /await tools\.publishFile\(s,\s*part,\s*remoteRel\)/);
  assert.match(writableSource, /await fs\.promises\.unlink\(part\)/);
  assert.match(writableSource, /rememberCompletedUpload/);
});

test('invalid explicit cloud upload paths are rejected instead of silently becoming file', () => {
  assert.match(writableSource, /if\s*\(!parsed\)\s*\{\s*req\.resume\(\);\s*return res\.status\(400\)\.json\(\{\s*error:'invalid-name'\s*\}\);\s*\}/);
  assert.doesNotMatch(writableSource, /\|\|\{dirSegs:\[\],filename:'file'\}/);
});

test('provider failures preserve resumable staging but return an upstream status instead of false conflict', () => {
  assert.match(writableSource, /res\.status\(connectorStatus\(\{\s*code:result\.error\s*\}\)\)\.json\(\{\s*error:result\.error,\s*offset:size\s*\}\)/);
  assert.doesNotMatch(writableSource, /connectorStatus\(\{code:result\.error\}\)===502\?409/);
});

test('global local reception disk accounting excludes persistent cloud-backed bytes', () => {
  const block=server.slice(server.indexOf('function currentReceptionBytes'), server.indexOf('function receptionDiskQuota'));
  assert.match(block, /!s\.webStorage/);
  const reject=server.slice(server.indexOf('function inboxRejectReason'), server.indexOf('function inboxRejectStatus'));
  assert.match(reject, /!s\.webStorage/);
});

test('universal search does not try to index a cloud reception/collaboration tree as local files', () => {
  assert.match(server, /\(s\.type === 'inbox' \|\| s\.type === 'collab'\) && !s\.webStorage/);
});

test('connector cannot be made read-only while a web reception/collaboration link references it', () => {
  assert.match(server, /writable:share\.type==='inbox'\|\|share\.type==='collab'/);
  assert.match(server, /connector-used-by-web-share/);
  assert.match(server, /refs\.some\(\(r\)=>r\.writable\)/);
});

test('clone/import and admin/PWA file browsers keep cloud-backed writable links remote', () => {
  assert.match(server, /source\.webStorage&&\(source\.type==='inbox'\|\|source\.type==='collab'\)/);
  assert.match(server, /delete clone\.relDir/);
  assert.match(server, /\['file', 'folder', 'inbox', 'collab', 'web-storage'\]/);
  assert.match(server, /rec\.webStorage && \['web-storage','inbox','collab'\]\.includes\(rec\.type\)/);
  assert.match(server, /adminRouter\.get\('\/shares\/:id\/received', async/);
  assert.match(server, /app\.get\('\/app\/inbox\/:token\/files'.*async/s);
  assert.match(server, /countStats:false/);
});

test('storage connector service has writable directory/delete/metrics primitives and enforces read-only', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-web-write-'));
  const service=new StorageConnectorService({bin:'unused',configPath:path.join(temp,'rclone.conf'),importRoot:path.join(temp,'imports')});
  const calls=[];
  service.run=async(args)=>{calls.push(args); if(args[0]==='size')return{stdout:'{"count":2,"bytes":9}',stderr:''}; return{stdout:'',stderr:''};};
  const connector={remote:'fake',root:'base',readOnly:false};
  await service.mkdir(connector,'target/sub');
  await service.remove(connector,'target/sub/file.txt',{isDir:false});
  const m=await service.metrics(connector,'target/sub');
  assert.deepEqual(m,{bytes:9,files:2});
  assert.equal(calls[0][0],'mkdir');
  assert.equal(calls[1][0],'deletefile');
  assert.equal(calls[2][0],'size');
  await assert.rejects(()=>service.mkdir({...connector,readOnly:true},'x'), (e)=>e&&e.code==='read-only');
  fs.rmSync(temp,{recursive:true,force:true});
});


test('cloud upload handler really stages a small upload, publishes it, accounts it and removes local staging', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-web-upload-'));
  let published=null;
  const tools={
    async reserveUnique(_share,dir,name){ return [dir,name].filter(Boolean).join('/'); },
    async publishFile(_share,local,remote){ published={local,remote,data:fs.readFileSync(local,'utf8')}; },
    async remove(){},
  };
  const uploadsInFlight=new Set(),uploadTransfers=new Map(),stoppedUploads=new Set();
  const handler=createWebStorageUploadHandler({tools,deps:{
    PARTS_DIR:temp,
    safeUploadRelPath(raw){const v=String(raw||'');return v==='a.txt'?{dirSegs:[],filename:'a.txt'}:null;},
    safeUploadId(){return null;}, scopedUploadId(){return null;}, partPath(){return path.join(temp,'id.part');},
    completedUploadReceipt(){return null;}, rememberCompletedUpload(){}, cleanSenderName(){return '';},
    senderSubdirSegs(){return [];}, senderTaggedName(_s,n){return n;}, uploadSenderKey(){return 'k';},
    inboxRejectReason(){return null;}, perSenderRejectReason(){return null;}, inboxRejectStatus(){return 400;},
    beginPublicUpload(){return true;}, effMaxUpload(){return 0;},
    startTransfer(){return {bytes:0,lastActivity:Date.now()};}, endTransfer(){},
    async withShareUploadLock(_id,fn){return fn();},
    clamavEnabled(){return false;}, async scanGate(){return true;}, async inboxContentReason(){return null;},
    async rejectSuspendedUploadFinalize(){return false;}, async hashFileSha256(){return '';},
    applyReceptionAccountingState(share,{size}){share.bytesReceived=(share.bytesReceived||0)+size;share.downloads=(share.downloads||0)+1;return{};},
    persistNow(){return true;}, finalizeReceptionAccountingEffects(){}, recordRansomwareEvent(){return null;},
    restorePlainObject(){}, scheduleSearchReindex(){}, emitInboxEvent(){}, validSha256Hex(){return '';},
    uploadsInFlight,uploadTransfers,stoppedUploads,
  }});
  const req=Readable.from([Buffer.from('abc')]);req.query={name:'a.txt',size:'3'};req.headers={'content-length':'3'};
  const share=fakeShare('inbox');share.bytesReceived=0;share.downloads=0;share.moderated=false;share.encrypted=false;share.maxFileBytes=0;
  let resolveResponse;const responseDone=new Promise((resolve)=>{resolveResponse=resolve;});
  const res={headersSent:false,statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;this.headersSent=true;resolveResponse();return this;}};
  await handler(req,res,share);await responseDone;
  assert.equal(res.statusCode,200);assert.equal(res.body.ok,true);assert.equal(res.body.webStorage,true);
  assert.deepEqual({remote:published.remote,data:published.data},{remote:'a.txt',data:'abc'});
  assert.equal(share.bytesReceived,3);assert.equal(share.downloads,1);
  assert.equal(fs.existsSync(published.local),false);
  fs.rmSync(temp,{recursive:true,force:true});
});
