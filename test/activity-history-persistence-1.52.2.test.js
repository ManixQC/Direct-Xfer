'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function wait(url, child, logs){const until=Date.now()+15000;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited\n'+logs());try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,80));}throw new Error('server timeout\n'+logs());}
function cookieFrom(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function stop(child){if(!child||child.exitCode!=null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}

async function boot(root, port){
  let out=''; const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'activity-owner',ADMIN_PASSWORD:'Activity-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>out+=c); child.stderr.on('data',c=>out+=c);
  await wait(base+'/api/meta',child,()=>out);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'activity-owner',password:'Activity-test-2026!'})});
  assert.equal(login.status,200,out); const data=await login.json();
  return {child,base,auth:{cookie:cookieFrom(login),csrf:data.csrf},logs:()=>out};
}
async function admin(ctx,url,opts={}){const headers={Cookie:ctx.auth.cookie,Origin:ctx.base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=ctx.auth.csrf;return fetch(ctx.base+url,{...opts,headers});}

test('server activity history is durable and includes newly covered relevant actions', async (t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-activity-history-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','a.txt'),'activity history\n');
  let ctx=null;
  t.after(async()=>{if(ctx)await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});
  const port=await freePort(); ctx=await boot(root,port);

  let r=await admin(ctx,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/a.txt',dlpOverride:true})});
  assert.equal(r.status,201,ctx.logs()); const share=(await r.json()).share;
  r=await admin(ctx,'/api/notifications/prefs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mutedCategories:['visitors']})});
  assert.equal(r.status,200,ctx.logs());
  await fetch(ctx.base+share.path+'/download').then(x=>x.arrayBuffer());
  await new Promise(r=>setTimeout(r,500));

  r=await admin(ctx,'/api/activity/recent?limit=1000'); assert.equal(r.status,200,ctx.logs());
  let data=await r.json();
  assert.ok(data.retained>=3,JSON.stringify(data));
  assert.ok(data.events.some(e=>e.kind==='audit'&&e.name==='share-created'),JSON.stringify(data.events.slice(0,20)));
  assert.ok(data.events.some(e=>e.kind==='audit'&&e.name==='notification-prefs-changed'),JSON.stringify(data.events.slice(0,20)));
  assert.ok(data.events.some(e=>e.kind==='transfer-complete'&&e.shareId===share.id),JSON.stringify(data.events.slice(0,20)));

  const beforeIds=new Set(data.events.map(e=>e.id));
  await stop(ctx.child); ctx=await boot(root,port);
  r=await admin(ctx,'/api/activity/recent?limit=1000'); assert.equal(r.status,200,ctx.logs()); data=await r.json();
  assert.ok([...beforeIds].some(id=>data.events.some(e=>e.id===id)),'pre-restart activity must survive restart');
  assert.ok(data.max>=2000);

  // 1.54.0 keeps push subscription bookkeeping in the security audit but removes
  // it from the user-facing Activity history, including persisted rows written by
  // older releases. Inject one old row and verify the next boot sanitizes it.
  await stop(ctx.child);
  const activityStoreFile=path.join(root,'data','shares.json');
  const activityStore=JSON.parse(fs.readFileSync(activityStoreFile,'utf8'));
  activityStore.activityLog=Array.isArray(activityStore.activityLog)?activityStore.activityLog:[];
  activityStore.activityLog.unshift({id:'old-push-sub',at:Date.now(),kind:'audit',name:'push-subscribed',status:'push-subscribed',detail:'legacy automatic refresh'});
  fs.writeFileSync(activityStoreFile,JSON.stringify(activityStore,null,2));
  ctx=await boot(root,port);
  r=await admin(ctx,'/api/activity/recent?limit=1000'); assert.equal(r.status,200,ctx.logs()); data=await r.json();
  assert.equal(data.events.some(e=>e.name==='push-subscribed'||e.status==='push-subscribed'),false,'push-subscribed must be absent from Activity after migration');

  // Simulate upgrading a legacy shares.json that predates activityLog: the next
  // boot must seed history from its existing audit + transfer history instead of
  // presenting an empty activity screen.
  await stop(ctx.child);
  const storeFile=path.join(root,'data','shares.json');
  const store=JSON.parse(fs.readFileSync(storeFile,'utf8')); delete store.activityLog;
  fs.writeFileSync(storeFile,JSON.stringify(store,null,2));
  ctx=await boot(root,port);
  r=await admin(ctx,'/api/activity/recent?limit=1000'); assert.equal(r.status,200,ctx.logs()); data=await r.json();
  assert.ok(data.events.some(e=>e.kind==='audit'&&e.name==='share-created'),'legacy audit rows must seed activity history');
  assert.ok(data.events.some(e=>e.kind==='transfer-complete'&&e.shareId===share.id),'legacy transfer rows must seed activity history');
});

test('activity history implementation covers PWA/admin gaps without logging low-value read housekeeping', ()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  assert.match(src,/activityLog: sanitizeActivityLog\(parsed\.activityLog\)/);
  assert.match(src,/activityLog: sanitizeActivityLog\(p\.activityLog\)/);
  assert.match(src,/notification-rule-created/);
  assert.match(src,/transfer-stopped/);
  assert.match(src,/album-invitation-created/);
  assert.match(src,/image-version-restored/);
  assert.match(src,/image-retention-rules-changed/);
  assert.match(src,/reception-thread-reply/);
  assert.match(src,/emitLiveActivity\('visitor',[\s\S]{0,220}?access-request/);
  assert.match(app,/Historique d’activité/);
  assert.doesNotMatch(src,/notifications\/read'[\s\S]{0,220}?auditReq\(/);
});
