'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, tempRoot, logs = '';
const ADMIN_USER = 'paired-list-admin';
const ADMIN_PASS = 'Paired-list-test-2026!';

function freePort() { return new Promise((resolve,reject)=>{ const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(err=>err?reject(err):resolve(port));}); }); }
async function waitForServer(url) { const end=Date.now()+15000; while(Date.now()<end){ if(child&&child.exitCode!=null) throw new Error(`server exited early (${child.exitCode})\n${logs}`); try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){} await new Promise(r=>setTimeout(r,100)); } throw new Error(`server did not start\n${logs}`); }
function cookieFrom(response) { const raw=response.headers.get('set-cookie')||''; const match=raw.match(/(?:^|,\s*)(dxpwa=[^;]+)/); if(match) return match[1]; const first=raw.split(';',1)[0]; assert.match(first,/^[^=]+=.+$/); return first; }
async function body(response){ return response.json().catch(()=>({})); }

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-paired-list-'));
  for(const n of ['data','host','inbox','images']) fs.mkdirSync(path.join(tempRoot,n),{recursive:true});
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:ADMIN_USER,ADMIN_PASSWORD:ADMIN_PASS,DATA_DIR:path.join(tempRoot,'data'),HOST_ROOT:path.join(tempRoot,'host'),INBOX_DIR:path.join(tempRoot,'inbox'),IMAGES_DIR:path.join(tempRoot,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c.toString()); child.stderr.on('data',c=>logs+=c.toString());
  await waitForServer(`${base}/api/meta`);
});
after(async()=>{ if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode==null)child.kill('SIGKILL');} if(tempRoot)fs.rmSync(tempRoot,{recursive:true,force:true}); });

test('device-only status lists all devices paired to its account', async()=>{
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASS})});
  assert.equal(login.status,200); const adminCookie=(login.headers.get('set-cookie')||'').split(';',1)[0]; const admin=await body(login); assert.ok(admin.csrf);

  async function register(name){
    const r=await fetch(`${base}/app/device/register`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':admin.csrf,Cookie:adminCookie,Origin:base},body:JSON.stringify({name})});
    assert.equal(r.status,200,JSON.stringify(await body(r.clone()))); const data=await body(r); return {cookie:cookieFrom(r),id:data.device.id};
  }
  const phone=await register('Téléphone');
  const tablet=await register('Tablette');

  for (const current of [phone, tablet]) {
    const isPhone=current===phone;
    const statusUrl=`${base}/app/device/status?version=${encodeURIComponent('1.59.4')}&build=${encodeURIComponent('2026.08.14-pwa283')}`;
    const r=await fetch(statusUrl,{headers:{Cookie:current.cookie,'User-Agent':isPhone?'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36':'Mozilla/5.0 (Linux; Android 16; Tablet) AppleWebKit/537.36 Chrome/140 Safari/537.36'},cache:'no-store'});
    assert.equal(r.status,200); const status=await body(r);
    assert.equal(status.paired,true);
    assert.equal(status.adminSession,false,'device cookie alone must not be an admin session');
    assert.equal(status.devices.length,2,'paired-only PWA must receive every device of its account');
    assert.deepEqual(status.devices.map(d=>d.name).sort(),['Tablette','Téléphone']);
    assert.equal(status.devices.filter(d=>d.current).length,1);
    const currentDevice=status.devices.find(d=>d.current);
    assert.equal(currentDevice.id,current.id);
    assert.equal(currentDevice.platform,'android');
    assert.equal(currentDevice.appVersion,'1.59.4');
    assert.equal(currentDevice.appBuild,'2026.08.14-pwa283');
  }
});
