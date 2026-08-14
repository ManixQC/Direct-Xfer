'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let child, base, root, auth;
let logs = '';
function freePort() { return new Promise((resolve, reject) => { const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));}); }); }
async function waitForServer(url, timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,60));}throw new Error(`server did not start\n${logs}`);}
function cookieFrom(r){const raw=r.headers.get('set-cookie')||'';const first=raw.split(';',1)[0];assert.match(first,/^[^=]+=.+$/);return first;}
async function json(r){return r.json().catch(()=>({}));}
async function adminFetch(url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-share-pack-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','sample.txt'),'hello productivity pack\n');
  fs.writeFileSync(path.join(root,'host','other.bin'),Buffer.alloc(256,7));
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'pack-admin',ADMIN_PASSWORD:'Pack-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{logs+=c.toString();}); child.stderr.on('data',c=>{logs+=c.toString();});
  await waitForServer(`${base}/api/meta`);
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'pack-admin',password:'Pack-test-2026!'})});
  assert.equal(login.status,200,JSON.stringify(await json(login.clone()))); const data=await json(login); auth={cookie:cookieFrom(login),csrf:data.csrf};
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

async function createShare(hostPath){const r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:hostPath,dlpOverride:true})});assert.equal(r.status,201,JSON.stringify(await json(r.clone())));return (await json(r)).share;}

test('1-3 remain first-class: duplicate, inline rename and private note editing',()=>{
  assert.match(appJs,/function cloneShare\(s, button\)/);
  assert.match(appJs,/function startInlineRename\(s, nameEl\)/);
  assert.match(appJs,/function openAdminNoteEditor\(s, card\)/);
  assert.match(serverSource,/adminRouter\.post\('\/shares\/:id\/clone'/);
  assert.match(serverSource,/typeof body\.adminNote === 'string'/);
});

test('4-14 UI exposes pin/archive, size-date filters, activity sort, bulk copy, quick expiry, extend and activity badges',()=>{
  for(const id of ['shares-size','shares-date','shares-date-from','shares-date-to','shares-archived-toggle','bulk-copy','bulk-pin','bulk-archive','bulk-expiry-preset']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/value="activity"/);
  assert.match(appJs,/function copySelectedLinks\(\)/);
  assert.match(appJs,/function setQuickExpiry\(s, seconds, control\)/);
  assert.match(appJs,/function extendShare\(s, seconds\)/);
  assert.match(appJs,/sh\.neverUsed/);
  assert.match(appJs,/sh\.veryActive/);
});

test('4, 5, 11, 12 and 15 persist safely and build a bounded change history', async()=>{
  const share=await createShare('/sample.txt');
  const edited=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Renamed sample',adminNote:'private dashboard note',pinned:true,archived:true,expiresInSeconds:86400,password:'Secret-should-never-appear!'})});
  assert.equal(edited.status,200,JSON.stringify(await json(edited.clone()))); const e=(await json(edited)).share;
  assert.equal(e.name,'Renamed sample'); assert.equal(e.adminNote,'private dashboard note'); assert.equal(e.pinned,true); assert.equal(e.archived,true); assert.ok(e.expiresAt>Date.now());

  const before=e.expiresAt;
  const ext=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}/extend`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seconds:86400})});
  assert.equal(ext.status,200,JSON.stringify(await json(ext.clone()))); const extended=(await json(ext)).share;
  assert.ok(extended.expiresAt >= before + 86399000, `${before} -> ${extended.expiresAt}`);

  const hist=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}/change-history`); assert.equal(hist.status,200); const h=await json(hist);
  assert.ok(h.entries.length>=2,JSON.stringify(h));
  const serialized=JSON.stringify(h);
  assert.doesNotMatch(serialized,/Secret-should-never-appear!/);
  assert.match(serialized,/hasPassword/);
  assert.match(serialized,/archived/);
  assert.match(serialized,/pinned/);
});

test('1 duplicate resets dashboard organization/runtime state while retaining reusable configuration', async()=>{
  const all=await adminFetch('/api/shares'); const source=(await json(all)).shares.find(s=>s.name==='Renamed sample'); assert.ok(source);
  const clone=await adminFetch(`/api/shares/${encodeURIComponent(source.id)}/clone`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Duplicated sample'})});
  assert.equal(clone.status,201,JSON.stringify(await json(clone.clone()))); const c=(await json(clone)).share;
  assert.notEqual(c.id,source.id); assert.equal(c.name,'Duplicated sample'); assert.equal(c.downloads,0); assert.equal(c.pinned,false); assert.equal(c.archived,false); assert.equal(c.adminNote,'private dashboard note');
});

test('9-12 bulk actions can pin, archive, set expiry and truly extend several shares', async()=>{
  const a=await createShare('/other.bin');
  const b=(await json(await adminFetch('/api/shares'))).shares.find(s=>s.name==='Duplicated sample'); assert.ok(b);
  const ids=[a.id,b.id];
  for(const action of ['pin','archive']){const r=await adminFetch('/api/shares/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,action})});assert.equal(r.status,200,JSON.stringify(await json(r.clone())));assert.equal((await json(r)).count,2);}
  let r=await adminFetch('/api/shares/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,action:'extend',expiresInSeconds:3600})});assert.equal(r.status,200);
  let list=(await json(await adminFetch('/api/shares'))).shares.filter(s=>ids.includes(s.id)); const firstExpiry=Math.min(...list.map(s=>s.expiresAt));
  r=await adminFetch('/api/shares/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,action:'extend-by',seconds:3600})});assert.equal(r.status,200);
  list=(await json(await adminFetch('/api/shares'))).shares.filter(s=>ids.includes(s.id)); assert.ok(list.every(s=>s.pinned&&s.archived)); assert.ok(Math.min(...list.map(s=>s.expiresAt))>=firstExpiry+3599000);
});

test('8 recent-activity sorting has a server timestamp updated by public use', async()=>{
  const share=await createShare('/sample.txt');
  const before=share.lastActivityAt;
  const hit=await fetch(`${base}${share.path}`,{redirect:'manual'}); assert.ok([200,302].includes(hit.status));
  const list=(await json(await adminFetch('/api/shares'))).shares; const updated=list.find(s=>s.id===share.id); assert.ok(updated.lastActivityAt>=before); assert.ok(updated.views>=1);
});

test('12 rejects invalid single and bulk extension durations without changing expiry', async()=>{
  const share=await createShare('/sample.txt');
  let r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresInSeconds:3600})});
  assert.equal(r.status,200); const baseline=(await json(r)).share.expiresAt; assert.ok(baseline>Date.now());

  for(const value of [0,-1,'nope',null]){
    r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}/extend`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seconds:value})});
    assert.equal(r.status,400,`single extend accepted ${String(value)}`);
  }
  r=await adminFetch('/api/shares/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[share.id],action:'extend-by',seconds:0})});
  assert.equal(r.status,400);
  r=await adminFetch('/api/shares/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[share.id],action:'extend'})});
  assert.equal(r.status,400);
  const current=(await json(await adminFetch('/api/shares'))).shares.find(s=>s.id===share.id);
  assert.equal(current.expiresAt,baseline);
});

test('15 records complete diffs and does not add history rows for unchanged edit fields', async()=>{
  const share=await createShare('/sample.txt');
  const startsAt=Date.now()+2*3600*1000;
  const payload={maxDownloads:5,maxVisitors:7,rateKBps:128,allowZip:false,noPreview:true,burnAfterDownload:true,note:'visitor note',startsAt,geoMode:'deny',geoCountries:'CA,US',ipMode:'deny',ipList:'203.0.113.7'};
  let r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(r.status,200,JSON.stringify(await json(r.clone())));
  let h=await json(await adminFetch(`/api/shares/${encodeURIComponent(share.id)}/change-history`));
  assert.equal(h.entries.length,1,JSON.stringify(h));
  const diff=h.entries[0].diff||{};
  for(const key of ['maxDownloads','maxVisitors','rateKBps','allowZip','noPreview','burnAfterDownload','note','startsAt','geoMode','geoCountries','ipMode','ipList']) assert.ok(key in diff,`missing diff ${key}: ${JSON.stringify(h.entries[0])}`);

  r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(r.status,200);
  h=await json(await adminFetch(`/api/shares/${encodeURIComponent(share.id)}/change-history`));
  assert.equal(h.entries.length,1,'unchanged edit should not create a history row');

  r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabled:true})}); assert.equal(r.status,200);
  r=await adminFetch(`/api/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabled:false})}); assert.equal(r.status,200);
  h=await json(await adminFetch(`/api/shares/${encodeURIComponent(share.id)}/change-history`));
  assert.deepEqual(h.entries[0].diff.disabled,{before:true,after:false});
});

test('6 reports real logical size for folder shares instead of zero bytes', async()=>{
  const dir=path.join(root,'host','large-folder'); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'small.txt'),'folder-size-test');
  const sparse=path.join(dir,'sparse.bin'); fs.closeSync(fs.openSync(sparse,'w')); fs.truncateSync(sparse,1100*1024*1024);
  const share=await createShare('/large-folder');
  const listed=(await json(await adminFetch('/api/shares'))).shares.find(s=>s.id===share.id);
  assert.ok(listed.logicalBytes>1024*1024*1024,`folder logicalBytes=${listed.logicalBytes}`);
});

test('9 bulk copy has one truthful toast, filters prune hidden selections, and quick expiry labels are localized',()=>{
  assert.match(appJs,/await copy\(urls\.join\('\\n'\), t\('sh\.copiedLinks'/);
  assert.match(appJs,/copied = document\.execCommand\('copy'\) === true/);
  assert.match(appJs,/Never leave selected shares hidden behind a filter/);
  assert.match(appJs,/\['7 ' \+ t\('time\.d'\),604800\]/);
  assert.doesNotMatch(appJs,/\['7 j',604800\]/);
});

test('new easy/medium pack exposes inline QR, card colors, tags, markdown, comments and lifecycle controls',()=>{
  for(const id of ['opt-color','opt-tags','opt-description','opt-reminder','opt-firstuse','opt-inactive','edit-color','edit-tags','edit-description','edit-reminder','edit-firstuse','edit-inactive','cfg-def-color','cfg-def-tags','cfg-def-description','cfg-def-reminder','cfg-def-firstuse','cfg-def-inactive']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(appJs,/function toggleInlineQr\(s, card, button\)/);
  assert.match(appJs,/share-colored/);
  assert.match(appJs,/function expiryProgressCard\(s\)/);
  assert.match(appJs,/function openShareComments\(s\)/);
  assert.match(appJs,/function resetShareStats\(s\)/);
  assert.match(serverSource,/function shareNoteHtml\(share\)/);
  assert.match(serverSource,/renderMarkdown\(share\.descriptionMd\)/);
});

test('color, labels, markdown and lifecycle rules persist and markdown is safely rendered publicly', async()=>{
  const r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    path:'/sample.txt',color:'#A1B2C3',tags:['Client','Urgent'],descriptionMd:'**Important** <script>alert(1)</script>',expiryReminderHours:12,firstUseExpirySeconds:3600,inactiveExpirySeconds:86400
  })});
  assert.equal(r.status,201,JSON.stringify(await json(r.clone()))); const s=(await json(r)).share;
  assert.equal(s.color,'#a1b2c3'); assert.deepEqual(s.tags,['Client','Urgent']); assert.equal(s.descriptionMd,'**Important** <script>alert(1)</script>');
  assert.equal(s.expiryReminderHours,12); assert.equal(s.firstUseExpirySeconds,3600); assert.equal(s.inactiveExpirySeconds,86400); assert.ok(s.inactiveExpiresAt>Date.now());
  const page=await fetch(base+s.path); assert.equal(page.status,200); const text=await page.text();
  assert.match(text,/<strong>Important<\/strong>/); assert.match(text,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(text,/<script>alert\(1\)<\/script>/);
});

test('administrator comments are private, bounded endpoints with add/list/delete', async()=>{
  const s=await createShare('/sample.txt');
  let r=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/comments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Internal follow-up only'})});
  assert.equal(r.status,201,JSON.stringify(await json(r.clone()))); const added=await json(r); assert.equal(added.comment.text,'Internal follow-up only');
  r=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/comments`); assert.equal(r.status,200); let data=await json(r); assert.equal(data.comments.length,1); assert.equal(data.comments[0].text,'Internal follow-up only');
  const publicPage=await fetch(base+s.path); const publicHtml=await publicPage.text(); assert.doesNotMatch(publicHtml,/Internal follow-up only/);
  r=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/comments/${encodeURIComponent(added.comment.id)}`,{method:'DELETE'}); assert.equal(r.status,200);
  data=await json(await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/comments`)); assert.equal(data.comments.length,0);
});

test('first-use expiry starts only after a complete download and records the last download', async()=>{
  const r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sample.txt',firstUseExpirySeconds:3600})});
  assert.equal(r.status,201); const s=(await json(r)).share; assert.equal(s.firstUsedAt,null); assert.equal(s.expiresAt,null);
  const dl=await fetch(`${base}${s.path}/download`); assert.equal(dl.status,200); await dl.arrayBuffer();
  const listed=(await json(await adminFetch('/api/shares'))).shares.find(x=>x.id===s.id); assert.ok(listed.firstUsedAt>0); assert.equal(listed.expiresAt,null); assert.ok(listed.firstUseExpiresAt>=listed.firstUsedAt+3599000); assert.ok(listed.firstUseExpiresAt<=listed.firstUsedAt+3601000); assert.equal(listed.effectiveExpiresAt,listed.firstUseExpiresAt); assert.equal(listed.lastDownload.name,'sample.txt'); assert.ok(listed.lastDownload.at>=listed.firstUsedAt);
});

test('reset stats resets dashboard/detail presentation without reopening operational quotas', async()=>{
  const r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sample.txt',maxDownloads:2})}); assert.equal(r.status,201); const s=(await json(r)).share;
  let dl=await fetch(`${base}${s.path}/download`); assert.equal(dl.status,200); await dl.arrayBuffer();
  let listed=(await json(await adminFetch('/api/shares'))).shares.find(x=>x.id===s.id); assert.equal(listed.downloads,1); assert.equal(listed.downloadsUsed,1);
  let rr=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/reset-stats`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); assert.equal(rr.status,200);
  listed=(await json(await adminFetch('/api/shares'))).shares.find(x=>x.id===s.id); assert.equal(listed.downloads,0); assert.equal(listed.downloadsUsed,1);
  const detail=await json(await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/stats-detail`)); assert.equal(detail.share.downloads,0); assert.equal(detail.aggregate.count,0); assert.equal(detail.recent.length,0);
  dl=await fetch(`${base}${s.path}/download`); assert.equal(dl.status,200); await dl.arrayBuffer();
  listed=(await json(await adminFetch('/api/shares'))).shares.find(x=>x.id===s.id); assert.equal(listed.downloads,1); assert.equal(listed.downloadsUsed,2);
  const denied=await fetch(`${base}${s.path}/download`); assert.notEqual(denied.status,200,'reset stats must not reopen maxDownloads quota');
});

test('configurable defaults for color, labels, markdown and lifecycle values round-trip through settings', async()=>{
  const patch={defaultShareColor:'#123abc',defaultShareTags:'client, urgent',defaultDescriptionMd:'**Default** description',defaultExpiryReminderHours:6,defaultFirstUseExpiryHours:12,defaultInactiveExpiryDays:30};
  let r=await adminFetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)}); assert.equal(r.status,200,JSON.stringify(await json(r.clone())));
  r=await adminFetch('/api/settings'); assert.equal(r.status,200); const settings=await json(r);
  assert.equal(settings.defaultShareColor,'#123abc'); assert.equal(settings.defaultShareTags,'client,urgent'); assert.equal(settings.defaultDescriptionMd,'**Default** description'); assert.equal(settings.defaultExpiryReminderHours,6); assert.equal(settings.defaultFirstUseExpiryHours,12); assert.equal(settings.defaultInactiveExpiryDays,30);
});

test('last upload is recorded for a reception link and appears in the decorated share', async()=>{
  let r=await adminFetch('/api/inbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Last upload test'})});
  assert.equal(r.status,201,JSON.stringify(await json(r.clone()))); const inbox=(await json(r)).share;
  const payload=Buffer.from('received payload for last-upload card\n');
  r=await fetch(`${base}${inbox.path}/upload?name=${encodeURIComponent('receipt.txt')}&size=${payload.length}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(payload.length)},body:payload});
  assert.equal(r.status,200,JSON.stringify(await json(r.clone())));
  const listed=(await json(await adminFetch('/api/shares'))).shares.find(x=>x.id===inbox.id);
  assert.equal(listed.lastUpload.name,'receipt.txt'); assert.equal(listed.lastUpload.bytes,payload.length); assert.ok(listed.lastUpload.at>0);
});

test('inactivity expiry participates in progress/reminders and activity rearms its reminder',()=>{
  assert.match(appJs,/const inactive = Number\(s\.inactiveExpiresAt\) \|\| 0/);
  assert.match(serverSource,/inactiveExpiryWarnedDeadline/);
  assert.match(serverSource,/reason: deadline\.kind/);
  assert.match(serverSource,/if \(s\.inactiveExpirySeconds\) delete s\.inactiveExpiryWarnedDeadline/);
  assert.match(serverSource,/shareActivityAt\(s\)/);
});

test('custom card color changes the border without collapsing the normal card padding',()=>{
  const css=fs.readFileSync(path.join(__dirname,'..','public','style.css'),'utf8');
  assert.match(css,/\.share\.share-colored\{border-left-color:var\(--share-color\);border-left-width:4px\}/);
  assert.doesNotMatch(css,/\.share\.share-colored\{[^}]*padding-left/);
});

test('1.35.4 keeps fixed and first-use expiries independent and duplicate drops runtime first-use state', async()=>{
  const r=await adminFetch('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sample.txt',expiresInSeconds:172800,firstUseExpirySeconds:3600})});
  assert.equal(r.status,201,JSON.stringify(await json(r.clone()))); const s=await json(r).then(x=>x.share);
  const fixed=s.expiresAt; assert.ok(fixed>Date.now()+170000000); assert.equal(s.firstUseExpiresAt,null);
  const dl=await fetch(`${base}${s.path}/download`); assert.equal(dl.status,200); await dl.arrayBuffer();
  let listed=(await json(await adminFetch('/api/shares'))).shares.find(x=>x.id===s.id);
  assert.equal(listed.expiresAt,fixed,'fixed expiry must not be overwritten by first-use expiry');
  assert.ok(listed.firstUseExpiresAt>=listed.firstUsedAt+3599000 && listed.firstUseExpiresAt<=listed.firstUsedAt+3601000);
  assert.equal(listed.effectiveExpiresAt,listed.firstUseExpiresAt);

  let edit=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstUseExpirySeconds:14400})});
  assert.equal(edit.status,200,JSON.stringify(await json(edit.clone()))); listed=(await json(edit)).share;
  assert.equal(listed.expiresAt,fixed); assert.ok(listed.firstUseExpiresAt>=listed.firstUsedAt+14399000); assert.equal(listed.effectiveExpiresAt,listed.firstUseExpiresAt);

  const clone=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}/clone`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Lifecycle clone'})});
  assert.equal(clone.status,201,JSON.stringify(await json(clone.clone()))); const c=(await json(clone)).share;
  assert.equal(c.firstUsedAt,null); assert.equal(c.firstUseExpiresAt,null); assert.equal(c.expiresAt,fixed);

  edit=await adminFetch(`/api/shares/${encodeURIComponent(s.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstUseExpirySeconds:0})});
  assert.equal(edit.status,200); listed=(await json(edit)).share;
  assert.equal(listed.firstUseExpiresAt,null); assert.equal(listed.effectiveExpiresAt,fixed);
});

test('1.35.4 rejects malformed lifecycle defaults instead of silently disabling them', async()=>{
  for(const patch of [
    {defaultExpiryReminderHours:'not-a-number'},
    {defaultExpiryReminderHours:-2},
    {defaultFirstUseExpiryHours:'bad'},
    {defaultFirstUseExpiryHours:-1},
    {defaultInactiveExpiryDays:'bad'},
    {defaultInactiveExpiryDays:-1},
  ]) {
    const r=await adminFetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
    assert.equal(r.status,400,`accepted malformed defaults: ${JSON.stringify(patch)}`);
  }
});

test('1.35.4 lifecycle UI uses effective expiry, hides useless reminders and rearms all reminder types',()=>{
  assert.match(appJs,/effectiveExpiresAt \|\| Infinity/);
  assert.match(appJs,/if \(s\.effectiveExpiresAt\) \{[\s\S]{0,500}?meta\.appendChild/);
  assert.match(appJs,/if \(!bits\.length\) return null/);
  assert.match(appJs,/const hasExpiryRule = !!\(s\.expiresAt \|\| s\.firstUseExpirySeconds \|\| s\.inactiveExpirySeconds\)/);
  assert.match(serverSource,/delete s\.expiryWarnedAt; delete s\.firstUseExpiryWarnedDeadline; delete s\.inactiveExpiryWarnedDeadline/);
  assert.match(serverSource,/kind: 'first-use'/);
});

test('1.35.4 dashboard storage summary uses logicalBytes so folder shares are not reported as zero',()=>{
  assert.match(appJs,/shares\.forEach\(\(s\) => \{ bytes \+= Math\.max\(0, Number\(s\.logicalBytes\) \|\| 0\); \}\)/);
});
