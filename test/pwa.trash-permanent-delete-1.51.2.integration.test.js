'use strict';
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, tempRoot, logs = '';
const ADMIN_USER = 'trash-admin';
const ADMIN_PASS = 'Trash-test-2026!';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const PNG_ALT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==', 'base64');

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function waitForServer(url,timeoutMs=15000){const end=Date.now()+timeoutMs;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited early (${child.exitCode})\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error(`server did not start\n${logs}`);}
function cookieFrom(response){const raw=response.headers.get('set-cookie')||'';const match=raw.match(/(?:^|,\s*)(dxpwa=[^;]+)/);if(match)return match[1];const first=raw.split(';',1)[0];assert.match(first,/^[^=]+=.+$/);return first;}
const json=r=>r.json().catch(()=>({}));
let deviceCookie, deviceCsrf;

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-trash1512-'));
  for(const n of ['data','host','inbox','images'])fs.mkdirSync(path.join(tempRoot,n),{recursive:true});
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:ADMIN_USER,ADMIN_PASSWORD:ADMIN_PASS,DATA_DIR:path.join(tempRoot,'data'),HOST_ROOT:path.join(tempRoot,'host'),INBOX_DIR:path.join(tempRoot,'inbox'),IMAGES_DIR:path.join(tempRoot,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{logs+=c});child.stderr.on('data',c=>{logs+=c});await waitForServer(`${base}/api/meta`);
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASS})});
  assert.equal(login.status,200,JSON.stringify(await json(login.clone())));const sessionCookie=cookieFrom(login);const sessionCsrf=(await json(login)).csrf;
  const register=await fetch(`${base}/app/device/register`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':sessionCsrf,Cookie:sessionCookie,Origin:base},body:JSON.stringify({name:'Trash tablet'})});
  assert.equal(register.status,200,JSON.stringify(await json(register.clone())));deviceCookie=cookieFrom(register);
  const status=await json(await fetch(`${base}/app/device/status`,{headers:{Cookie:deviceCookie},cache:'no-store'}));deviceCsrf=status.csrf;assert.ok(deviceCsrf);
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(tempRoot)fs.rmSync(tempRoot,{recursive:true,force:true});});

async function uploadAndTrash(name){
  const up=await fetch(`${base}/app/image?name=${encodeURIComponent(name)}&dlpOverride=1`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:name === 'three.png' ? PNG_ALT : PNG});
  assert.equal(up.status,201,JSON.stringify(await json(up.clone())));const photo=await json(up);assert.ok(photo.token);
  const rev=await fetch(`${base}/app/share/${encodeURIComponent(photo.token)}/revoke`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:'{}'});
  assert.equal(rev.status,200,JSON.stringify(await json(rev.clone())));const d=await json(rev);assert.ok(d.trashId);return {photo,trashId:d.trashId};
}
function pwaDelete(url){return fetch(base+url,{method:'DELETE',headers:{'X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base}});}

test('paired admin PWA can permanently delete one trash item and it cannot be restored',async()=>{
  const one=await uploadAndTrash('one.png');
  let trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));assert.equal(trash.canPurge,true);assert.ok(trash.items.some(x=>x.id===one.trashId));
  const del=await pwaDelete(`/app/trash/${encodeURIComponent(one.trashId)}`);assert.equal(del.status,200,JSON.stringify(await json(del.clone())));
  trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));assert.equal(trash.items.some(x=>x.id===one.trashId),false);
  const restore=await fetch(`${base}/app/trash/${encodeURIComponent(one.trashId)}/restore`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':deviceCsrf,Cookie:deviceCookie,Origin:base},body:'{}'});assert.equal(restore.status,404);
});

test('paired admin PWA can permanently delete every visible trash item',async()=>{
  await uploadAndTrash('two.png');await uploadAndTrash('three.png');
  let trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));assert.equal(trash.items.length,2);
  const del=await pwaDelete('/app/trash');assert.equal(del.status,200,JSON.stringify(await json(del.clone())));const result=await json(del);assert.equal(result.count,2);assert.equal(result.failed,0);
  trash=await json(await fetch(`${base}/app/trash`,{headers:{Cookie:deviceCookie},cache:'no-store'}));assert.equal(trash.items.length,0);
});
