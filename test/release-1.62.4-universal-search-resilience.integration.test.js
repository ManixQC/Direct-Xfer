'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth, logs = '';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function waitForServer(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,60));}throw new Error(`server did not start\n${logs}`);}
function cookieFrom(r){const raw=r.headers.get('set-cookie')||'';const first=raw.split(';',1)[0];assert.match(first,/^[^=]+=.+$/);return first;}
async function json(r){return r.json().catch(()=>({}));}
async function adminFetch(url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-search-resilience-'));
  for(const d of ['data','host','inbox','images']) fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'data','shares.json'), JSON.stringify({
    version:1,
    shares:[],
    trash:[],
    settings:{},
    history:[{at:'legacy-not-a-date',name:'Legacy Search Marker',direction:'down',status:'ok',ip:'127.0.0.1'}],
    activityLog:[{at:'also-not-a-date',name:'Legacy Activity Marker',kind:'transfer',status:'ok'}],
    audit:[],
    meta:{},
    stats:{},
    ipNames:{},
    undoLog:[]
  },null,2));
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'search-admin',ADMIN_PASSWORD:'Search-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false',DLP_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{logs+=c.toString();}); child.stderr.on('data',c=>{logs+=c.toString();});
  await waitForServer(`${base}/api/meta`);
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'search-admin',password:'Search-test-2026!'})});
  assert.equal(login.status,200,JSON.stringify(await json(login.clone()))); const data=await json(login); auth={cookie:cookieFrom(login),csrf:data.csrf};
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('universal search survives invalid timestamps from a legacy persisted store', async()=>{
  let r=await adminFetch('/api/search?q='+encodeURIComponent('Legacy Search Marker')+'&scope=all');
  assert.equal(r.status,200,logs); let data=await json(r);
  assert.ok((data.results||[]).some(x=>x.scope==='log'&&x.shareName==='Legacy Search Marker'),JSON.stringify(data));
  assert.equal(data.degraded,false,JSON.stringify(data));

  r=await adminFetch('/api/search?q='+encodeURIComponent('search-admin')+'&scope=users');
  assert.equal(r.status,200,logs); data=await json(r);
  assert.ok((data.results||[]).some(x=>x.scope==='user'&&x.username==='search-admin'),JSON.stringify(data));
});
