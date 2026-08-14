'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function wait(url, child, logs){const until=Date.now()+15000;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited\n'+logs());try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,70));}throw new Error('timeout\n'+logs());}
function cookieFrom(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function stop(child){if(!child||child.exitCode!=null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}

async function boot(root){const port=await freePort(),base=`http://127.0.0.1:${port}`;let out='';const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'features-owner',ADMIN_PASSWORD:'Features-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);await wait(base+'/api/meta',child,()=>out);const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'features-owner',password:'Features-test-2026!'})});assert.equal(login.status,200,out);const data=await login.json();return{child,base,logs:()=>out,auth:{cookie:cookieFrom(login),csrf:data.csrf}};}
async function admin(ctx,url,opts={}){const headers={Cookie:ctx.auth.cookie,Origin:ctx.base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=ctx.auth.csrf;return fetch(ctx.base+url,{...opts,headers});}
async function j(r){return r.json().catch(()=>({}));}

test('1.54.0 settings, never-expire policy, recursive metrics, trash count/restore and global activity search work together', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1540-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.mkdirSync(path.join(root,'host','bundle','sub'),{recursive:true});fs.writeFileSync(path.join(root,'host','bundle','a.txt'),'12345');fs.writeFileSync(path.join(root,'host','bundle','sub','b.bin'),Buffer.alloc(7));
  const ctx=await boot(root);t.after(async()=>{await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});

  let r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newSharesNeverExpire:true,diskFreeWarnPercent:17,confirmShareRevoke:false})});
  assert.equal(r.status,200,JSON.stringify(await j(r.clone())));
  r=await admin(ctx,'/api/settings');assert.equal(r.status,200);let settings=await j(r);assert.equal(settings.newSharesNeverExpire,true);assert.equal(settings.diskFreeWarnPercent,17);assert.equal(settings.confirmShareRevoke,false);

  r=await admin(ctx,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/bundle',expiresInSeconds:3600,expiresAt:Date.now()+7200000,firstUseExpirySeconds:3600,inactiveExpirySeconds:86400,dlpOverride:true})});
  assert.equal(r.status,201,ctx.logs());const created=(await j(r)).share;assert.equal(created.expiresAt,null);assert.equal(created.firstUseExpirySeconds,0);assert.equal(created.inactiveExpirySeconds,0);

  let listed=null;
  for(let i=0;i<40;i++){r=await admin(ctx,'/api/shares');assert.equal(r.status,200);const data=await j(r);listed=data.shares.find(x=>x.id===created.id);if(listed&&listed.logicalBytesReady&&listed.itemCount===2)break;await new Promise(x=>setTimeout(x,80));}
  assert.ok(listed,ctx.logs());assert.equal(listed.logicalBytesReady,true);assert.equal(listed.itemCount,2);assert.equal(listed.logicalBytes,12);

  r=await admin(ctx,`/api/shares/${encodeURIComponent(created.id)}`,{method:'DELETE'});assert.equal(r.status,200,ctx.logs());const trashId=(await j(r)).trashId;assert.ok(trashId);
  r=await admin(ctx,'/api/shares');assert.equal(r.status,200);let data=await j(r);assert.equal(data.trashCount,1);
  r=await admin(ctx,'/api/trash');assert.equal(r.status,200);data=await j(r);assert.equal(data.count,1);
  r=await admin(ctx,`/api/trash/${encodeURIComponent(trashId)}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,200,ctx.logs());
  r=await admin(ctx,'/api/shares');data=await j(r);assert.equal(data.trashCount,0);

  // Duplicating an older expiring link still counts as creating a new link: the
  // instance-wide never-expire policy must strip both fixed and dynamic deadlines.
  r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newSharesNeverExpire:false})});
  assert.equal(r.status,200);
  r=await admin(ctx,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/bundle/a.txt',expiresInSeconds:3600,firstUseExpirySeconds:1800,inactiveExpirySeconds:7200,dlpOverride:true})});
  assert.equal(r.status,201,ctx.logs());const expiring=(await j(r)).share;assert.ok(expiring.expiresAt);assert.equal(expiring.firstUseExpirySeconds,1800);assert.equal(expiring.inactiveExpirySeconds,7200);
  r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newSharesNeverExpire:true})});assert.equal(r.status,200);
  r=await admin(ctx,`/api/shares/${encodeURIComponent(expiring.id)}/clone`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'clone-no-expiry.txt'})});
  assert.equal(r.status,201,ctx.logs());const cloned=(await j(r)).share;assert.equal(cloned.expiresAt,null);assert.equal(cloned.firstUseExpirySeconds,0);assert.equal(cloned.inactiveExpirySeconds,0);

  // Universal search covers the distinct resource families requested by the UI:
  // standard shares, reception links, image links, and Activity/audit rows.
  r=await admin(ctx,'/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Search Reception 1540'})});
  assert.equal(r.status,201,ctx.logs());
  fs.writeFileSync(path.join(root,'host','SearchPhoto1540.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]));
  r=await admin(ctx,'/api/photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:['/SearchPhoto1540.jpg'],dlpOverride:true})});
  assert.equal(r.status,201,ctx.logs());
  r=await admin(ctx,'/api/search?q='+encodeURIComponent('Search Reception 1540')+'&scope=links');assert.equal(r.status,200,ctx.logs());data=await j(r);assert.ok((data.results||[]).some(x=>x.scope==='link'&&x.type==='inbox'),JSON.stringify(data.results));
  r=await admin(ctx,'/api/search?q='+encodeURIComponent('SearchPhoto1540')+'&scope=links');assert.equal(r.status,200,ctx.logs());data=await j(r);assert.ok((data.results||[]).some(x=>x.scope==='link'&&x.type==='photo'),JSON.stringify(data.results));
  r=await admin(ctx,'/api/search?q='+encodeURIComponent('share-restored')+'&scope=logs');assert.equal(r.status,200,ctx.logs());data=await j(r);assert.ok((data.results||[]).some(x=>x.scope==='log'),JSON.stringify(data.results));
});
