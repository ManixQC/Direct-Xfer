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
function cookieFrom(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function stop(child){if(!child||child.exitCode!=null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}
async function boot(root){const port=await freePort(),base=`http://127.0.0.1:${port}`;let out='';const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'audit-owner',ADMIN_PASSWORD:'Audit-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);await wait(base+'/api/meta',child,()=>out);const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'audit-owner',password:'Audit-test-2026!'})});assert.equal(login.status,200,out);const data=await login.json();return{child,base,logs:()=>out,auth:{cookie:cookieFrom(login),csrf:data.csrf}};}
async function admin(ctx,url,opts={}){const headers={Cookie:ctx.auth.cookie,Origin:ctx.base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=ctx.auth.csrf;return fetch(ctx.base+url,{...opts,headers});}
async function json(r){return r.json().catch(()=>({}));}

test('preview safety, severity quarantine and SHA-256 duplicate prevention work end-to-end', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1550-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','preview.txt'),'<script>alert(1)</script>\nhello');
  fs.writeFileSync(path.join(root,'host','preview.pdf'),Buffer.from('%PDF-1.4\n%dummy\n'));
  fs.writeFileSync(path.join(root,'host','sensitive.txt'),'password = SuperSecretPassword123!\n');
  const ctx=await boot(root); t.after(async()=>{await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});

  let r=await admin(ctx,'/api/preview?path='+encodeURIComponent('/preview.txt'));
  assert.equal(r.status,200,ctx.logs()); assert.match(r.headers.get('content-type')||'',/^text\/plain/i); assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.match(await r.text(),/<script>alert\(1\)<\/script>/);
  r=await admin(ctx,'/api/preview?path='+encodeURIComponent('/preview.pdf'));
  assert.equal(r.status,200,ctx.logs()); assert.match(r.headers.get('content-type')||'',/application\/pdf/i); assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN');

  r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpRulesEnabled:true,dlpActionLow:'log',dlpActionMedium:'quarantine',dlpActionHigh:'quarantine',dlpActionCritical:'block',dlpScanOcr:false})});
  assert.equal(r.status,200,ctx.logs());
  r=await admin(ctx,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sensitive.txt'})});
  assert.equal(r.status,423,ctx.logs()); let body=await json(r); assert.equal(body.error,'dlp-quarantined'); assert.ok(body.quarantineId);
  r=await admin(ctx,'/api/dlp/quarantine'); assert.equal(r.status,200); body=await json(r); assert.ok(body.records.some(x=>x.id && x.dlp && x.dlp.highest==='high'));

  const quarantinePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=','base64');
  r=await admin(ctx,'/api/photos/upload?name='+encodeURIComponent('confidential-quarantine.png'),{method:'POST',headers:{'Content-Type':'image/png'},body:quarantinePng});
  assert.equal(r.status,423,ctx.logs()); const physicalQ=await json(r); assert.equal(physicalQ.error,'dlp-quarantined');
  r=await admin(ctx,'/api/dlp/quarantine'); body=await json(r); const physicalRec=body.records.find(x=>x.id===physicalQ.quarantineId); assert.ok(physicalRec&&physicalRec.file,'managed upload should be moved into physical quarantine');
  const qFull=path.join(root,'images','Full'); assert.equal(fs.existsSync(qFull)?fs.readdirSync(qFull).length:0,0,'quarantined upload must not remain in public managed storage');
  r=await admin(ctx,'/api/dlp/quarantine/'+encodeURIComponent(physicalQ.quarantineId),{method:'DELETE'}); assert.equal(r.status,200,ctx.logs());
  r=await admin(ctx,'/api/dlp/quarantine'); body=await json(r); assert.equal(body.records.some(x=>x.id===physicalQ.quarantineId),false,'deleted quarantine record should stay removed');

  r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:false})}); assert.equal(r.status,200);
  const bytes=Buffer.from('same-image-bytes-for-hash-dedupe');
  const upload=async(suffix='')=>admin(ctx,'/api/photos/upload?name=duplicate.jpg'+suffix,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:bytes});
  r=await upload(); assert.equal(r.status,201,ctx.logs()); const first=(await json(r)).share; assert.ok(first && first.id);
  r=await upload(); assert.equal(r.status,409,ctx.logs()); body=await json(r); assert.equal(body.error,'duplicate-content'); assert.equal(body.duplicate.id,first.id);
  const fullDir=path.join(root,'images','Full'); assert.equal(fs.readdirSync(fullDir).length,1,'duplicate bytes should be discarded before persistence');
  r=await upload('&duplicateOverride=1'); assert.equal(r.status,201,ctx.logs()); assert.equal(fs.readdirSync(fullDir).length,2,'explicit override may store another copy');

  const raceBytes=Buffer.from('parallel-identical-image-content');
  const raceUpload=()=>admin(ctx,'/api/photos/upload?name=race.jpg',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:raceBytes});
  const race=await Promise.all([raceUpload(),raceUpload()]);
  const statuses=race.map(x=>x.status).sort((a,b)=>a-b);
  assert.deepEqual(statuses,[201,409],'same-hash concurrent uploads must serialize duplicate detection');
  assert.equal(fs.readdirSync(fullDir).length,3,'only one racing copy should reach managed storage');

  const hostRaceBytes=Buffer.from('parallel-identical-host-image-content');
  fs.writeFileSync(path.join(root,'host','host-a.jpg'),hostRaceBytes);
  fs.writeFileSync(path.join(root,'host','host-b.jpg'),hostRaceBytes);
  const hostImport=(name)=>admin(ctx,'/api/photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:['/'+name]})});
  const hostRace=await Promise.all([hostImport('host-a.jpg'),hostImport('host-b.jpg')]);
  assert.deepEqual(hostRace.map(x=>x.status).sort((a,b)=>a-b),[201,409],'same-hash concurrent host imports must serialize duplicate detection');
  assert.equal(fs.readdirSync(fullDir).length,4,'only one racing host import should reach managed storage');

  const batchBytes=Buffer.from('same-batch-identical-host-image-content');
  fs.writeFileSync(path.join(root,'host','batch-a.jpg'),batchBytes);
  fs.writeFileSync(path.join(root,'host','batch-b.jpg'),batchBytes);
  r=await admin(ctx,'/api/photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:['/batch-a.jpg','/batch-b.jpg']})});
  assert.equal(r.status,409,ctx.logs()); body=await json(r); assert.equal(body.error,'duplicate-content'); assert.equal(body.duplicateName,'batch-a.jpg');
  assert.equal(fs.readdirSync(fullDir).length,4,'same-request duplicates must be rejected before either copy is stored');
});
