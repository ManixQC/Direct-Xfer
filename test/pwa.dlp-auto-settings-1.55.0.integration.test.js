'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function wait(url,child,logs){const until=Date.now()+15000;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited\n'+logs());try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,70));}throw new Error('timeout\n'+logs());}
async function stop(child){if(!child||child.exitCode!=null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}
function firstCookie(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
function namedCookie(r,name){const raw=r.headers.get('set-cookie')||'';const m=new RegExp('(?:^|,\\s*)'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;,]+)').exec(raw);return m?name+'='+m[1]:'';}
async function json(r){return r.json().catch(()=>({}));}
async function boot(root){
  const port=await freePort(),base=`http://127.0.0.1:${port}`;let out='';
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'pwa-owner',ADMIN_PASSWORD:'Pwa-owner-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);
  await wait(base+'/api/meta',child,()=>out);
  return {child,base,logs:()=>out};
}
async function login(ctx,username,password){const r=await fetch(ctx.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200,ctx.logs());const d=await json(r);return{cookie:firstCookie(r),csrf:d.csrf};}
async function mutate(ctx,cookie,csrf,url,body){return fetch(ctx.base+url,{method:'POST',headers:{Cookie:cookie,Origin:ctx.base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body||{})});}
async function status(ctx,cookie){const r=await fetch(ctx.base+'/app/device/status',{headers:{Cookie:cookie},cache:'no-store'});return{r,d:await json(r)};}
async function registerDevice(ctx,auth,name){const r=await mutate(ctx,auth.cookie,auth.csrf,'/app/device/register',{name});assert.equal(r.status,200,ctx.logs());const d=await json(r);const cookie=namedCookie(r,'dxpwa');assert.ok(cookie,'dxpwa cookie missing: '+(r.headers.get('set-cookie')||''));return{cookie,device:d.device};}

test('PWA can edit automatic DLP severity reactions for owner/admin devices and keeps operators read-only', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-pwa-dlp-settings-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  const ctx=await boot(root);t.after(async()=>{await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});

  const owner=await login(ctx,'pwa-owner','Pwa-owner-2026!');
  let st=await status(ctx,owner.cookie);assert.equal(st.r.status,200,ctx.logs());assert.equal(st.d.dlp.editable,true);assert.equal(st.d.dlp.actions.high,'quarantine');

  let r=await mutate(ctx,owner.cookie,owner.csrf,'/app/dlp/settings',{dlpRulesEnabled:true,dlpActionLow:'warn',dlpActionMedium:'quarantine',dlpActionHigh:'block',dlpActionCritical:'block'});
  assert.equal(r.status,200,ctx.logs());let body=await json(r);assert.equal(body.dlp.rulesEnabled,true);assert.deepEqual(body.dlp.actions,{low:'warn',medium:'quarantine',high:'block',critical:'block'});

  // A durable device paired by the owner keeps the same global DLP management
  // capability after the normal administrator session cookie is absent.
  const ownerDevice=await registerDevice(ctx,owner,'Owner phone');
  st=await status(ctx,ownerDevice.cookie);assert.equal(st.r.status,200,ctx.logs());assert.equal(st.d.adminSession,false);assert.equal(st.d.dlp.editable,true);assert.ok(st.d.csrf);
  r=await mutate(ctx,ownerDevice.cookie,st.d.csrf,'/app/dlp/settings',{dlpRulesEnabled:true,dlpActionLow:'log',dlpActionMedium:'warn',dlpActionHigh:'quarantine',dlpActionCritical:'block'});
  assert.equal(r.status,200,ctx.logs());body=await json(r);assert.deepEqual(body.dlp.actions,{low:'log',medium:'warn',high:'quarantine',critical:'block'});

  // Persisted server settings are the exact same ones used by the standard admin.
  r=await fetch(ctx.base+'/api/settings',{headers:{Cookie:owner.cookie},cache:'no-store'});assert.equal(r.status,200,ctx.logs());body=await json(r);assert.equal(body.dlpRulesEnabled,true);assert.equal(body.dlpActionHigh,'quarantine');

  // Operator devices can see the effective policy but cannot weaken/change it.
  r=await mutate(ctx,owner.cookie,owner.csrf,'/api/accounts',{username:'pwa-op',password:'Operator-2026!',role:'operator'});assert.equal(r.status,201,ctx.logs());
  const op=await login(ctx,'pwa-op','Operator-2026!');
  const opDevice=await registerDevice(ctx,op,'Operator phone');
  st=await status(ctx,opDevice.cookie);assert.equal(st.r.status,200,ctx.logs());assert.equal(st.d.dlp.editable,false);assert.ok(st.d.csrf);
  r=await mutate(ctx,opDevice.cookie,st.d.csrf,'/app/dlp/settings',{dlpRulesEnabled:false,dlpActionCritical:'log'});assert.equal(r.status,403,ctx.logs());body=await json(r);assert.equal(body.error,'admin-required');
});
