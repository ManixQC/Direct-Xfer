'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const net=require('net');
const {spawn}=require('child_process');
const root=path.resolve(__dirname,'..');
const read=(f)=>fs.readFileSync(path.join(root,f),'utf8');
const app=read('public/app.js'), mod=read('public/standard-productivity.js'), html=read('public/index.html'), css=read('public/style.css'), server=read('server.js');

test('standard view loads the isolated productivity module with bumped cache keys',()=>{
  assert.match(html,/style\.css\?v=311/); assert.match(html,/app\.js\?v=340/); assert.match(html,/standard-productivity\.js\?v=4/);
  assert.match(app,/window\.DXStandard = Object\.freeze/); assert.match(mod,/window\.DXStandard/);
});

test('share context menu exposes visitor/details/history and role-aware mutable actions',()=>{
  assert.match(mod,/share-context-menu/); assert.match(mod,/addContextAction\(m,'🧪 '/); assert.match(mod,/contextHistory/); assert.match(mod,/const mutable=state\(\)\.role!=='auditor'/); assert.match(css,/\.share-context-menu/);
});

test('durable undo history and needs-attention center are first-class standard controls',()=>{
  assert.match(mod,/\/api\/undo/); assert.match(mod,/\/api\/undo\/.*encodeURIComponent/); assert.match(mod,/todo-center-btn/); assert.match(mod,/todoMissing/); assert.match(mod,/todoModeration/); assert.match(mod,/todoStalled/); assert.match(mod,/todoFailure/);
});

test('daily dashboard summary covers transfers, volume, failures, visitors and new shares',()=>{
  assert.match(server,/last24h\.uniqueVisitors = last24Ips\.size/); assert.match(server,/last24h\.sharesCreated =/); assert.match(mod,/dash-daily-summary-card/); for(const key of ['dailyTransfers','dailyVolume','dailyErrors','dailyVisitors','dailyShares'])assert.match(mod,new RegExp(key));
});

test('backing-source health is asynchronous, cached and generation guarded',()=>{
  assert.match(server,/SHARE_BACKING_HEALTH_CACHE_MS/); assert.match(server,/queueShareBackingHealthRefresh/); assert.match(server,/shareBackingHealthGeneration/); assert.match(server,/backing: shareBackingHealthSnapshot\(s\)/); assert.match(server,/mapLimit\(backingCandidates, 4/); assert.match(mod,/share-source-health/); assert.match(css,/share-source-missing/);
});

test('visitor test is a server-side logical probe independent of admin browser cookies',()=>{
  assert.match(server,/adminRouter\.get\('\/shares\/:id\/visitor-test'/); assert.match(server,/verdict='password-required'/); assert.match(server,/verdict='approval-required'/); assert.match(server,/verdict='missing-source'/); assert.match(mod,/\/visitor-test/);
});

test('dashboard customization persists drag order, hidden widgets and width',()=>{
  assert.match(mod,/dx-standard-dashboard-layout-v1/); assert.match(mod,/dragstart/); assert.match(mod,/dash-widget-user-hidden/); assert.match(mod,/classList\.toggle\('dash-wide'/); assert.match(mod,/captureDashboardLayout/); assert.match(css,/dashboard-customizing/);
});

test('guided diagnostics reuses hardened diagnostic and safe fix endpoints',()=>{
  assert.match(mod,/guided-diagnostics-overlay/); assert.match(mod,/POST','\/api\/diagnostics\/run'/); assert.match(mod,/POST','\/api\/diagnostics\/fix'/); assert.match(mod,/c\.fix&&c\.fix\.action/); assert.match(server,/safeDiagnosticFixFor/);
});

async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});s.on('error',reject);});}
async function waitFor(url,child,logs,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited '+child.exitCode+'\n'+logs.join(''));try{const r=await fetch(url);if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error('server timeout\n'+logs.join(''));}
function cookieHeader(r){const raw=r.headers.get('set-cookie')||'';return raw.split(',').map(x=>x.split(';')[0]).filter(Boolean).join('; ');}

test('real server visitor probe detects a removed source and dashboard returns enriched 24h summary',{timeout:30000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-standard-1640-'));
  const host=path.join(temp,'host'),data=path.join(temp,'data'),images=path.join(temp,'images'),inbox=path.join(temp,'inbox');fs.mkdirSync(host,{recursive:true});fs.writeFileSync(path.join(host,'sample.txt'),'hello');
  const port=await freePort(),base=`http://127.0.0.1:${port}`,logs=[];
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST_ROOT:host,DATA_DIR:data,IMAGES_DIR:images,INBOX_DIR:inbox,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'AuditPass123!',UPDATE_CHECK:'false',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']}); child.stdout.on('data',d=>logs.push(d.toString()));child.stderr.on('data',d=>logs.push(d.toString()));
  try{
    await waitFor(base+'/healthz',child,logs);
    const asset=await fetch(base+'/standard-productivity.js?v=4');assert.equal(asset.status,200);assert.match(await asset.text(),/Needs-attention center|Centre À traiter/);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'AuditPass123!'})});assert.equal(login.status,200);const body=await login.json(),cookie=cookieHeader(login),auth={Cookie:cookie},mut={Cookie:cookie,'X-CSRF-Token':body.csrf,Origin:base,'Content-Type':'application/json'};
    const create=await fetch(base+'/api/shares',{method:'POST',headers:mut,body:JSON.stringify({path:'/sample.txt'})});assert.equal(create.status,201,await create.clone().text());const created=await create.json();const id=created.share.id;
    let probe=await fetch(base+'/api/shares/'+encodeURIComponent(id)+'/visitor-test',{headers:auth});let pb=await probe.json();assert.equal(probe.status,200);assert.equal(pb.verdict,'ready');assert.equal(pb.expectedStatus,200);
    fs.unlinkSync(path.join(host,'sample.txt'));
    probe=await fetch(base+'/api/shares/'+encodeURIComponent(id)+'/visitor-test',{headers:auth});pb=await probe.json();assert.equal(pb.verdict,'missing-source');assert.equal(pb.expectedStatus,404);
    const listing=await fetch(base+'/api/shares',{headers:auth}).then(r=>r.json());const share=listing.shares.find(x=>x.id===id);assert.equal(share.backing.status,'missing');
    const dash=await fetch(base+'/api/dashboard?days=1',{headers:auth});assert.equal(dash.status,200);const db=await dash.json();assert.ok(Object.hasOwn(db.last24h,'uniqueVisitors'));assert.ok(Object.hasOwn(db.last24h,'sharesCreated'));assert.ok(db.last24h.sharesCreated>=1);
  }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(temp,{recursive:true,force:true});}
});
