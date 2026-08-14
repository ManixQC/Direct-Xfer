'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, logs = '', auth;
const USER = 'visitor-owner';
const PASS = 'Visitor-owner-2026!';

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function wait(url){const end=Date.now()+15000;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error('server did not start\n'+logs);}
async function json(r){return r.json().catch(()=>({}));}
function sidCookie(r){const raw=r.headers.get('set-cookie')||'';const m=raw.match(/(?:^|,\s*)(sid=[^;]+)/);assert.ok(m,raw);return m[1];}
function publicDeviceCookie(r){const raw=r.headers.get('set-cookie')||'';const m=raw.match(/(?:^|,\s*)(dxpwaid=[a-f0-9]{24})/i);assert.ok(m,`missing dxpwaid marker in ${raw}`);return m[1];}
function adminHeaders(extra={}){return {Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,Origin:base,...extra};}
async function adminFetch(url,opts={}){return fetch(base+url,{...opts,headers:adminHeaders(opts.headers||{})});}

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-own-visitor-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','sample.txt'),'hello');
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',TRUST_PROXY:'1',ADMIN_USERNAME:USER,ADMIN_PASSWORD:PASS,DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c.toString());child.stderr.on('data',c=>logs+=c.toString());
  await wait(base+'/api/meta');
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:USER,password:PASS})});
  assert.equal(login.status,200,logs); const b=await json(login.clone()); auth={cookie:sidCookie(login),csrf:b.csrf};
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('own paired PWA visits do not emit a false new-visitor/device notification', async()=>{
  const register=await adminFetch('/app/device/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ma tablette'})});
  assert.equal(register.status,200,logs);
  const marker=publicDeviceCookie(register);

  const create=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sample.txt',name:'Test3',dlpOverride:true})});
  assert.equal(create.status,201,JSON.stringify(await json(create.clone()))); let share=(await json(create)).share;
  const rename=await adminFetch('/api/shares/'+encodeURIComponent(share.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test3'})});
  assert.equal(rename.status,200,JSON.stringify(await json(rename.clone()))); share=(await json(rename)).share||share;
  share.name='Test3';

  // Ignore login/pairing notifications and visit the public link as this paired device.
  let clear=await adminFetch('/api/notifications',{method:'DELETE'}); assert.equal(clear.status,200,logs);
  const own=await fetch(`${base}/s/${share.token}`,{headers:{Cookie:marker,'User-Agent':'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Safari/537.36','X-Forwarded-For':'198.51.100.10'}});
  assert.equal(own.status,200,logs); await own.text();
  let notes=(await json(await adminFetch('/api/notifications'))).notifications||[];
  assert.equal(notes.some(n=>n.token===share.token&&(n.type==='link-new-visitor'||n.type==='visitor-device-new')),false,JSON.stringify(notes));

  // A genuinely external visitor on another network still produces the notification.
  const external=await fetch(`${base}/s/${share.token}`,{headers:{'User-Agent':'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/139 Safari/537.36','X-Forwarded-For':'203.0.113.20'}});
  assert.equal(external.status,200,logs); await external.text();
  notes=(await json(await adminFetch('/api/notifications'))).notifications||[];
  const visitor=notes.find(n=>n.token===share.token&&n.type==='link-new-visitor');
  assert.ok(visitor,JSON.stringify(notes));
  assert.equal(visitor.name,'Test3','name remains the link name, not a visitor/device name');
  assert.match(visitor.device||'',/Chrome|Android|Web/);
});

test('notification wording explicitly says the value is the link name',()=>{
  const std=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  const pwa=fs.readFileSync(path.join(__dirname,'..','pwa','app.js'),'utf8');
  assert.match(std,/Nouveau visiteur sur « \$\{name\} »/);
  assert.match(std,/Nouveau navigateur\/appareil visiteur sur « \$\{name\} »/);
  assert.match(pwa,/Nouveau visiteur sur « '\+name\+' »/);
  assert.match(pwa,/Nouveau navigateur\/appareil visiteur sur « '\+name\+' »/);
});
