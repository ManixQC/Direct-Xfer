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
async function createInbox(config={}){const r=await admin('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Audit '+crypto.randomBytes(3).toString('hex'),...config})});assert.equal(r.status,201,JSON.stringify(await j(r.clone())));return (await j(r)).share;}
function sha(buf){return crypto.createHash('sha256').update(buf).digest('hex');}
async function upload(inbox,name,id,buf,{action='',expire=0,offset=0,sha256=sha(buf)}={}){const q=new URLSearchParams({name,id,size:String(buf.length),offset:String(offset),sha256});if(action)q.set('duplicate',action);if(expire)q.set('expire',String(expire));return fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?${q}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:offset>=buf.length?Buffer.alloc(0):buf.subarray(offset)});}
function state(){return JSON.parse(fs.readFileSync(path.join(root,'data','shares.json'),'utf8'));}
function shareState(id){return state().shares.find(s=>s.id===id);}
function storedPathFor(inbox,hash){const sh=shareState(inbox.id);const entry=sh.receivedHashes && sh.receivedHashes[hash];assert.ok(entry && typeof entry==='object' && entry.path,JSON.stringify(entry));return path.join(root,'inbox',entry.path);}
before(async()=>{const port=await freePort();base=`http://127.0.0.1:${port}`;root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1610-audit-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'audit1610',ADMIN_PASSWORD:'Audit-1610-test!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);await wait(base+'/api/meta');const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'audit1610',password:'Audit-1610-test!'})});assert.equal(login.status,200,JSON.stringify(await j(login.clone())));const b=await j(login);auth={cookie:cookieFrom(login),csrf:b.csrf};});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('Replace succeeds when maxFiles/maxTotalBytes are already reached and clears an old per-file expiry',async()=>{
  const buf=Buffer.from('quota replacement exact content 1610');
  const inbox=await createInbox({maxFiles:1,maxTotalBytes:buf.length,maxFilesPerSender:1,maxBytesPerSender:buf.length});
  let r=await upload(inbox,'quota.txt','quota-initial-1610',buf,{expire:3600});assert.equal(r.status,200,JSON.stringify(await j(r.clone())));let body=await j(r);assert.equal(body.filesReceived,1);assert.equal(body.bytesReceived,buf.length);
  const hash=sha(buf);const target=storedPathFor(inbox,hash);let st=state();assert.ok(st.meta.fileExpiry && st.meta.fileExpiry[target],JSON.stringify(st.meta.fileExpiry));
  r=await upload(inbox,'quota-replace.txt','quota-replace-1610',buf,{action:'replace'});assert.equal(r.status,200,JSON.stringify(await j(r.clone())));body=await j(r);assert.equal(body.replaced,true);assert.equal(body.filesReceived,1);assert.equal(body.bytesReceived,buf.length);
  st=state();assert.ok(!st.meta.fileExpiry || !st.meta.fileExpiry[target],'replacement without expire must clear prior self-destruct timer');
});

test('stale path-aware duplicate hash is pruned after the referenced file disappears',async()=>{
  const buf=Buffer.from('stale hash content 1610');const inbox=await createInbox({maxFiles:10});let r=await upload(inbox,'stale.txt','stale-first-1610',buf);assert.equal(r.status,200);const hash=sha(buf);const target=storedPathFor(inbox,hash);fs.unlinkSync(target);
  r=await fetch(`${base}/u/${inbox.token}/duplicate-check?sha256=${hash}`);assert.equal(r.status,200);const d=await j(r);assert.equal(d.duplicate,false,JSON.stringify(d));
  r=await upload(inbox,'stale-again.txt','stale-second-1610',buf);assert.equal(r.status,200,JSON.stringify(await j(r.clone())));assert.equal((await j(r)).filesReceived,2,'deleted physical file should not consume a duplicate slot forever');
});

test('a full-size .part without a receipt is finalized by a zero-byte retry instead of being treated as already complete',async()=>{
  const buf=Buffer.from('full partial needs finalization 1610');const inbox=await createInbox({maxFiles:10});const id='fullpart1610';const scoped=crypto.createHash('sha256').update(String(inbox.id)).update('\0').update(id).digest('hex');const parts=path.join(root,'data','staging','upload-parts');fs.mkdirSync(parts,{recursive:true});fs.writeFileSync(path.join(parts,scoped),buf);
  let r=await fetch(`${base}/u/${inbox.token}/upload-status?id=${id}`);assert.equal(r.status,200);let s=await j(r);assert.equal(s.offset,buf.length);assert.notEqual(s.complete,true);
  r=await upload(inbox,'part.txt',id,buf,{offset:buf.length});assert.equal(r.status,200,JSON.stringify(await j(r.clone())));const done=await j(r);assert.equal(done.complete,true);
  r=await fetch(`${base}/u/${inbox.token}/upload-status?id=${id}`);s=await j(r);assert.equal(s.complete,true);assert.equal(s.offset,buf.length);
});

test('rejectDuplicates does not allow Keep both, while an exact Replace remains allowed',async()=>{
  const buf=Buffer.from('duplicate policy content 1610');const inbox=await createInbox({rejectDuplicates:true,maxFiles:10});let r=await upload(inbox,'dup.txt','reject-first-1610',buf);assert.equal(r.status,200);
  r=await upload(inbox,'dup-keep.txt','reject-keep-1610',buf,{action:'keep'});assert.equal(r.status,409,JSON.stringify(await j(r.clone())));assert.equal((await j(r)).error,'duplicate');
  r=await upload(inbox,'dup-replace.txt','reject-replace-1610',buf,{action:'replace'});assert.equal(r.status,200,JSON.stringify(await j(r.clone())));assert.equal((await j(r)).replaced,true);
});
