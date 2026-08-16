'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth, logs='';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function waitForServer(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,70));}throw new Error(`server did not start\n${logs}`);}
function cookieFrom(r){const raw=r.headers.get('set-cookie')||'';return raw.split(';',1)[0];}
async function json(r){return r.json().catch(()=>({}));}
async function adminFetch(url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}
async function createShare(file,name){let r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:file,dlpOverride:true})});assert.equal(r.status,201,JSON.stringify(await json(r.clone())));let share=(await json(r)).share;if(name){r=await adminFetch('/api/shares/'+encodeURIComponent(share.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});assert.equal(r.status,200);share=(await json(r)).share;}return share;}
async function waitIndex(){await adminFetch('/api/search/reindex',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});for(let i=0;i<100;i++){const r=await adminFetch('/api/search/status');const d=await json(r);if(!d.building&&d.builtAt)return;await new Promise(r=>setTimeout(r,60));}throw new Error('index timeout');}

before(async()=>{
  const port=await freePort();base=`http://127.0.0.1:${port}`;root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-wave2-'));
  for(const d of ['data','host','host/sub','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','needle.txt'),'boring exact-name payload\n');
  fs.writeFileSync(path.join(root,'host','other.txt'),'needle.txt appears in content many times needle.txt needle.txt\n');
  fs.writeFileSync(path.join(root,'host','notify.txt'),'notification grouping payload\n');
  fs.writeFileSync(path.join(root,'host','sub','original.txt'),'relocatable payload\n');
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'wave2-admin',ADMIN_PASSWORD:'Wave2-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false',DLP_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c.toString());child.stderr.on('data',c=>logs+=c.toString());await waitForServer(base+'/api/meta');
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'wave2-admin',password:'Wave2-test-2026!'})});assert.equal(login.status,200,JSON.stringify(await json(login.clone())));const d=await json(login);auth={cookie:cookieFrom(login),csrf:d.csrf};
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('exact filename ranks ahead of content-only search matches', async()=>{
  await createShare('/needle.txt','Exact filename share');
  await createShare('/other.txt','Content match share');
  await waitIndex();
  const r=await adminFetch('/api/search?q='+encodeURIComponent('needle.txt')+'&scope=all');assert.equal(r.status,200);const d=await json(r);
  const content=d.results.filter(x=>x.scope==='content');assert.ok(content.length>=2,JSON.stringify(d.results));
  assert.equal(content[0].file,'needle.txt');assert.equal(content[0].filenameMatchRank,3);assert.equal(content[0].matchField,'filename');
});

test('repeated routine transfer notifications are grouped, become low priority, and deep-link to the share', async()=>{
  const share=await createShare('/notify.txt','Grouped notifications');
  for(let i=0;i<6;i++){const r=await fetch(base+share.path+'/download',{cache:'no-store'});assert.equal(r.status,200);await r.arrayBuffer();}
  await new Promise(r=>setTimeout(r,150));
  const nr=await adminFetch('/api/notifications');assert.equal(nr.status,200);const d=await json(nr);
  const n=d.notifications.find(x=>x.type==='transfer-complete'&&x.token===share.token);assert.ok(n,JSON.stringify(d.notifications));
  assert.ok(Number(n.groupCount)>=6,JSON.stringify(n));assert.equal(n.priority,'low');assert.match(n.manageUrl,new RegExp('focusShare='+share.id));
});

test('trash restore proposes a safe relocated backing file when the original path disappeared', async()=>{
  const share=await createShare('/sub/original.txt','Moved backing file');
  let r=await adminFetch('/api/shares/'+encodeURIComponent(share.id),{method:'DELETE'});assert.equal(r.status,200);const del=await json(r);assert.ok(del.trashId);
  fs.renameSync(path.join(root,'host','sub','original.txt'),path.join(root,'host','original.txt'));
  r=await adminFetch('/api/trash/'+encodeURIComponent(del.trashId)+'/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,409);const missing=await json(r);assert.equal(missing.error,'restore-location-missing');assert.ok(missing.assessment&&missing.assessment.alternatives&&missing.assessment.alternatives.length,JSON.stringify(missing));
  r=await adminFetch('/api/trash/'+encodeURIComponent(del.trashId)+'/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alternativePath:missing.assessment.alternatives[0]})});assert.equal(r.status,200,JSON.stringify(await json(r.clone())));
});
