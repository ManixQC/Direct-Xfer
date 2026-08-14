'use strict';
const assert=require('node:assert/strict');
const {after,before,test}=require('node:test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const serverSource=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const appJs=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','public','style.css'),'utf8');
let child,base,root,auth,logs='';
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function wait(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,60));}throw new Error(logs);}
function cookieFrom(r){const c=(r.headers.get('set-cookie')||'').split(';',1)[0];assert.match(c,/^[^=]+=.+$/);return c;}
async function json(r){return r.json().catch(()=>({}));}
async function admin(url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}
async function create(hostPath){const r=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:hostPath,dlpOverride:true})});assert.equal(r.status,201,JSON.stringify(await json(r.clone())));return (await json(r)).share;}
before(async()=>{const port=await freePort();base=`http://127.0.0.1:${port}`;root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-medium-'));for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});fs.writeFileSync(path.join(root,'host','plain.txt'),'hello\n');fs.writeFileSync(path.join(root,'host','sample.pdf'),'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');fs.mkdirSync(path.join(root,'host','bundle'));fs.writeFileSync(path.join(root,'host','bundle','a.txt'),'alpha\n');fs.writeFileSync(path.join(root,'host','bundle','b.txt'),'beta\n');child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'medium-admin',ADMIN_PASSWORD:'Medium-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);await wait(base+'/api/meta');const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'medium-admin',password:'Medium-test-2026!'})});assert.equal(r.status,200);const d=await json(r);auth={cookie:cookieFrom(r),csrf:d.csrf};});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('UI exposes trash, file history and live activity',()=>{for(const id of ['trash-btn','trash-overlay','file-history-overlay','live-activity-btn','activity-overlay','cfg-trash-retention'])assert.match(html,new RegExp(`id="${id}"`));assert.match(appJs,/function openTrash\(\)/);assert.match(appJs,/function openFileHistory\(sh\)/);assert.match(appJs,/new EventSource\('\/api\/activity\/stream'\)/);assert.match(css,/\.trash-row\{/);assert.match(css,/\.activity-row\{/);});

test('trash removes public access then restores same share',async()=>{const s=await create('/plain.txt');let r=await admin('/api/shares/'+s.id,{method:'DELETE'});assert.equal(r.status,200);const d=await json(r);assert.equal(d.recoverable,true);r=await fetch(base+s.path);assert.equal(r.status,404);const tr=await json(await admin('/api/trash'));const rec=tr.items.find(x=>x.shareId===s.id);assert.ok(rec);r=await admin('/api/trash/'+rec.id+'/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,200);const restored=(await json(r)).share;assert.equal(restored.id,s.id);assert.equal(restored.token,s.token);r=await fetch(base+s.path);assert.equal(r.status,200);});

test('trash retention config and backup restore preserve records',async()=>{let r=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashRetentionDays:45})});assert.equal(r.status,200);assert.equal((await json(r)).trashRetentionDays,45);assert.equal((await json(await admin('/api/trash'))).retentionDays,45);assert.match(serverSource,/trash: Array\.isArray\(p\.trash\) \? p\.trash : \[\]/);assert.doesNotMatch(serverSource,/state\.trash\.length>5000/);assert.match(serverSource,/if \(mode === 'replace'\) \{[\s\S]{0,800}?trashItems\(\)\.unshift/);});

test('PDF preview uses integrated iframe and SAMEORIGIN PDF response',async()=>{const s=await create('/sample.pdf');let r=await fetch(base+s.path+'/render');assert.equal(r.status,200);const body=await r.text();assert.match(body,/pdf-preview-shell/);assert.match(body,/pdf-preview-frame/);r=await fetch(base+s.path+'/view');assert.equal(r.status,200);assert.match(r.headers.get('content-type')||'',/application\/pdf/);assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(r.headers.get('content-security-policy')||'',/frame-ancestors 'self'/);});

test('selective ZIP deduplicates entries and per-file history expands ZIP members',async()=>{const s=await create('/bundle');const form=new URLSearchParams();form.set('sel','a.txt\na.txt\nb.txt\n../escape.txt');let r=await fetch(base+s.path+'/zip-select',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});assert.equal(r.status,200);const b=Buffer.from(await r.arrayBuffer());assert.ok(b.length>20);await new Promise(x=>setTimeout(x,100));r=await admin('/api/shares/'+s.id+'/file-history');assert.equal(r.status,200);const data=await json(r);const a=data.files.find(x=>x.name==='a.txt'),bb=data.files.find(x=>x.name==='b.txt');assert.ok(a,JSON.stringify(data));assert.ok(bb,JSON.stringify(data));assert.equal(a.transfers,1);assert.ok(data.events.some(x=>x.name==='a.txt'&&x.viaZip===true));assert.match(serverSource,/function parseIndexList\(v, max\)/);});

test('nested file history keeps relative path instead of basename only',async()=>{fs.mkdirSync(path.join(root,'host','bundle','nested'),{recursive:true});fs.writeFileSync(path.join(root,'host','bundle','nested','a.txt'),'nested\n');const s=await create('/bundle');const r=await fetch(base+s.path+'/file/nested/a.txt');assert.equal(r.status,200);await r.arrayBuffer();await new Promise(x=>setTimeout(x,60));const h=await json(await admin('/api/shares/'+s.id+'/file-history'));assert.ok(h.files.some(x=>x.name==='nested/a.txt'),JSON.stringify(h));});

test('live activity SSE requires session and sends a snapshot',async()=>{await create('/plain.txt');let r=await fetch(base+'/api/activity/stream');assert.equal(r.status,401);const ctl=new AbortController();r=await admin('/api/activity/stream',{signal:ctl.signal});assert.equal(r.status,200);assert.match(r.headers.get('content-type')||'',/text\/event-stream/);const reader=r.body.getReader();const first=await reader.read();const text=new TextDecoder().decode(first.value||new Uint8Array());ctl.abort();assert.match(text,/event: snapshot/);assert.match(text,/data: \[/);});

test('selective ZIP works for collaboration storage and preserves nested relative paths',async()=>{
  let r=await admin('/api/collab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Collab ZIP audit'})});
  assert.equal(r.status,201,JSON.stringify(await json(r.clone())));
  const s=(await json(r)).share;
  const dir=path.join(root,'inbox',s.relDir,'nested');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'inside.txt'),'inside collaboration\n');
  const form=new URLSearchParams();form.set('sel','nested/inside.txt');
  r=await fetch(base+s.path+'/zip-select',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.ok(bytes.length>30);
  await new Promise(x=>setTimeout(x,80));
  const h=await json(await admin('/api/shares/'+s.id+'/file-history'));
  assert.ok(h.files.some(x=>x.name==='nested/inside.txt'),JSON.stringify(h));
});

test('purging one reception link never deletes a directory still referenced by another link',async()=>{
  async function inbox(){const r=await admin('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Shared reception folder'})});assert.equal(r.status,201);return (await json(r)).share;}
  const a=await inbox(),b=await inbox();assert.equal(a.relDir,b.relDir);
  const dir=path.join(root,'inbox',a.relDir);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'keep.txt');fs.writeFileSync(file,'keep me\n');
  let r=await admin('/api/shares/'+a.id,{method:'DELETE'});assert.equal(r.status,200);
  let tr=await json(await admin('/api/trash'));let rec=tr.items.find(x=>x.shareId===a.id);assert.ok(rec);
  r=await admin('/api/trash/'+rec.id,{method:'DELETE'});assert.equal(r.status,200);assert.equal(fs.existsSync(file),true,'active sibling link still references this directory');
  r=await admin('/api/shares/'+b.id,{method:'DELETE'});assert.equal(r.status,200);tr=await json(await admin('/api/trash'));rec=tr.items.find(x=>x.shareId===b.id);assert.ok(rec);
  r=await admin('/api/trash/'+rec.id,{method:'DELETE'});assert.equal(r.status,200);assert.equal(fs.existsSync(dir),false,'last reference purge may remove managed data');
});

test('per-file aggregates continue past the 1000-event UI detail cap',async()=>{
  const s=await create('/plain.txt');const now=Date.now();const rows=[];
  for(let i=0;i<1005;i++)rows.push(JSON.stringify({id:'hist-'+i,shareId:s.id,name:'plain.txt',type:'file',direction:'down',ip:'127.0.0.1',bytes:6,durationMs:1,startedAt:now-i,endedAt:now-i,completed:true}));
  fs.appendFileSync(path.join(root,'data','transfers.log'),rows.join('\n')+'\n');
  const h=await json(await admin('/api/shares/'+s.id+'/file-history'));const f=h.files.find(x=>x.name==='plain.txt');assert.ok(f,JSON.stringify(h));assert.equal(f.transfers,1005);assert.equal(h.events.length,1000);
});

test('rendered PDF download/view URLs keep other query parameters well-formed',async()=>{
  fs.mkdirSync(path.join(root,'host','bundle','nestedpdf'),{recursive:true});fs.writeFileSync(path.join(root,'host','bundle','nestedpdf','q.pdf'),'%PDF-1.4\n%%EOF\n');
  const s=await create('/bundle');const r=await fetch(base+s.path+'/file/nestedpdf/q.pdf?render=1&lang=fr');assert.equal(r.status,200);const body=await r.text();
  assert.match(body,new RegExp('href="'+s.path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/file/nestedpdf/q\\.pdf\\?lang=fr"'));
  assert.match(body,/src="[^\"]+\?lang=fr&amp;view=1"/);assert.doesNotMatch(body,/q\.pdf&amp;lang=/);
});

test('live activity stays live, then closes after the authorizing admin session logs out',async()=>{
  const s=await create('/plain.txt');const ctl=new AbortController();const r=await admin('/api/activity/stream',{signal:ctl.signal});assert.equal(r.status,200);const reader=r.body.getReader();await reader.read();
  await fetch(base+s.path+'/download').then(x=>x.arrayBuffer());
  const live=await Promise.race([reader.read(),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),2500))]);assert.equal(!!live.timeout,false,'SSE must receive events after the snapshot');assert.match(new TextDecoder().decode(live.value||new Uint8Array()),/event: activity/);
  const out=await admin('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(out.status,200);
  await fetch(base+s.path+'/download').then(x=>x.arrayBuffer());
  let got=await Promise.race([reader.read(),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),2500))]);
  if(!got.timeout&&!got.done)got=await Promise.race([reader.read(),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),2500))]);
  ctl.abort();assert.equal(!!got.done,true,'SSE connection must not survive logout');
});
