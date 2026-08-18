'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'), app=read('public/app.js'), html=read('public/index.html'), mod=read('public/server-health-dashboard.js'), css=read('public/server-health-dashboard.css'), health=read('lib/pwa-admin-health-route.js');

test('system health is a dedicated topbar page and no longer a dashboards sub-tab',()=>{
  assert.doesNotMatch(html,/id="dashboard-health-tab"/);
  assert.doesNotMatch(html,/id="dashboard-health-view"/);
  assert.match(html,/id="system-health-btn"/);
  assert.match(html,/id="system-health-page"/);
  assert.match(html,/server-health-dashboard\.css\?v=3/);
  assert.match(html,/server-health-dashboard\.js\?v=4/);
  assert.match(html,/app\.js\?v=307/);
  assert.match(app,/const SYSTEM_HEALTH_PATH = '\/system-health'/);
  assert.match(app,/DirectXferServerHealth/);
  assert.match(server,/app\.get\('\/system-health'/);
});

test('health endpoint is full-admin only and uses cached deep probes',()=>{
  assert.match(server,/adminRouter\.get\('\/server-health-dashboard', requireFullAdmin/);
  assert.match(server,/SERVER_HEALTH_DEEP_CACHE_MS = 30000/);
  assert.match(server,/serverHealthDeepSnapshot/);
  assert.match(server,/connectorProbeSnapshot\(\)/);
  assert.match(server,/serverHealthAuditSnapshot\(\)/);
  assert.match(server,/tlsCertificateDiagnostics\(\)/);
  assert.match(server,/universalSearchStatus\(\)/);
});

test('server health payload covers system, storage, security and workload',()=>{
  for(const token of ['storage:{ volumes','backup:{ enabled','security:{ audit','connectors:{ capabilities','notifications:{ webPushAvailable','runtime:{ node:process.version','workload = {','alerts = []']) assert.match(server,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(health,/processCpuPercent/);
  assert.match(health,/eventLoopSnapshot/);
  assert.match(health,/processHeapTotal/);
  assert.match(health,/processExternal/);
});

test('health UI has live polling, history ranges, export and on-demand diagnostics',()=>{
  assert.match(mod,/setInterval\(.*5000/);
  assert.match(mod,/\/api\/server-health-dashboard\?range=/);
  assert.match(mod,/\/api\/diagnostics\/run/);
  assert.match(mod,/X-CSRF-Token/);
  assert.match(mod,/new Blob/);
  assert.match(mod,/range:'24h'/);
  assert.match(css,/server-health-kpis/);
  assert.match(css,/server-health-history/);
});

test('health UI hides itself from non owner-admin roles',()=>{
  assert.match(mod,/!\['owner','admin'\]\.includes\(s\.role\)/);
  assert.match(app,/show\('system-health-btn', isFull\)/);
  assert.match(app,/showSystemHealthView\(\).*owner.*admin/s);
});

const os=require('os');
const net=require('net');
const {spawn}=require('child_process');
async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});s.on('error',reject);});}
async function waitFor(url,child,logs,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited '+child.exitCode+'\n'+logs.join(''));try{const r=await fetch(url);if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,100));}throw new Error('server timeout\n'+logs.join(''));}
function cookieHeader(r){const raw=r.headers.get('set-cookie')||'';return raw.split(',').map(x=>x.split(';')[0]).filter(Boolean).join('; ');}

test('real server protects and serves the complete health dashboard',{timeout:30000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-health-1640-'));
  const host=path.join(temp,'host'),data=path.join(temp,'data'),images=path.join(temp,'images'),inbox=path.join(temp,'inbox');for(const d of [host,data,images,inbox])fs.mkdirSync(d,{recursive:true});
  const port=await freePort(),base=`http://127.0.0.1:${port}`,logs=[];
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST_ROOT:host,DATA_DIR:data,IMAGES_DIR:images,INBOX_DIR:inbox,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'HealthPass123!',UPDATE_CHECK:'false',PUBLIC_URL:''},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>logs.push(d.toString()));child.stderr.on('data',d=>logs.push(d.toString()));
  try{
    await waitFor(base+'/healthz',child,logs);
    const anon=await fetch(base+'/api/server-health-dashboard');assert.ok([401,403].includes(anon.status));
    for(const asset of ['/server-health-dashboard.js?v=4','/server-health-dashboard.css?v=3']){const r=await fetch(base+asset);assert.equal(r.status,200);}
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'HealthPass123!'})});assert.equal(login.status,200);const cookie=cookieHeader(login);
    const r=await fetch(base+'/api/server-health-dashboard?range=24h',{headers:{Cookie:cookie}});assert.equal(r.status,200,await r.clone().text());const b=await r.json();
    assert.equal(b.version,'1.65.4');assert.ok(Number.isFinite(b.score));assert.ok(b.completeness&&Array.isArray(b.completeness.missing));assert.ok(b.health&&b.health.cpu&&b.health.memory&&b.health.process&&b.health.eventLoop);assert.ok(b.history&&Array.isArray(b.history.points));assert.ok(b.workload&&b.workload.shares&&b.workload.transfers);assert.ok(b.deep&&b.deep.storage&&Array.isArray(b.deep.storage.volumes));assert.ok(b.deep.security&&b.deep.tls&&b.deep.search&&b.deep.connectors&&b.deep.runtime);assert.ok(Array.isArray(b.alerts));
    await new Promise(r=>setTimeout(r,1100));
    const e1=await (await fetch(base+'/api/server-health-dashboard?range=24h',{headers:{Cookie:cookie}})).json();
    const e2=await (await fetch(base+'/api/server-health-dashboard?range=24h',{headers:{Cookie:cookie}})).json();
    if(e1.health.eventLoop.p95Ms!==null){assert.ok(e1.health.eventLoop.p95Ms>0);assert.equal(e2.health.eventLoop.p95Ms,e1.health.eventLoop.p95Ms);}
    const spoof=await (await fetch(base+'/api/server-health-dashboard',{headers:{Cookie:cookie,'X-Forwarded-Proto':'https','X-Forwarded-Host':'spoof.invalid'}})).json();
    assert.equal(spoof.edge.forwardedHeadersPresent,true);assert.equal(spoof.edge.proxyDetected,false);assert.ok(spoof.alerts.some(a=>a.code==='proxy-untrusted'));
  }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(temp,{recursive:true,force:true});}
});
