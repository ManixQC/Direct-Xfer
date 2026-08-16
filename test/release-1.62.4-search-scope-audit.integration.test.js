'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function wait(url,child,logs){const end=Date.now()+15000;while(Date.now()<end){if(child.exitCode!=null)throw new Error('server exited\n'+logs());try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,60));}throw new Error('timeout\n'+logs());}
async function stop(child){if(!child||child.exitCode!=null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode==null)child.kill('SIGKILL');}
function firstCookie(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
function namedCookie(r,name){const raw=r.headers.get('set-cookie')||'';const m=new RegExp('(?:^|,\\s*)'+name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'=([^;,]+)').exec(raw);return m?name+'='+m[1]:'';}
async function json(r){return r.json().catch(()=>({}));}
async function login(base,user,password){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password})});assert.equal(r.status,200,JSON.stringify(await json(r.clone())));const d=await json(r);return{cookie:firstCookie(r),csrf:d.csrf};}
async function api(base,auth,url,opts={}){const method=opts.method||'GET';const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(method))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,method,headers});}
async function postJson(base,auth,url,body){return api(base,auth,url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});}
async function waitIndex(base,owner){await postJson(base,owner,'/api/search/reindex',{});const end=Date.now()+15000;let d={};while(Date.now()<end){const r=await api(base,owner,'/api/search/status');d=await json(r);if(!d.building&&d.builtAt)return d;await new Promise(r=>setTimeout(r,60));}throw new Error('index timeout '+JSON.stringify(d));}

test('operator and operator-paired PWA only receive viewer-scoped search counts/results', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-search-scope-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','owner-only.txt'),'OWNER_ULTRAMARINE_MARKER');
  fs.writeFileSync(path.join(root,'host','operator-only.txt'),'OPERATOR_COPPER_MARKER');
  const port=await freePort(),base=`http://127.0.0.1:${port}`;let output='';
  const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'scope-owner',ADMIN_PASSWORD:'Scope-owner-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false',DLP_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);t.after(async()=>{await stop(child);fs.rmSync(root,{recursive:true,force:true});});
  await wait(base+'/api/meta',child,()=>output);
  const owner=await login(base,'scope-owner','Scope-owner-2026!');
  let r=await postJson(base,owner,'/api/accounts',{username:'scope-op',password:'Scope-operator-2026!',role:'operator'});assert.equal(r.status,201,output);
  r=await postJson(base,owner,'/api/shares',{path:'/owner-only.txt',dlpOverride:true});assert.equal(r.status,201,output);
  const op=await login(base,'scope-op','Scope-operator-2026!');
  r=await postJson(base,op,'/api/shares',{path:'/operator-only.txt',dlpOverride:true});assert.equal(r.status,201,output);
  const ownerStatus=await waitIndex(base,owner);assert.ok(ownerStatus.indexed>=2,JSON.stringify(ownerStatus));
  r=await api(base,op,'/api/search/status');assert.equal(r.status,200,output);const opStatus=await json(r);assert.ok(opStatus.indexed>=1,JSON.stringify(opStatus));assert.ok(opStatus.indexed<ownerStatus.indexed,JSON.stringify({ownerStatus,opStatus}));
  assert.notEqual(opStatus.error && opStatus.error.includes('/'),true,JSON.stringify(opStatus));
  r=await api(base,op,'/api/search?q='+encodeURIComponent('OWNER_ULTRAMARINE_MARKER')+'&scope=all');assert.equal(r.status,200,output);let d=await json(r);assert.equal((d.results||[]).length,0,JSON.stringify(d));
  r=await api(base,op,'/api/search?q='+encodeURIComponent('OPERATOR_COPPER_MARKER')+'&scope=all');assert.equal(r.status,200,output);d=await json(r);assert.ok((d.results||[]).length>=1,JSON.stringify(d));
  r=await postJson(base,op,'/app/device/register',{name:'Operator search phone'});assert.equal(r.status,200,output);const pwaCookie=namedCookie(r,'dxpwa');assert.ok(pwaCookie,r.headers.get('set-cookie')||'');
  r=await fetch(base+'/app/search?q='+encodeURIComponent('OWNER_ULTRAMARINE_MARKER'),{headers:{Cookie:pwaCookie},cache:'no-store'});assert.equal(r.status,200,output);d=await json(r);assert.equal((d.results||[]).length,0,JSON.stringify(d));assert.equal(d.indexed,opStatus.indexed,JSON.stringify({d,opStatus}));
  r=await fetch(base+'/app/search?q='+encodeURIComponent('OPERATOR_COPPER_MARKER'),{headers:{Cookie:pwaCookie},cache:'no-store'});assert.equal(r.status,200,output);d=await json(r);assert.ok((d.results||[]).length>=1,JSON.stringify(d));assert.equal(d.degraded,false,JSON.stringify(d));
});

test('startup banner prefers configured linkBase over PUBLIC_URL and derives image fallback from it', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-banner-priority-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'data','shares.json'),JSON.stringify({version:1,shares:[],trash:[],settings:{linkBase:'https://configured.example.test',imageBase:'',updateCheck:false},history:[],photoHistory:[],stats:{},meta:{},audit:[],ipNames:{},undoLog:[],activityLog:[]}));
  const port=await freePort();let output='';
  const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_PASSWORD:'Banner-scope-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),PUBLIC_URL:'https://env.example.test',UPDATE_CHECK:'false',SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);t.after(async()=>{await stop(child);fs.rmSync(root,{recursive:true,force:true});});
  const end=Date.now()+10000;while(!output.includes('Public IMG URL')&&Date.now()<end){if(child.exitCode!=null)throw new Error(output);await new Promise(r=>setTimeout(r,40));}
  assert.match(output,/Public URL\s+: https:\/\/configured\.example\.test\s+\(configured\)/,output);
  assert.match(output,/Public IMG URL\s+: https:\/\/configured\.example\.test\s+\(same public base\)/,output);
  assert.doesNotMatch(output,/Public URL\s+: https:\/\/env\.example\.test/,output);
});
