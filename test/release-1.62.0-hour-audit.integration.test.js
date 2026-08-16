'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
let child, base, root, owner, operator, auditor, logs='';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function wait(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,60));}throw new Error(logs);}
function cookieFrom(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function json(r){return r.json().catch(()=>({}));}
async function login(username,password,ua='Audit Browser'){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':ua},body:JSON.stringify({username,password})});assert.equal(r.status,200,JSON.stringify(await json(r.clone())));const d=await json(r);return {cookie:cookieFrom(r),csrf:d.csrf};}
async function af(auth,url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}
async function createAccount(username, role){const password='Audit-role-2026!';const r=await af(owner,'/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,role})});assert.equal(r.status,201,JSON.stringify(await json(r.clone())));return login(username,password,`Audit ${role}`);}
function openSse(cookie){return new Promise((resolve,reject)=>{const u=new URL(base+'/app/events');const req=http.get({hostname:u.hostname,port:u.port,path:u.pathname,headers:{Cookie:cookie,Accept:'text/event-stream'}},res=>{let settled=false;const closed=new Promise(done=>{res.on('end',done);res.on('close',done);});res.once('data',()=>{settled=true;resolve({req,res,closed});});res.once('error',reject);setTimeout(()=>{if(!settled)reject(new Error('SSE did not open'));},2500);});req.once('error',reject);});}
before(async()=>{const port=await freePort();base=`http://127.0.0.1:${port}`;root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-hour-audit-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});fs.writeFileSync(path.join(root,'host','cap.txt'),'visitor cap');child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'hour-owner',ADMIN_PASSWORD:'Hour-audit-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);await wait(base+'/api/meta');owner=await login('hour-owner','Hour-audit-2026!','Owner Browser');operator=await createAccount('hour-operator','operator');auditor=await createAccount('hour-auditor','auditor');});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('operator cannot read global network/DLP security surfaces while auditor remains read-only',async()=>{
  for(const url of ['/api/network','/api/network/proxy-check','/api/dlp/quarantine']){let r=await af(operator,url);assert.equal(r.status,403,`${url} operator`);r=await af(auditor,url);assert.equal(r.status,200,`${url} auditor`);}
  let r=await af(operator,'/api/dlp/quarantine/not-there',{method:'DELETE'});assert.equal(r.status,403);
  r=await af(auditor,'/api/dlp/quarantine/not-there',{method:'DELETE'});assert.equal(r.status,403);
  r=await af(owner,'/api/dlp/quarantine/not-there',{method:'DELETE'});assert.equal(r.status,404);
});

test('session-only PWA event stream closes immediately on logout',async()=>{
  const fresh=await login('hour-owner','Hour-audit-2026!','SSE Browser');
  const stream=await openSse(fresh.cookie);
  const r=await af(fresh,'/api/logout',{method:'POST'});assert.equal(r.status,200);
  await Promise.race([stream.closed,new Promise((_,rej)=>setTimeout(()=>rej(new Error('SSE stayed open after logout')),1500))]);
});

test('visitor caps larger than the persisted visitor store are safely clamped',async()=>{
  let r=await af(owner,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/cap.txt',maxVisitors:999999})});assert.equal(r.status,201,JSON.stringify(await json(r.clone())));let d=await json(r);assert.equal(d.share.maxVisitors,20000,JSON.stringify(d.share));
  r=await af(owner,'/api/shares/'+encodeURIComponent(d.share.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxVisitors:500000})});assert.equal(r.status,200,JSON.stringify(await json(r.clone())));d=await json(r);assert.equal(d.share.maxVisitors,20000,JSON.stringify(d.share));
});
