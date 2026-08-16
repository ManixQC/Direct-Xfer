'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, logs = '';
const USER = 'live-audit-owner';
const PASS = 'Live-audit-2026!';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function wait(url){const end=Date.now()+15000;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(logs);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,75));}throw new Error(logs);}
async function json(r){return r.json().catch(()=>({}));}
function cookie(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function login(){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:USER,password:PASS})});assert.equal(r.status,200,logs);const d=await json(r);return {cookie:cookie(r),csrf:d.csrf};}
async function mutate(auth,url,body){return fetch(base+url,{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify(body||{})});}
async function live(auth){const r=await fetch(base+'/app/activity/transfers',{headers:{Cookie:auth.cookie},cache:'no-store'});return {status:r.status,body:await json(r)};}
async function waitLive(auth,pred,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const x=await live(auth);if(x.status===200){const hit=(x.body.transfers||[]).find(pred);if(hit)return hit;}await new Promise(r=>setTimeout(r,80));}return null;}

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-live-audit-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','resume.bin'),Buffer.alloc(4*1024*1024,3));
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:USER,ADMIN_PASSWORD:PASS,DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c.toString()); child.stderr.on('data',c=>logs+=c.toString()); await wait(base+'/api/meta');
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('managed resume/range download is visible live, stoppable, and not journaled as a fragment', async()=>{
  const auth=await login();
  const create=await mutate(auth,'/api/shares',{path:'resume.bin',dlpOverride:true,rateKBps:1024});
  assert.equal(create.status,201,JSON.stringify(await json(create.clone()))+logs);
  const share=(await json(create)).share; assert.ok(share&&share.token);
  const resumeId='0123456789abcdef0123456789abcdef';
  const first=await fetch(`${base}/s/${share.token}/download`,{headers:{Range:'bytes=0-524287','X-Direct-Xfer-Resume-Id':resumeId}});
  assert.equal(first.status,206,logs); await first.arrayBuffer();
  const histAfterFirst=await fetch(base+'/api/history',{headers:{Cookie:auth.cookie},cache:'no-store'}); assert.equal(histAfterFirst.status,200);
  assert.equal(((await json(histAfterFirst)).history||[]).filter(h=>h.name==='resume.bin').length,0,'first physical resume fragment must not be journaled');
  const ac=new AbortController();
  const dl=await fetch(`${base}/s/${share.token}/download`,{headers:{Range:'bytes=524288-4194303','X-Direct-Xfer-Resume-Id':resumeId},signal:ac.signal});
  assert.equal(dl.status,206,logs);
  const reader=dl.body.getReader(); await reader.read();
  try {
    const tf=await waitLive(auth,x=>x&&x.name==='resume.bin'&&x.resumed);
    assert.ok(tf,'resumed transfer should appear in PWA live feed');
    assert.equal(tf.resumed,true);
    assert.equal(tf.expectedBytes,4*1024*1024,'resumed progress should keep the logical file total');
    assert.ok(Number(tf.bytes)>=512*1024,'resumed progress should include bytes completed by earlier ranges');
    assert.equal(tf.canStop,true);
    assert.equal(tf.stoppable,true);
    const stop=await mutate(auth,'/app/activity/transfers/'+encodeURIComponent(tf.id)+'/stop',{});
    assert.equal(stop.status,200,JSON.stringify(await json(stop.clone())));
    const sb=await json(stop); assert.equal(sb.ok,true);
  } finally { ac.abort(); try{await reader.cancel();}catch(_){} }
  const goneEnd=Date.now()+4000; let gone=false; while(Date.now()<goneEnd){const x=await live(auth);if(!(x.body.transfers||[]).some(t=>t.name==='resume.bin')){gone=true;break;}await new Promise(r=>setTimeout(r,80));}
  assert.ok(gone,'stopped resumed fragment should leave the live feed');
  const hist=await fetch(base+'/api/history',{headers:{Cookie:auth.cookie},cache:'no-store'}); assert.equal(hist.status,200); const hb=await json(hist);
  assert.equal((hb.history||[]).filter(h=>h.name==='resume.bin').length,0,'physical resume fragment must not pollute history');
});


test('reception upload is visible live and PWA stop aborts it without leaving the active row', async()=>{
  const auth=await login();
  const create=await mutate(auth,'/api/inbox',{name:'Live upload audit'});
  assert.equal(create.status,201,JSON.stringify(await json(create.clone()))+logs);
  const inbox=(await json(create)).share; assert.ok(inbox&&inbox.token);
  const total=4*1024*1024;
  const uploadId='pwa-live-upload-audit-1630';
  const url=new URL(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=${encodeURIComponent('live-upload.bin')}&id=${encodeURIComponent(uploadId)}&size=${total}&offset=0`);
  let responseResolve;
  const responseP=new Promise((resolve)=>{responseResolve=resolve;});
  const req=http.request(url,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(total)}},(res)=>{
    let text=''; res.setEncoding('utf8'); res.on('data',(c)=>text+=c); res.on('end',()=>responseResolve({status:res.statusCode||0,text}));
  });
  req.on('error',(e)=>responseResolve({status:0,text:String(e&&e.message||e)}));
  req.write(Buffer.alloc(96*1024,7));
  const tf=await waitLive(auth,x=>x&&x.direction==='up'&&x.name==='live-upload.bin');
  assert.ok(tf,'active reception upload should appear in the PWA feed');
  assert.equal(tf.canStop,true); assert.equal(tf.stoppable,true); assert.ok(Number(tf.bytes)>0);
  const stop=await mutate(auth,'/app/activity/transfers/'+encodeURIComponent(tf.id)+'/stop',{});
  assert.equal(stop.status,200,JSON.stringify(await json(stop.clone())));
  const sb=await json(stop); assert.equal(sb.ok,true);
  try { req.end(); } catch (_) {}
  const response=await Promise.race([responseP,new Promise(r=>setTimeout(()=>r({status:-1,text:'timeout'}),3000))]);
  assert.notEqual(response.status,-1,'stopped upload request should settle');
  const goneEnd=Date.now()+3000; let gone=false; while(Date.now()<goneEnd){const x=await live(auth);if(!(x.body.transfers||[]).some(t=>t.id===tf.id)){gone=true;break;}await new Promise(r=>setTimeout(r,60));}
  assert.ok(gone,'stopped upload should leave the PWA live feed');
  const resume=await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=${encodeURIComponent('live-upload.bin')}&id=${encodeURIComponent(uploadId)}&size=${total}&offset=0`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(1)});
  assert.equal(resume.status,403,'a stopped resumable upload id must stay blocked from resuming');
  assert.equal((await json(resume)).error,'stopped');
});


test('PWA stop removes a resumable upload that is waiting after a network drop', async()=>{
  const auth=await login();
  const create=await mutate(auth,'/api/inbox',{name:'Dormant upload stop'});
  assert.equal(create.status,201,JSON.stringify(await json(create.clone()))+logs);
  const inbox=(await json(create)).share; assert.ok(inbox&&inbox.token);
  const total=2*1024*1024, uploadId='pwa-live-dormant-stop-1630';
  const url=new URL(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=${encodeURIComponent('dormant-upload.bin')}&id=${encodeURIComponent(uploadId)}&size=${total}&offset=0`);
  let settledResolve, responseInfo=null; const settled=new Promise(resolve=>{settledResolve=resolve;});
  const req=http.request(url,{method:'POST',agent:false,headers:{'Content-Type':'application/octet-stream','Content-Length':String(total)}},(res)=>{
    let text=''; res.setEncoding('utf8'); res.on('data',c=>text+=c); res.on('end',()=>{responseInfo={status:res.statusCode||0,text};settledResolve();});
  });
  req.on('error',(e)=>{responseInfo={status:0,text:String(e&&e.message||e)};settledResolve();});
  req.flushHeaders();
  await new Promise((resolve,reject)=>{req.once('error',reject);req.once('socket',(sock)=>{if(!sock.connecting)return resolve();sock.once('connect',resolve);sock.once('error',reject);});});
  req.write(Buffer.alloc(128*1024,9));
  const active=await waitLive(auth,x=>x&&x.direction==='up'&&x.name==='dormant-upload.bin');
  assert.ok(active,'upload should become visible before disconnect; response='+JSON.stringify(responseInfo)+'; logs='+logs.slice(-1200));
  req.destroy(); await Promise.race([settled,new Promise(r=>setTimeout(r,1000))]);
  const dormant=await waitLive(auth,x=>x&&x.id===active.id,1500);
  assert.ok(dormant,'interrupted resumable upload should stay available for resume/stop');
  const stop=await mutate(auth,'/app/activity/transfers/'+encodeURIComponent(active.id)+'/stop',{});
  assert.equal(stop.status,200,JSON.stringify(await json(stop.clone())));
  const end=Date.now()+2500; let gone=false; while(Date.now()<end){const x=await live(auth);if(!(x.body.transfers||[]).some(t=>t.id===active.id)){gone=true;break;}await new Promise(r=>setTimeout(r,60));}
  assert.ok(gone,'stop must remove the dormant live transfer immediately');
  const status=await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload-status?id=${encodeURIComponent(uploadId)}`,{cache:'no-store'});
  assert.equal(status.status,200); assert.equal((await json(status)).offset,0,'stopped partial must be deleted');
  const retry=await fetch(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.alloc(1)});
  assert.equal(retry.status,403); assert.equal((await json(retry)).error,'stopped');
});

test('PWA stop mutation requires CSRF even for an authenticated session', async()=>{
  const auth=await login();
  const r=await fetch(base+'/app/activity/transfers/does-not-exist/stop',{method:'POST',headers:{Cookie:auth.cookie,Origin:base,'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,403); const b=await json(r); assert.equal(b.error,'invalid-csrf');
});

test('anonymous live feed is rejected', async()=>{const r=await fetch(base+'/app/activity/transfers',{cache:'no-store'});assert.equal(r.status,401);});
