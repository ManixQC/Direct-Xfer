'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ZipArchive } = require('archiver');
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function wait(url,child,logs){const until=Date.now()+15000;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited\n'+logs());try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,70));}throw new Error('timeout\n'+logs());}
function cookieFrom(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function stop(child){if(!child||child.exitCode!=null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}
async function boot(root){const port=await freePort(),base=`http://127.0.0.1:${port}`;let out='';const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'audit-owner',ADMIN_PASSWORD:'Audit-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);await wait(base+'/api/meta',child,()=>out);const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'audit-owner',password:'Audit-test-2026!'})});assert.equal(login.status,200,out);const data=await login.json();return{child,base,logs:()=>out,auth:{cookie:cookieFrom(login),csrf:data.csrf}};}
async function admin(ctx,url,opts={}){const headers={Cookie:ctx.auth.cookie,Origin:ctx.base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=ctx.auth.csrf;return fetch(ctx.base+url,{...opts,headers});}
async function json(r){return r.json().catch(()=>({}));}

function makeZip(file, entries){return new Promise((resolve,reject)=>{const out=fs.createWriteStream(file);const zip=new ZipArchive({zlib:{level:1}});out.on('close',resolve);out.on('error',reject);zip.on('error',reject);zip.pipe(out);for(const [name,content] of entries)zip.append(content,{name});zip.finalize();});}

test('deep audit integration: preview parity, truncated marker and trash-aware SHA-256 dedupe', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1551-audit-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','service.cfg'),'enabled=true\nport=8080\n');
  fs.writeFileSync(path.join(root,'host','huge.txt'),'x'.repeat(2*1024*1024+8192));
  const ctx=await boot(root); t.after(async()=>{await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});

  let r=await admin(ctx,'/api/browse?path=%2F'); assert.equal(r.status,200,ctx.logs());
  let body=await json(r); const cfg=body.entries.find(x=>x.name==='service.cfg'); assert.ok(cfg); assert.ok(Number(cfg.mtimeMs)>0,'browser entry must carry mtime for safe resume identity');
  r=await admin(ctx,'/api/preview?path='+encodeURIComponent('/service.cfg')); assert.equal(r.status,200,ctx.logs()); assert.match(r.headers.get('content-type')||'',/^text\/plain/i); assert.match(await r.text(),/enabled=true/);
  r=await admin(ctx,'/api/preview?path='+encodeURIComponent('/huge.txt')); assert.equal(r.status,200,ctx.logs()); assert.equal(r.headers.get('x-direct-xfer-preview-truncated'),'1'); assert.ok((await r.arrayBuffer()).byteLength<=2*1024*1024);

  // A permissive severity rule must not weaken a stricter fallback when part of
  // the content could not be inspected.
  const zipEntries=[['00-confidential.txt','STRICTLY CONFIDENTIAL']]; for(let i=0;i<105;i++)zipEntries.push([`bulk/${i}.txt`,'ordinary']);
  await makeZip(path.join(root,'host','mixed-incomplete.zip'),zipEntries);
  r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'block',dlpRulesEnabled:true,dlpActionMedium:'log',dlpMaxFiles:50,dlpMaxFileMB:25,dlpScanOcr:false})}); assert.equal(r.status,200,ctx.logs());
  r=await admin(ctx,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/mixed-incomplete.zip'})}); assert.equal(r.status,403,ctx.logs()); body=await json(r); assert.equal(body.error,'dlp-blocked'); assert.equal(body.dlp.highest,'medium'); assert.equal(body.dlp.incomplete,true);

  // Disable DLP for a pure dedupe check.
  r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:false})}); assert.equal(r.status,200,ctx.logs());
  const bytes=Buffer.from('trash-aware-hash-dedupe');
  const upload=()=>admin(ctx,'/api/photos/upload?name=trash-dupe.jpg',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:bytes});
  r=await upload(); assert.equal(r.status,201,ctx.logs()); const first=(await json(r)).share; assert.ok(first&&first.id);
  r=await admin(ctx,'/api/shares/'+encodeURIComponent(first.id),{method:'DELETE'}); assert.equal(r.status,200,ctx.logs());
  r=await upload(); assert.equal(r.status,409,ctx.logs()); body=await json(r); assert.equal(body.error,'duplicate-content'); assert.equal(body.duplicate.trashed,true); assert.equal(body.duplicate.status,'trash');
  const fullDir=path.join(root,'images','Full'); assert.equal(fs.readdirSync(fullDir).length,1,'duplicate of an item in trash must not consume another managed copy');
});

test('deep audit integration: quarantine metadata reconciles missing files and removes orphan blobs on restart', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1551-quarantine-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  let ctx=await boot(root);
  await stop(ctx.child);
  const storeFile=path.join(root,'data','shares.json');
  const store=JSON.parse(fs.readFileSync(storeFile,'utf8'));
  store.meta=store.meta||{};
  store.meta.dlpQuarantine=[
    {id:'keep-record',at:Date.now()-1000,source:'test',name:'keep',file:'keep.bin',dlp:{count:1,highest:'high',types:['test'],incomplete:false}},
    {id:'missing-record',at:Date.now(),source:'test',name:'missing',file:'missing.bin',dlp:{count:1,highest:'high',types:['test'],incomplete:false}},
  ];
  fs.writeFileSync(storeFile,JSON.stringify(store,null,2));
  const qdir=path.join(root,'data','dlp-quarantine'); fs.mkdirSync(qdir,{recursive:true});
  fs.writeFileSync(path.join(qdir,'keep.bin'),'kept');
  fs.writeFileSync(path.join(qdir,'orphan.bin'),'orphan');

  ctx=await boot(root); t.after(async()=>{await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});
  let r=await admin(ctx,'/api/dlp/quarantine'); assert.equal(r.status,200,ctx.logs()); const body=await json(r);
  const keep=body.records.find(x=>x.id==='keep-record'), missing=body.records.find(x=>x.id==='missing-record');
  assert.ok(keep&&keep.file===true); assert.ok(missing&&missing.file===false&&missing.fileMissing===true);
  assert.equal(fs.existsSync(path.join(qdir,'orphan.bin')),false,'unreferenced quarantine bytes must be cleaned after state is durably loaded');
  assert.equal(fs.existsSync(path.join(qdir,'keep.bin')),true,'referenced quarantine bytes must be preserved');
  const disk=JSON.parse(fs.readFileSync(storeFile,'utf8')); const missingDisk=(disk.meta.dlpQuarantine||[]).find(x=>x.id==='missing-record');
  assert.ok(missingDisk&&missingDisk.file===null&&missingDisk.fileMissing===true,'reconciled quarantine metadata must survive restart');
});


test('deep audit security: client cannot inject a quarantine source path', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-1551-qpath-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','sensitive.txt'),'STRICTLY CONFIDENTIAL\n');
  const sentinel=path.join(root,'data','sentinel-do-not-move.txt');
  fs.writeFileSync(sentinel,'must remain in place');
  const ctx=await boot(root); t.after(async()=>{await stop(ctx.child);fs.rmSync(root,{recursive:true,force:true});});

  let r=await admin(ctx,'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'quarantine',dlpRulesEnabled:true,dlpActionMedium:'quarantine',dlpScanOcr:false})});
  assert.equal(r.status,200,ctx.logs());
  r=await admin(ctx,'/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sensitive.txt',dlpQuarantineFile:sentinel,dlpQuarantineName:'attacker-controlled-name'})});
  assert.equal(r.status,423,ctx.logs()); const body=await json(r); assert.equal(body.error,'dlp-quarantined');
  assert.equal(fs.existsSync(sentinel),true,'a client-supplied path must never be moved into quarantine');
  assert.equal(fs.readFileSync(sentinel,'utf8'),'must remain in place');
  r=await admin(ctx,'/api/dlp/quarantine'); assert.equal(r.status,200,ctx.logs()); const records=(await json(r)).records||[];
  const rec=records.find(x=>x.id===body.quarantineId); assert.ok(rec,'logical quarantine record should still exist');
  assert.equal(rec.file,false,'generic share DLP quarantine must not attach arbitrary server bytes');
});
