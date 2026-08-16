'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
let child, base, root, auth, logs='';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function wait(url){const end=Date.now()+15000;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url);if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,70));}throw new Error('server did not start\n'+logs);}
async function j(r){return r.json().catch(()=>({}));}
function cookieFrom(r){const raw=r.headers.get('set-cookie')||'';const m=raw.match(/(?:sid|dxsession)=[^;]+/);assert.ok(m,raw);return m[0];}
function ah(extra={}){return {Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,Origin:base,...extra};}
async function admin(url,opts={}){return fetch(base+url,{...opts,headers:ah(opts.headers||{})});}
function state(){return JSON.parse(fs.readFileSync(path.join(root,'data','shares.json'),'utf8'));}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64');
function variant(i){return Buffer.concat([PNG,Buffer.from(`dx1610-edit-${i}`)]);}
before(async()=>{const port=await freePort();base=`http://127.0.0.1:${port}`;root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1610-photo-audit-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'photoaudit',ADMIN_PASSWORD:'Photo-Audit-1610!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);await wait(base+'/api/meta');const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'photoaudit',password:'Photo-Audit-1610!'})});assert.equal(login.status,200,JSON.stringify(await j(login.clone())));const b=await j(login);auth={cookie:cookieFrom(login),csrf:b.csrf};});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('photo history retains the true original through >10 edits and restoring it restores its SHA-256',async()=>{
  let r=await admin('/api/photos/upload?name=original.png&dlpOverride=1',{method:'POST',headers:{'Content-Type':'image/png'},body:PNG});assert.equal(r.status,201,JSON.stringify(await j(r.clone())));const photo=(await j(r)).share;const originalSha=crypto.createHash('sha256').update(PNG).digest('hex');
  for(let i=0;i<12;i++){const buf=variant(i);r=await admin(`/api/photos/${photo.id}/replace?name=edit-${i}.png&dlpOverride=1`,{method:'POST',headers:{'Content-Type':'image/png'},body:buf});assert.equal(r.status,200,`replace ${i}: ${JSON.stringify(await j(r.clone()))}`);}
  r=await admin(`/api/photos/${photo.id}/versions`);assert.equal(r.status,200);const versions=await j(r);assert.equal(versions.versions.length,10,'history retention stays bounded at ten versions');const originals=versions.versions.filter(v=>v.original);assert.equal(originals.length,1,'exactly one retained version remains marked as the true original');
  const original=originals[0];r=await admin(`/api/photos/${photo.id}/versions/${original.id}/preview`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG,'original archive bytes stay intact after retention rotates');
  r=await admin(`/api/photos/${photo.id}/restore/${original.id}`,{method:'POST'});assert.equal(r.status,200,JSON.stringify(await j(r.clone())));
  const sh=state().shares.find(s=>s.id===photo.id);assert.equal(sh.contentSha256,originalSha,'restoring the original must restore its integrity hash, not the newer edit hash');
  r=await admin(`/api/photos/${photo.id}/preview`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),PNG,'active image bytes match the restored original');
});
