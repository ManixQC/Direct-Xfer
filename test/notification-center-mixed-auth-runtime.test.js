'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const OWNER='notif-mixed-owner', OWNER_PW='Notif-mixed-owner-2026!';
const CHILD='notif-mixed-child', CHILD_PW='Notif-mixed-child-2026!';
let child, root, logs='';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function wait(url){const end=Date.now()+15000;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error('server exited\n'+logs);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error('timeout\n'+logs);}
function cookies(res){return res.headers.get('set-cookie')||'';}
function getCookie(raw,name){const m=new RegExp('(?:^|,\\s*)'+name+'=([^; ,]+)').exec(raw);assert.ok(m,raw);return name+'='+m[1];}
async function body(r){return r.json().catch(()=>({}));}
async function login(base,u,p){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});assert.equal(r.status,200,logs);const d=await body(r);return {cookie:getCookie(cookies(r),'sid'),csrf:d.csrf};}
function auth(base,a){return {Cookie:a.cookie,Origin:base,'X-CSRF-Token':a.csrf,'Content-Type':'application/json'};}

test('paired-device notification account wins over a different coincident admin session', async t=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-notif-mixed-'));for(const n of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,n),{recursive:true});
  t.after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}fs.rmSync(root,{recursive:true,force:true});});
  const port=await freePort(), base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:OWNER,ADMIN_PASSWORD:OWNER_PW,DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c.toString());child.stderr.on('data',c=>logs+=c.toString());await wait(base+'/api/meta');
  const owner=await login(base,OWNER,OWNER_PW);
  let r=await fetch(base+'/api/accounts',{method:'POST',headers:auth(base,owner),body:JSON.stringify({username:CHILD,password:CHILD_PW,role:'admin'})});assert.equal(r.status,201,logs);
  const childAuth=await login(base,CHILD,CHILD_PW);
  r=await fetch(base+'/app/device/register',{method:'POST',headers:auth(base,childAuth),body:JSON.stringify({name:'Child paired PWA'})});assert.equal(r.status,200,logs);
  const dxpwa=getCookie(cookies(r),'dxpwa');
  const mixedCookie=owner.cookie+'; '+dxpwa;
  r=await fetch(base+'/app/notifications',{headers:{Cookie:mixedCookie},cache:'no-store'});assert.equal(r.status,200,logs);
  const d=await body(r);
  assert.ok(d.notifications.some(n=>n.type==='admin-login'&&n.username===CHILD),JSON.stringify(d.notifications));
  assert.equal(d.notifications.some(n=>n.type==='admin-login'&&n.username===OWNER),false,'owner-session notifications must not leak into paired child PWA');
  assert.ok(d.notifications.some(n=>n.type==='pwa-device-paired'&&/Child paired PWA/.test(n.device||'')),JSON.stringify(d.notifications));
});
