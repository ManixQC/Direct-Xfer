'use strict';
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, tempRoot, logs = '';
const ADMIN_USER = 'undo-pwa-admin';
const ADMIN_PASS = 'Undo-PWA-2026!';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
let deviceCookie, deviceCsrf, sessionCookie, sessionCsrf;

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function waitForServer(url,timeoutMs=15000){const end=Date.now()+timeoutMs;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited early (${child.exitCode})\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error(`server did not start\n${logs}`);}
function cookieFrom(response){const raw=response.headers.get('set-cookie')||'';const match=raw.match(/(?:^|,\s*)(dxpwa=[^;]+)/);if(match)return match[1];const first=raw.split(';',1)[0];assert.match(first,/^[^=]+=.+$/);return first;}
const json=r=>r.json().catch(()=>({}));

before(async()=>{
  const port=await freePort();base=`http://127.0.0.1:${port}`;
  tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-pwa-undo-'));
  for(const n of ['data','host','inbox','images'])fs.mkdirSync(path.join(tempRoot,n),{recursive:true});
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:ADMIN_USER,ADMIN_PASSWORD:ADMIN_PASS,DATA_DIR:path.join(tempRoot,'data'),HOST_ROOT:path.join(tempRoot,'host'),INBOX_DIR:path.join(tempRoot,'inbox'),IMAGES_DIR:path.join(tempRoot,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{logs+=c});child.stderr.on('data',c=>{logs+=c});await waitForServer(`${base}/api/meta`);
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASS})});
  assert.equal(login.status,200,JSON.stringify(await json(login.clone())));sessionCookie=cookieFrom(login);sessionCsrf=(await json(login)).csrf;
  const register=await fetch(`${base}/app/device/register`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':sessionCsrf,Cookie:sessionCookie,Origin:base},body:JSON.stringify({name:'Undo tablet'})});
  assert.equal(register.status,200,JSON.stringify(await json(register.clone())));deviceCookie=cookieFrom(register);
  const status=await json(await fetch(`${base}/app/device/status`,{headers:{Cookie:deviceCookie},cache:'no-store'}));deviceCsrf=status.csrf;assert.ok(deviceCsrf);
});

after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(tempRoot)fs.rmSync(tempRoot,{recursive:true,force:true});});

async function uploadAndRevoke(name){
  const up=await fetch(`${base}/app/image?name=${encodeURIComponent(name)}&dlpOverride=1&duplicateOverride=1`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:PNG});
  assert.equal(up.status,201,JSON.stringify(await json(up.clone())));const photo=await json(up);assert.ok(photo.token);
  const rev=await fetch(`${base}/app/share/${encodeURIComponent(photo.token)}/revoke`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:'{}'});
  assert.equal(rev.status,200,JSON.stringify(await json(rev.clone())));const revoked=await json(rev);assert.ok(revoked.trashId);
  return {photo,trashId:revoked.trashId};
}
async function history(){const r=await fetch(`${base}/app/undo`,{headers:{Cookie:deviceCookie},cache:'no-store'});assert.equal(r.status,200);return (await json(r)).items||[];}
async function postUndo(id){return fetch(`${base}/app/undo/${encodeURIComponent(id)}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:'{}'});}



test('PWA image revocation appears in the persistent server Activity feed',async()=>{
  const item=await uploadAndRevoke('pwa-activity-delete.png');
  const response=await fetch(`${base}/app/activity/recent?limit=100`,{headers:{Cookie:deviceCookie},cache:'no-store'});
  assert.equal(response.status,200,JSON.stringify(await json(response.clone())));
  const body=await json(response);
  const event=(body.events||[]).find((e)=>e.kind==='trash'&&e.status==='deleted'&&e.name==='pwa-activity-delete.png');
  assert.ok(event,'the PWA must receive the server-side image deletion activity');
  const trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));
  const trashed=(trash.items||[]).find((row)=>row.id===item.trashId);
  assert.ok(trashed&&trashed.shareId,'the revoked image must be present in PWA trash');
  assert.equal(event.shareId,trashed.shareId);
  assert.equal(event.detail,'photo');

  const purge=await fetch(`${base}/app/trash/${encodeURIComponent(item.trashId)}`,{method:'DELETE',headers:{'X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base}});
  assert.equal(purge.status,200,JSON.stringify(await json(purge.clone())));
  const afterPurge=await json(await fetch(`${base}/app/activity/recent?limit=100`,{headers:{Cookie:deviceCookie},cache:'no-store'}));
  const purged=(afterPurge.events||[]).find((e)=>e.kind==='trash'&&e.status==='purged'&&e.name==='pwa-activity-delete.png');
  assert.ok(purged,'permanent PWA image deletion must remain visible after the share leaves trash');
  assert.equal(purged.shareId,trashed.shareId);
});

test('a PWA revocation appears in unified action history and can be undone from the PWA',async()=>{
  const item=await uploadAndRevoke('pwa-undo-one.png');
  const entry=(await history()).find(e=>e.type==='share-trashed'&&String(e.label||'').includes('pwa-undo-one.png'));
  assert.ok(entry,'revocation must be present in PWA action history');assert.equal(entry.undone,false);assert.equal(entry.canUndo,true);
  const onDisk=JSON.parse(fs.readFileSync(path.join(tempRoot,'data','shares.json'),'utf8'));assert.ok((onDisk.undoLog||[]).some(e=>e.id===entry.id),'PWA revocation and Undo history persist atomically');
  const undo=await postUndo(entry.id);assert.equal(undo.status,200,JSON.stringify(await json(undo.clone())));
  const trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));
  assert.equal(trash.items.some(x=>x.id===item.trashId),false,'undo restores the item out of trash');
  const after=(await history()).find(e=>e.id===entry.id);assert.ok(after&&after.undone);assert.equal(after.canUndo,false);
});




test('PWA bulk image revocation records each image in the unified Undo journal',async()=>{
  async function upload(name){
    const up=await fetch(`${base}/app/image?name=${encodeURIComponent(name)}&dlpOverride=1&duplicateOverride=1`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:PNG});
    assert.equal(up.status,201,JSON.stringify(await json(up.clone())));return json(up);
  }
  const a=await upload('bulk-undo-a.png'),b=await upload('bulk-undo-b.png');
  const bulk=await fetch(`${base}/app/images/bulk`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:JSON.stringify({tokens:[a.token,b.token],action:'revoke'})});
  assert.equal(bulk.status,200,JSON.stringify(await json(bulk.clone())));assert.equal((await json(bulk)).count,2);
  const activity=await json(await fetch(`${base}/app/activity/recent?limit=100`,{headers:{Cookie:deviceCookie},cache:'no-store'}));
  for(const photo of [a,b]) assert.ok((activity.events||[]).some((e)=>e.kind==='trash'&&e.status==='deleted'&&e.name===photo.name),'bulk revoke must publish each deleted image to PWA Activity');
  const items=await history();
  const entries=[a,b].map((photo)=>items.find((e)=>e.type==='share-trashed'&&String(e.label||'').includes(photo.name)));
  assert.ok(entries.every((e)=>e&&e.canUndo),'each PWA bulk revocation is independently undoable');
  for(const e of entries) assert.equal((await postUndo(e.id)).status,200);
});

test('a bare paired PWA device can inspect admin history without inheriting settings Undo capability',async()=>{
  const changed=await fetch(`${base}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':sessionCsrf,Cookie:sessionCookie,Origin:base},body:JSON.stringify({announcement:'ADMIN-ONLY-UNDO'})});
  assert.equal(changed.status,200,JSON.stringify(await json(changed.clone())));
  const adminHistory=await json(await fetch(`${base}/api/undo`,{headers:{Cookie:sessionCookie},cache:'no-store'}));
  const settingsEntry=(adminHistory.items||[]).find(e=>e.type==='settings-changed'&&String(e.label||'').includes('announcement'));
  assert.ok(settingsEntry,'admin settings action is present in the admin history');
  const deviceEntry=(await history()).find(e=>e.id===settingsEntry.id);
  assert.ok(deviceEntry,'paired owner device may inspect the unified history');
  assert.equal(deviceEntry.canUndo,false,'settings rollback is not delegated to a bare device cookie');
  assert.equal(deviceEntry.unavailableReason,'forbidden');
  const denied=await postUndo(settingsEntry.id);
  assert.equal(denied.status,403,'settings Undo is not executable through the paired-device capability');
  const settings=await json(await fetch(`${base}/api/settings`,{headers:{Cookie:sessionCookie},cache:'no-store'}));
  assert.equal(settings.announcement,'ADMIN-ONLY-UNDO');
});

test('a purged target remains visible but is reported as no longer undoable',async()=>{
  const item=await uploadAndRevoke('pwa-undo-purged.png');
  let entry=(await history()).find(e=>e.type==='share-trashed'&&String(e.label||'').includes('pwa-undo-purged.png'));
  assert.ok(entry&&entry.canUndo);
  const del=await fetch(`${base}/app/trash/${encodeURIComponent(item.trashId)}`,{method:'DELETE',headers:{'X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base}});assert.equal(del.status,200,JSON.stringify(await json(del.clone())));
  entry=(await history()).find(e=>e.id===entry.id);assert.ok(entry);assert.equal(entry.undone,false);assert.equal(entry.canUndo,false);assert.equal(entry.unavailableReason,'already-purged');
  const undo=await postUndo(entry.id);assert.equal(undo.status,410);
});

test('a paired device cannot execute another paired device\'s Undo entry without an admin session',async()=>{
  const item=await uploadAndRevoke('pwa-undo-device-scope.png');
  const entry=(await history()).find(e=>e.type==='share-trashed'&&String(e.label||'').includes('pwa-undo-device-scope.png'));
  assert.ok(entry&&entry.canUndo,'originating device owns the Undo capability');

  const register=await fetch(`${base}/app/device/register`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':sessionCsrf,Cookie:sessionCookie,Origin:base},body:JSON.stringify({name:'Other undo tablet'})});
  assert.equal(register.status,200,JSON.stringify(await json(register.clone())));
  const otherCookie=cookieFrom(register);
  const otherStatus=await json(await fetch(`${base}/app/device/status`,{headers:{Cookie:otherCookie},cache:'no-store'}));
  assert.ok(otherStatus.csrf);

  const otherHistoryResponse=await fetch(`${base}/app/undo`,{headers:{Cookie:otherCookie},cache:'no-store'});
  assert.equal(otherHistoryResponse.status,200);
  const otherEntry=((await json(otherHistoryResponse)).items||[]).find(e=>e.id===entry.id);
  assert.ok(otherEntry,'owner devices may inspect unified history');
  assert.equal(otherEntry.canUndo,false);
  assert.equal(otherEntry.unavailableReason,'forbidden');

  const denied=await fetch(`${base}/app/undo/${encodeURIComponent(entry.id)}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':otherStatus.csrf,Cookie:otherCookie,Origin:base},body:'{}'});
  assert.equal(denied.status,403,'device bearer capability must not cross device boundaries');

  const undo=await postUndo(entry.id);
  assert.equal(undo.status,200,JSON.stringify(await json(undo.clone())));
  const trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));
  assert.equal(trash.items.some(x=>x.id===item.trashId),false);
});

test('owner paired PWA Activity returns the same journal entries as standard admin Activity', async()=>{
  const changed=await fetch(`${base}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':sessionCsrf,Cookie:sessionCookie,Origin:base},body:JSON.stringify({announcement:'ACTIVITY-PARITY-1534'})});
  assert.equal(changed.status,200,JSON.stringify(await json(changed.clone())));
  const standardResponse=await fetch(`${base}/api/activity/recent?limit=1000`,{headers:{Cookie:sessionCookie},cache:'no-store'});
  const pwaResponse=await fetch(`${base}/app/activity/recent?limit=1000`,{headers:{Cookie:deviceCookie},cache:'no-store'});
  assert.equal(standardResponse.status,200); assert.equal(pwaResponse.status,200);
  const standard=await json(standardResponse), mobile=await json(pwaResponse);
  assert.equal(mobile.retained,standard.retained,'owner/admin PWA must retain the same Activity count as standard');
  assert.deepEqual((mobile.events||[]).map(e=>e.id),(standard.events||[]).map(e=>e.id),'owner/admin PWA must receive the same ordered Activity event IDs');
});
