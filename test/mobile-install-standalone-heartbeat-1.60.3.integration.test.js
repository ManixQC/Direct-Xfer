'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
function cookie(raw,name){const m=String(raw||'').match(new RegExp('(?:^|,\\s*)('+name+'=[^;]+)','i'));assert.ok(m,`missing ${name}: ${raw}`);return m[1];}
async function waitReady(base, child, logs){const end=Date.now()+15000;while(Date.now()<end){if(child.exitCode!==null)throw new Error('server exited\n'+logs());try{const r=await fetch(base+'/healthz');if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,80));}throw new Error('server timeout\n'+logs());}

test('standalone PWA heartbeat hides the standard install invitation through the public device marker', { timeout: 25000 }, async()=>{
  const port=await freePort(), base=`http://127.0.0.1:${port}`;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-install-heartbeat-'));
  let output='';
  const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',UPDATE_CHECK:'false',NO_COLOR:'1',DATA_DIR:path.join(tmp,'data'),HOST_ROOT:path.join(tmp,'host'),INBOX_DIR:path.join(tmp,'inbox'),IMAGES_DIR:path.join(tmp,'images'),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'Install-heartbeat-2026!',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b.toString()); child.stderr.on('data',b=>output+=b.toString());
  try {
    await waitReady(base,child,()=>output);
    let r=await fetch(base+'/pwa/install-state',{headers:{Accept:'application/json'}});
    assert.equal(r.status,200); assert.deepEqual(await r.json(),{installed:false});

    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'Install-heartbeat-2026!'})});
    assert.equal(login.status,200,output); const loginBody=await login.json(); const sid=cookie(login.headers.get('set-cookie'),'sid');
    const reg=await fetch(base+'/app/device/register',{method:'POST',headers:{Cookie:sid,'X-CSRF-Token':loginBody.csrf,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'Installed phone'})});
    assert.equal(reg.status,200,output); const set=reg.headers.get('set-cookie')||''; const dxpwa=cookie(set,'dxpwa'); const marker=cookie(set,'dxpwaid');

    r=await fetch(base+'/pwa/install-state',{headers:{Cookie:marker}});
    assert.deepEqual(await r.json(),{installed:false},'pairing alone must not pretend the PWA is installed');

    const status=await fetch(base+'/app/device/status?version=1.62.4&build=2026.08.16-pwa308&standalone=1',{headers:{Cookie:dxpwa,Accept:'application/json'}});
    assert.equal(status.status,200,output);
    r=await fetch(base+'/pwa/install-state',{headers:{Cookie:marker}});
    assert.deepEqual(await r.json(),{installed:true});
  } finally {
    if(child.exitCode===null) child.kill('SIGTERM');
    await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);
    if(child.exitCode===null) child.kill('SIGKILL');
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
