'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth;
let logs = '';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function waitForServer(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,60));}throw new Error(`server did not start\n${logs}`);}
function cookieFrom(r){const raw=r.headers.get('set-cookie')||'';const first=raw.split(';',1)[0];assert.match(first,/^[^=]+=.+$/);return first;}
async function body(r){return r.json().catch(()=>({}));}
async function adminFetch(url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}
async function createShare(name='Lifecycle searchable',file='/sample.txt',extra={}){let r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:file,color:'#336699',dlpOverride:true,...extra})});assert.equal(r.status,201,JSON.stringify(await body(r.clone())));let share=(await body(r)).share;r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,adminNote:'private lifecycle marker'})});assert.equal(r.status,200,JSON.stringify(await body(r.clone())));return (await body(r)).share;}
async function listed(id){const r=await adminFetch('/api/shares');assert.equal(r.status,200);return (await body(r)).shares.find(x=>x.id===id);}

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-151-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','sample.txt'),'Direct-Xfer lifecycle 1.51 integration\n');
  fs.writeFileSync(path.join(root,'host','gone.txt'),'temporary backing data\n');
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'global-admin',ADMIN_PASSWORD:'Global-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false',DLP_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{logs+=c.toString();}); child.stderr.on('data',c=>{logs+=c.toString();});
  await waitForServer(`${base}/api/meta`);
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'global-admin',password:'Global-test-2026!'})});
  assert.equal(login.status,200,JSON.stringify(await body(login.clone()))); const data=await body(login); auth={cookie:cookieFrom(login),csrf:data.csrf};
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('color/private note persist and duplicate keeps reusable metadata but gets a fresh token', async()=>{
  const s=await createShare('Colored lifecycle share');
  assert.equal(s.color,'#336699'); assert.equal(s.adminNote,'private lifecycle marker');
  const r=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/clone`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Colored lifecycle copy'})});
  assert.equal(r.status,201,JSON.stringify(await body(r.clone()))); const c=(await body(r)).share;
  assert.notEqual(c.id,s.id); assert.notEqual(c.token,s.token); assert.equal(c.name,'Colored lifecycle copy'); assert.equal(c.color,'#336699'); assert.equal(c.adminNote,'private lifecycle marker'); assert.equal(c.archived,false); assert.equal(c.revoked,false);
});

test('revoked one-time link reactivates only while its backing file exists', async()=>{
  const live=await createShare('Burn and reactivate','/sample.txt',{burnAfterDownload:true});
  const dl=await fetch(base+live.path+'/download'); assert.equal(dl.status,200); await dl.arrayBuffer();
  await new Promise(r=>setTimeout(r,50));
  let row=await listed(live.id); assert.ok(row&&row.revoked,'one-time link should be revoked after complete download');
  let r=await adminFetch(`/api/shares/${encodeURIComponent(live.id)}/reactivate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,200,JSON.stringify(await body(r.clone()))); row=(await body(r)).share; assert.equal(row.revoked,false); assert.equal(row.burnAfterDownload,true); assert.equal(row.downloadsUsed,1);

  const gone=await createShare('Missing backing data','/gone.txt',{burnAfterDownload:true});
  const goneDl=await fetch(base+gone.path+'/download'); assert.equal(goneDl.status,200); await goneDl.arrayBuffer(); await new Promise(r=>setTimeout(r,50));
  fs.unlinkSync(path.join(root,'host','gone.txt'));
  r=await adminFetch(`/api/shares/${encodeURIComponent(gone.id)}/reactivate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,409); assert.equal((await body(r)).error,'data-missing');
});

test('archive and global recoverable trash preserve the share lifecycle', async()=>{
  const s=await createShare('Archive then trash');
  let r=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})});
  assert.equal(r.status,200); assert.equal((await body(r)).share.archived,true);
  r=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}`,{method:'DELETE'}); assert.equal(r.status,200); const del=await body(r); assert.equal(del.recoverable,true); assert.ok(del.trashId);
  r=await adminFetch('/api/trash'); assert.equal(r.status,200); const trash=await body(r); assert.ok(trash.items.some(x=>x.id===del.trashId&&x.name==='Archive then trash'));
  r=await adminFetch(`/api/trash/${encodeURIComponent(del.trashId)}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); assert.equal(r.status,200,JSON.stringify(await body(r.clone())));
  const restored=(await body(r)).share; assert.equal(restored.name,'Archive then trash'); assert.equal(restored.archived,true);
});

test('global search finds links, the administrator account and audit/log activity by scope', async()=>{
  await createShare('Global needle link');
  let r=await adminFetch('/api/search?q='+encodeURIComponent('Global needle')+'&scope=links'); assert.equal(r.status,200); let data=await body(r);
  assert.ok(data.results.some(x=>x.scope==='link'&&x.shareName==='Global needle link'),JSON.stringify(data.results));
  r=await adminFetch('/api/search?q='+encodeURIComponent('global-admin')+'&scope=users'); assert.equal(r.status,200); data=await body(r);
  assert.ok(data.results.some(x=>x.scope==='user'&&x.username==='global-admin'),JSON.stringify(data.results));
  r=await adminFetch('/api/search?q='+encodeURIComponent('share-created')+'&scope=logs'); assert.equal(r.status,200); data=await body(r);
  assert.ok(data.results.some(x=>x.scope==='log'&&x.action==='share-created'),JSON.stringify(data.results));
  const serialized=JSON.stringify(data.results); assert.doesNotMatch(serialized,/Global-test-2026|pwHash|passwordHash|totpSecret/);
});
