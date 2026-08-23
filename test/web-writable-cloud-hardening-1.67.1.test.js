'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createWebStorageShareTools } = require('../lib/web-storage-share');
const { createWebStorageWritableTools, createWebStorageUploadHandler } = require('../lib/web-storage-writable');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js') + '\n' + read('lib/server/admin-share-routes.js');
const receptionRoutes = read('lib/server/reception-collaboration-routes.js');
const writableSource = read('lib/web-storage-writable.js');
const pwaRoutes = read('lib/server/pwa-routes.js');
const shareSource = read('lib/web-storage-share.js');

function fakeShare(type='inbox') {
  return { id:'s1', type, downloads:0, bytesReceived:0, maxFileBytes:0, webStorage:{ connectorId:'c1', connectorName:'Cloud', connectorType:'webdav', remote:'cloud', root:'base', path:'target', isDir:true, readOnly:false } };
}

function makeRes() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  return {
    done,
    res:{
      headersSent:false, statusCode:200, body:null,
      status(code){ this.statusCode=code; return this; },
      json(body){ this.body=body; this.headersSent=true; resolve(); return this; },
    },
  };
}

function uploadFixture(temp, overrides={}) {
  const uploadsInFlight = new Set(), uploadTransfers = new Map(), stoppedUploads = new Map();
  const ended=[]; let starts=0, published=[];
  const tools={
    async reserveUnique(_s,dir,name){ return [dir,name].filter(Boolean).join('/'); },
    async publishFile(_s,local,remote){ published.push({remote,data:fs.readFileSync(local,'utf8')}); },
    async remove(){},
    trackPublished(share,rel,size){ share.webStorageUploaded=share.webStorageUploaded||Object.create(null); share.webStorageUploaded[rel]=size; },
    ...overrides.tools,
  };
  const deps={
    PARTS_DIR:temp,
    safeUploadRelPath(raw){ const v=String(raw||''); return v ? {dirSegs:[],filename:v} : null; },
    safeUploadId(raw){ const v=String(raw||''); return /^[a-z0-9_-]{1,32}$/i.test(v)?v:null; },
    scopedUploadId(s,id){ return `${s.id}:${id}`; },
    partPath(s,id){ return path.join(temp,`${s.id}-${id}.part`); },
    completedUploadReceipt(){ return null; }, rememberCompletedUpload(){}, cleanSenderName(){ return ''; },
    senderSubdirSegs(){ return []; }, senderTaggedName(_sender,name){ return name; }, uploadSenderKey(){ return 'k'; },
    inboxRejectReason(){ return null; }, perSenderRejectReason(){ return null; }, inboxRejectStatus(reason){ return reason==='file-too-large'?413:400; },
    beginPublicUpload(){ return true; }, effMaxUpload(){ return 0; },
    startTransfer(_req,meta,total){ starts+=1; return {id:`t${starts}`,name:meta.name,expectedBytes:total,bytes:0,lastActivity:Date.now(),ended:false}; },
    endTransfer(t,ok,reason){ if(!t||t.ended)return; t.ended=true; ended.push({ok,reason,bytes:t.bytes}); },
    async withShareUploadLock(_id,fn){ return fn(); },
    clamavEnabled(){ return false; }, async scanGate(){ return true; }, async inboxContentReason(){ return null; }, async rejectSuspendedUploadFinalize(){ return false; },
    async hashFileSha256(){ return ''; },
    applyReceptionAccountingState(share,{size}){ share.bytesReceived+=size; share.downloads+=1; return {size}; },
    persistNow(){ return true; }, finalizeReceptionAccountingEffects(){}, recordRansomwareEvent(){}, restorePlainObject(target,before){ for(const k of Object.keys(target))delete target[k];Object.assign(target,before); },
    scheduleSearchReindex(){}, emitInboxEvent(){}, validSha256Hex(){ return ''; },
    uploadsInFlight, uploadTransfers, stoppedUploads,
    ...overrides.deps,
  };
  return { handler:createWebStorageUploadHandler({tools,deps}), deps, tools, uploadsInFlight, uploadTransfers, stoppedUploads, ended, get starts(){return starts;}, get published(){return published;} };
}

async function sendChunk(fixture, share, {id='u1', pathName='a.txt', size=6, offset=0, data='abc'}={}) {
  const req=Readable.from([Buffer.from(data)]); req.query={id,path:pathName,size:String(size),offset:String(offset)}; req.headers={'content-length':String(Buffer.byteLength(data))};
  const {res,done}=makeRes(); await fixture.handler(req,res,share); await done; return res;
}

test('resumable cloud upload reuses one transfer across chunks and completes exactly once', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-cloud-resume-')); const f=uploadFixture(temp), share=fakeShare('collab');
  const first=await sendChunk(f,share,{data:'abc',offset:0,size:6});
  assert.equal(first.statusCode,409); assert.equal(first.body.offset,3); assert.equal(f.starts,1); assert.equal(f.ended.length,0); assert.equal(f.uploadTransfers.size,1);
  const second=await sendChunk(f,share,{data:'def',offset:3,size:6});
  assert.equal(second.statusCode,200); assert.equal(second.body.ok,true); assert.equal(f.starts,1); assert.deepEqual(f.ended,[{ok:true,reason:undefined,bytes:6}]);
  assert.equal(f.uploadTransfers.size,0); assert.equal(f.uploadsInFlight.size,0); assert.deepEqual(f.published,[{remote:'a.txt',data:'abcdef'}]);
  assert.equal(share.webStorageUploaded['a.txt'],6); assert.equal(fs.existsSync(path.join(temp,'s1-u1.part')),false);
  fs.rmSync(temp,{recursive:true,force:true});
});

test('an in-progress upload id cannot be retargeted to a different cloud path or size', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-cloud-conflict-')); const f=uploadFixture(temp), share=fakeShare('collab');
  await sendChunk(f,share,{pathName:'a.txt',data:'abc',offset:0,size:6});
  const conflict=await sendChunk(f,share,{pathName:'b.txt',data:'def',offset:3,size:6});
  assert.equal(conflict.statusCode,409); assert.equal(conflict.body.error,'upload-id-conflict'); assert.equal(f.starts,1); assert.equal(f.published.length,0);
  f.uploadTransfers.get('s1:u1').abort();
  fs.rmSync(temp,{recursive:true,force:true});
});

test('unexpected cloud finalization failures are contained and leave resumable staging available', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-cloud-finalize-')); const f=uploadFixture(temp,{deps:{applyReceptionAccountingState(){throw new Error('boom');}}}), share=fakeShare('inbox');
  const response=await sendChunk(f,share,{data:'abc',offset:0,size:3});
  assert.equal(response.statusCode,503); assert.equal(response.body.error,'write-error'); assert.equal(f.ended.length,1); assert.equal(f.ended[0].ok,false);
  assert.equal(fs.existsSync(path.join(temp,'s1-u1.part')),true);
  fs.rmSync(temp,{recursive:true,force:true});
});

test('cloud quota release tracks only bytes uploaded by this link, never pre-existing provider content', () => {
  const service={async stat(){},async list(){return[];},async exportFile(){},async mkdir(){},async remove(){},async metrics(){return{bytes:0,files:0};}};
  const shares=createWebStorageShareTools({storageConnectorService:service});
  const writable=createWebStorageWritableTools({storageConnectorService:service,shareMeta:shares.shareMeta,joinedPath:shares.joinedPath,stat:shares.stat});
  const share=fakeShare('collab'); share.bytesReceived=30;
  writable.trackPublished(share,'ours/a.bin',10); writable.trackPublished(share,'ours/sub/b.bin',20);
  assert.equal(writable.releaseTracked(share,'preexisting.bin'),0);
  assert.equal(writable.releaseTracked(share,'ours'),30);
  assert.equal(share.webStorageUploaded,undefined);
});

test('cloud received-file traversal is bounded by directories/depth and resists repeated directory cycles', async () => {
  let calls=0;
  const service={
    async stat(){}, async exportFile(){}, async mkdir(){}, async remove(){},
    async list(_meta,rel){ calls+=1; const n=Number((rel.match(/d(\d+)$/)||[])[1]||0); return [{name:`d${n+1}`,path:rel?`${rel}/d${n+1}`:`d${n+1}`,isDir:true,size:0,id:null}]; },
  };
  const shares=createWebStorageShareTools({storageConnectorService:service}); const result=await shares.walkFiles(fakeShare('inbox'),{maxFiles:50,maxDirs:3,maxDepth:20});
  assert.equal(calls,3); assert.equal(result.truncated,true); assert.equal(result.files.length,0);
});

test('cloud folder create/delete are serialized with upload finalization and delete frees only tracked bytes', () => {
  const deleteBlock=receptionRoutes.slice(receptionRoutes.indexOf("downloadRouter.post('/c/:token/delete'"),receptionRoutes.indexOf('// Creates one visitor-requested folder'));
  assert.match(deleteBlock,/withShareUploadLock\(s\.id/); assert.match(deleteBlock,/releaseTracked\(s,rel\)/); assert.doesNotMatch(deleteBlock,/bytesReceived[^\n]*metrics\.bytes/);
  const folderBlock=receptionRoutes.slice(receptionRoutes.indexOf('async function handleCreateUploadFolder'),receptionRoutes.indexOf("downloadRouter.post('/u/:token/folder'"));
  assert.match(folderBlock,/withShareUploadLock\(s\.id/);
});

test('configuration import cannot enable destructive collaboration without a password', () => {
  const block=server.slice(server.indexOf("adminRouter.post('/shares/import'"),server.indexOf("adminRouter.post('/shares/web-storage'"));
  assert.match(block,/rec\.type === 'collab'/); assert.match(block,/rec\.allowDelete === true && rec\.pwHash/); assert.match(block,/delete rec\.allowDelete/);
});

test('admin and PWA cloud received-file browsers use bounded walker instead of unbounded directory-only BFS', () => {
  assert.match(server,/webStorageWalkFiles\(s,\{maxFiles:5000,maxDirs:1000,maxDepth:24\}\)/);
  assert.equal(((server + '\n' + pwaRoutes).match(/webStorageWalkFiles\(s,\{maxFiles:5000,maxDirs:1000,maxDepth:24\}\)/g)||[]).length,2);
  assert.match(shareSource,/seen = new Set\(\[''\]\)/); assert.match(shareSource,/dirsVisited > maxDirs/);
});

test('local resumable protocol also rejects an in-progress upload id reused for different metadata', () => {
  const block=receptionRoutes.slice(receptionRoutes.indexOf('// One transfer per upload id, reused across every chunk request.'),receptionRoutes.indexOf('// --- Legacy single-shot path'));
  assert.match(block,/upload-id-conflict/); assert.match(block,/transfer\.expectedBytes/); assert.match(block,/transfer\.name/);
});

test('web writable factory validates inboxRejectStatus dependency and contains async finalize failures', () => {
  assert.match(writableSource,/['"]inboxRejectStatus['"]/); assert.match(writableSource,/finalize\([^\n]+\)\.catch/); assert.match(writableSource,/status\(503\)\.json\(\{ error:'write-error'/);
});

test('fresh negative cloud stat evicts stale metadata and cache identity includes frozen connector target', async () => {
  let mode='ok', calls=0;
  const service={
    async stat(meta,full){ calls+=1; if(mode==='missing')throw Object.assign(new Error('gone'),{code:'remote-not-found'}); return {name:'a',path:full,isDir:false,size:meta.remote==='cloud'?1:2,id:'x',modTime:'2026-08-18T00:00:00Z'}; },
    async list(){return[];},
  };
  const shares=createWebStorageShareTools({storageConnectorService:service,cacheMs:60000}), share=fakeShare('collab');
  assert.equal((await shares.stat(share,'a.txt')).size,1); assert.equal(calls,1);
  mode='missing'; await assert.rejects(shares.stat(share,'a.txt',{fresh:true}),/gone/); assert.equal(calls,2);
  await assert.rejects(shares.stat(share,'a.txt'),/gone/); assert.equal(calls,3);
  mode='ok'; share.webStorage.remote='cloud2'; assert.equal((await shares.stat(share,'a.txt')).size,2); assert.equal(calls,4);
});

test('successful cloud writes invalidate stat cache for the exact object or removed subtree', async () => {
  const invalidations=[];
  const service={async stat(){return null;},async list(){return[];},async exportFile(){return{ok:true};},async mkdir(){return{ok:true};},async remove(){return{ok:true};}};
  const shares=createWebStorageShareTools({storageConnectorService:service});
  const writable=createWebStorageWritableTools({storageConnectorService:service,shareMeta:shares.shareMeta,joinedPath:shares.joinedPath,stat:shares.stat,invalidate(_s,rel,recursive){invalidations.push([rel,recursive]);}});
  const share=fakeShare('collab');
  await writable.publishFile(share,__filename,'folder/a.txt'); await writable.mkdir(share,'folder/new'); await writable.remove(share,'folder',{isDir:true});
  assert.deepEqual(invalidations,[['folder/a.txt',false],['folder/new',false],['folder',true]]);
});

test('resumable cloud uploads reject missing, malformed, and unsafe-integer total sizes before staging', async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-cloud-size-')); const f=uploadFixture(temp), share=fakeShare('collab');
  async function request(query){ const req=Readable.from([Buffer.from('x')]); req.query=query; req.headers={'content-length':'1'}; const {res,done}=makeRes(); await f.handler(req,res,share); await done; return res; }
  assert.equal((await request({id:'u1',path:'a.txt',offset:'0'})).body.error,'invalid-size');
  assert.equal((await request({id:'u2',path:'a.txt',size:'12oops',offset:'0'})).body.error,'invalid-size');
  assert.equal((await request({id:'u3',path:'a.txt',size:'9007199254740992',offset:'0'})).body.error,'invalid-size');
  assert.equal(fs.readdirSync(temp).length,0); fs.rmSync(temp,{recursive:true,force:true});
});

test('imported cloud quota ledger is normalized, bounded by bytesReceived, and explicitly sanitized on import', () => {
  const service={async stat(){},async list(){return[];},async exportFile(){},async mkdir(){},async remove(){}};
  const shares=createWebStorageShareTools({storageConnectorService:service});
  const writable=createWebStorageWritableTools({storageConnectorService:service,shareMeta:shares.shareMeta,joinedPath:shares.joinedPath,stat:shares.stat});
  const share=fakeShare('collab'); share.bytesReceived=10; const ledger=Object.create(null); ledger['a.bin']=4; ledger['sub/b.bin']=6; ledger['../escape']=1; ledger['too-large.bin']=100; share.webStorageUploaded=ledger;
  assert.equal(writable.sanitizeTracked(share),10); assert.deepEqual(Object.keys(share.webStorageUploaded).sort(),['a.bin','sub/b.bin']);
  const block=server.slice(server.indexOf("adminRouter.post('/shares/import'"),server.indexOf("adminRouter.post('/shares/web-storage'"));
  assert.match(block,/webStorageWritable\.sanitizeTracked\(rec\)/); assert.match(block,/else delete rec\.webStorageUploaded/);
});

test('local resumable uploads also require a strict safe-integer declared total size', () => {
  const block=receptionRoutes.slice(receptionRoutes.indexOf('async function handleUpload(req, res)'),receptionRoutes.indexOf('// --- Legacy single-shot path'));
  assert.match(block,/safeUploadByteCount\(req\.query\.size\)/); assert.match(block,/id && declared === null/); assert.match(block,/error:'invalid-size'/);
});
