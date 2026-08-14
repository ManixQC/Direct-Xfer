'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ADMIN_USER = 'notification-dedupe-owner';
const ADMIN_PASS = 'Notification-dedupe-2026!';
let root, child, logs = '';

function freePort() { return new Promise((resolve,reject)=>{ const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));}); }); }
async function wait(url) { const until=Date.now()+15000; while(Date.now()<until){ if(child&&child.exitCode!=null) throw new Error('server exited\n'+logs); try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){} await new Promise(r=>setTimeout(r,100)); } throw new Error('server timeout\n'+logs); }
function cookie(res){ const raw=res.headers.get('set-cookie')||''; const m=/([^=;,\s]+=[^;,]+)/.exec(raw); assert.ok(m,raw); return m[1]; }
async function body(res){ return res.json().catch(()=>({})); }
async function stop(){ if(!child||child.exitCode!=null)return; const c=child; c.kill('SIGTERM'); await Promise.race([new Promise(r=>c.once('exit',r)),new Promise(r=>setTimeout(r,2500))]); if(c.exitCode==null)c.kill('SIGKILL'); child=null; }
async function start(){ const port=await freePort(), base=`http://127.0.0.1:${port}`; logs=''; child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:ADMIN_USER,ADMIN_PASSWORD:ADMIN_PASS,DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base,TRUST_PROXY:'false'},stdio:['ignore','pipe','pipe']}); child.stdout.on('data',c=>logs+=c.toString()); child.stderr.on('data',c=>logs+=c.toString()); await wait(base+'/api/meta'); return base; }
async function login(base,user=ADMIN_USER,password=ADMIN_PASS){ const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password})}); assert.equal(r.status,200,logs); const d=await body(r); return {cookie:cookie(r),csrf:d.csrf}; }
function authHeaders(base,auth,json=true){ return {Cookie:auth.cookie,Origin:base,'X-CSRF-Token':auth.csrf,...(json?{'Content-Type':'application/json'}:{})}; }

async function readStore(){ const file=path.join(root,'data','shares.json'); const until=Date.now()+5000; while(Date.now()<until){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){} await new Promise(r=>setTimeout(r,50)); } throw new Error('store unreadable'); }

test('deleted recurring alerts stay dismissed across restart and account deletion purges notification data', async (t) => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-notification-dedupe-'));
  for(const n of ['data','host','inbox','images']) fs.mkdirSync(path.join(root,n),{recursive:true});
  t.after(async()=>{await stop();fs.rmSync(root,{recursive:true,force:true});});

  let base=await start();
  let owner=await login(base);
  let r=await fetch(base+'/api/notifications',{headers:{Cookie:owner.cookie},cache:'no-store'});
  assert.equal(r.status,200,logs);
  assert.match(r.headers.get('cache-control')||'',/no-store/i);
  let data=await body(r);
  const warning=data.notifications.find(n=>n.type==='system-problem'&&/TRUST_PROXY/i.test(n.detail||''));
  assert.ok(warning,JSON.stringify(data.notifications));

  r=await fetch(base+'/api/notifications/'+encodeURIComponent(warning.id),{method:'DELETE',headers:authHeaders(base,owner,false)});
  assert.equal(r.status,200,logs);
  data=await body(await fetch(base+'/api/notifications',{headers:{Cookie:owner.cookie},cache:'no-store'}));
  assert.equal(data.notifications.some(n=>n.id===warning.id),false);

  // Wait until the async delete is durable and the independent dedupe ledger is present.
  let store;
  const until=Date.now()+5000;
  while(Date.now()<until){ store=await readStore(); const rows=Object.values((store.meta&&store.meta.notificationDedupe)||{}); if(rows.some(x=>x&&x.dedupeKey==='system:reverse-proxy-trust') && !((store.meta&&store.meta.notifications)||[]).some(n=>n.id===warning.id)) break; await new Promise(r=>setTimeout(r,80)); }
  assert.ok(Object.values((store.meta&&store.meta.notificationDedupe)||{}).some(x=>x&&x.dedupeKey==='system:reverse-proxy-trust'));

  await stop();
  base=await start();
  owner=await login(base);
  data=await body(await fetch(base+'/api/notifications',{headers:{Cookie:owner.cookie},cache:'no-store'}));
  assert.equal(data.notifications.some(n=>n.type==='system-problem'&&/TRUST_PROXY/i.test(n.detail||'')),false,'dismissed health warning must not immediately reappear after restart');

  // Create a second account, let it receive a login notification, then delete it.
  r=await fetch(base+'/api/accounts',{method:'POST',headers:authHeaders(base,owner),body:JSON.stringify({username:'notification-child',password:'Child-notification-2026!',role:'admin'})});
  assert.equal(r.status,201,logs); const created=await body(r); const childId=created.account.id;
  const childAuth=await login(base,'notification-child','Child-notification-2026!');
  const childList=await body(await fetch(base+'/api/notifications',{headers:{Cookie:childAuth.cookie},cache:'no-store'}));
  assert.ok(childList.notifications.some(n=>n.type==='admin-login'));
  r=await fetch(base+'/api/accounts/'+encodeURIComponent(childId),{method:'DELETE',headers:authHeaders(base,owner,false)});
  assert.equal(r.status,200,logs);
  store=await readStore();
  assert.equal(((store.meta&&store.meta.notifications)||[]).some(n=>String(n.accountId)===String(childId)),false);
  assert.equal(Object.values((store.meta&&store.meta.notificationDedupe)||{}).some(n=>n&&String(n.accountId)===String(childId)),false);
});
