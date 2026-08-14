'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ZipArchive } = require('archiver');

let child, base, root, auth; let logs = '';
function makeZip(dest, entries){return new Promise((resolve,reject)=>{const out=fs.createWriteStream(dest);const zip=new ZipArchive({zlib:{level:6}});out.on('close',resolve);out.on('error',reject);zip.on('error',reject);zip.pipe(out);for(const [name,content] of entries)zip.append(content,{name});zip.finalize();});}
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function waitForServer(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url);if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,80));}throw new Error(`startup timeout\n${logs}`);}
function cookieFrom(r){const raw=r.headers.get('set-cookie')||'';const c=raw.split(';',1)[0];assert.match(c,/^[^=]+=.+$/);return c;}
async function json(r){return r.json().catch(()=>({}));}
function headers(extra={}){return {Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,Origin:base,...extra};}
function admin(url,opts={}){return fetch(base+url,{...opts,headers:headers(opts.headers||{})});}
async function waitIndex(){const end=Date.now()+10000;let d;while(Date.now()<end){const r=await admin('/api/search/status');d=await json(r);if(!d.building&&d.builtAt)return d;await new Promise(r=>setTimeout(r,50));}throw new Error('index timeout '+JSON.stringify(d));}

before(async()=>{
  const port=await freePort(); base=`http://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-xfer-dlp-semantic-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(path.join(root,'host','hydro-statement.txt'),'Administrative preface '.repeat(40)+'Hydro-Québec electricity statement for July 2026. Amount due 84.12 dollars.');
  fs.writeFileSync(path.join(root,'host','sensitive-card.txt'),'Customer payment card: 4111 1111 1111 1111\nInternal reference only.');
  fs.writeFileSync(path.join(root,'host','private-key.txt'),'-----BEGIN PRIVATE KEY-----\nMIIBFAKEFORTESTONLY\n-----END PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(root,'host','.env'),'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\n');
  fs.writeFileSync(path.join(root,'host','Dockerfile'),'client_secret=ABCDEFGHIJKLMNOPQRSTUVWX\nFROM node:22-alpine\n');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(root,'host','safe.png'),png); fs.writeFileSync(path.join(root,'host','confidential.png'),png);
  await makeZip(path.join(root,'host','secrets.zip'),[['notes/readme.txt','ordinary text'],['config/.env','AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\n']]);
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',TRUST_PROXY:'1',ADMIN_USERNAME:'dlp-admin',ADMIN_PASSWORD:'DLP-test-password-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),UPDATE_CHECK:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);await waitForServer(base+'/api/meta');
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'dlp-admin',password:'DLP-test-password-2026!'})});
  assert.equal(login.status,200,JSON.stringify(await json(login.clone())));const d=await json(login);auth={cookie:cookieFrom(login),csrf:d.csrf};
});
after(async()=>{if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode==null)child.kill('SIGKILL');}if(root)fs.rmSync(root,{recursive:true,force:true});});

test('semantic search finds concepts that do not literally appear in the query language',async()=>{
  const c=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/hydro-statement.txt'})});
  assert.equal(c.status,201,JSON.stringify(await json(c.clone())));const share=(await json(c)).share;
  const re=await admin('/api/search/reindex',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(re.status,202);await waitIndex();
  const lexical=await admin('/api/search?q='+encodeURIComponent('facture électricité juillet'));
  assert.equal(lexical.status,200);assert.equal((await json(lexical)).results.some(x=>x.shareId===share.id),false,'plain lexical mode should not invent synonyms');
  const semantic=await admin('/api/search?q='+encodeURIComponent('facture électricité juillet')+'&semantic=1');
  assert.equal(semantic.status,200,JSON.stringify(await json(semantic.clone())));const data=await json(semantic);
  const hit=data.results.find(x=>x.shareId===share.id);assert.ok(hit,JSON.stringify(data));assert.equal(hit.semantic,true);assert.ok(hit.semanticScore>0);
  assert.match(hit.snippet,/electricity statement/i,'semantic-only hit should show the matching concept, not the document preface');
  const raw=fs.readFileSync(path.join(root,'data','search-index.json'),'utf8');const index=JSON.parse(raw);const doc=index.docs.find(x=>x.shareId===share.id);assert.ok(Array.isArray(doc.semanticTerms));assert.ok(doc.semanticTerms.includes('invoice'));assert.ok(doc.semanticTerms.includes('electricity'));assert.ok(doc.semanticTerms.includes('july'));
});

test('DLP warn blocks publication until explicit override and never exposes the full card number',async()=>{
  const first=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sensitive-card.txt'})});
  assert.equal(first.status,409,JSON.stringify(await json(first.clone())));const warning=await json(first);
  assert.equal(warning.error,'dlp-warning');assert.ok(warning.dlp.count>=1);assert.ok(warning.dlp.findings.some(x=>x.type==='payment-card'));
  assert.doesNotMatch(JSON.stringify(warning),/4111 1111 1111 1111/);
  const before=await admin('/api/shares');assert.equal((await json(before)).shares.some(x=>x.name==='sensitive-card.txt'),false);
  const second=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/sensitive-card.txt',dlpOverride:true})});
  assert.equal(second.status,201,JSON.stringify(await json(second.clone())));const created=(await json(second)).share;assert.ok(created.dlp&&created.dlp.count>=1);assert.ok(created.dlp.types.includes('payment-card'));
  assert.doesNotMatch(JSON.stringify(created),/4111 1111 1111 1111/);
});

test('DLP block policy cannot be bypassed with dlpOverride',async()=>{
  const set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'block',dlpMaxFiles:50,dlpMaxFileMB:25,dlpScanOcr:false})});
  assert.equal(set.status,200,JSON.stringify(await json(set.clone())));
  const blocked=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/private-key.txt',dlpOverride:true})});
  assert.equal(blocked.status,403,JSON.stringify(await json(blocked.clone())));const data=await json(blocked);assert.equal(data.error,'dlp-blocked');assert.ok(data.dlp.findings.some(x=>x.type==='private-key'));
});

test('DLP scans extensionless/config files and text content inside ZIP archives',async()=>{
  const set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'warn',dlpMaxFiles:50,dlpMaxFileMB:25,dlpScanOcr:false})});
  assert.equal(set.status,200);
  for(const [file,type] of [['/.env','aws-access-key'],['/Dockerfile','api-secret'],['/secrets.zip','aws-access-key']]){
    const r=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:file})});
    assert.equal(r.status,409,file+' should be blocked for confirmation'); const d=await json(r);
    assert.equal(d.error,'dlp-warning'); assert.ok(d.dlp.findings.some(x=>x.type===type),JSON.stringify(d));
    assert.doesNotMatch(JSON.stringify(d),/AKIA1234567890ABCDEF|ABCDEFGHIJKLMNOPQRSTUVWX/);
  }
});

test('semantic search canonicalizes inflected synonyms after stemming',async()=>{
  const re=await admin('/api/search/reindex',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); assert.equal(re.status,202); await waitIndex();
  const r=await admin('/api/search?q='+encodeURIComponent('factures électricité juillet')+'&semantic=1');
  assert.equal(r.status,200); const d=await json(r);
  const hit=d.results.find(x=>x.file==='hydro-statement.txt'); assert.ok(hit,JSON.stringify(d)); assert.equal(hit.semantic,true);
});

test('photo batches keep DLP findings attached only to the image that triggered them',async()=>{
  const set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'warn',dlpMaxFiles:50,dlpMaxFileMB:25,dlpScanOcr:false})}); assert.equal(set.status,200);
  const body={paths:['/safe.png','/confidential.png']};
  const warn=await admin('/api/photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); assert.equal(warn.status,409);
  const ok=await admin('/api/photos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,dlpOverride:true,duplicateOverride:true})});
  assert.equal(ok.status,201,JSON.stringify(await json(ok.clone()))); const d=await json(ok);
  const safe=d.created.find(x=>x.name==='safe.png'), sensitive=d.created.find(x=>x.name==='confidential.png');
  assert.ok(safe&&sensitive,JSON.stringify(d)); assert.ok(!safe.dlp||!safe.dlp.count,'safe image must not inherit another image DLP findings');
  assert.ok(sensitive.dlp&&sensitive.dlp.types.includes('confidential-marker'));
});

test('DLP also protects PWA Images create and replace without publishing before confirmation', async()=>{
  const set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'warn',dlpMaxFiles:50,dlpMaxFileMB:25,dlpScanOcr:false})});
  assert.equal(set.status,200,JSON.stringify(await json(set.clone())));
  // Valid 1x1 PNG. The confidential marker is intentionally in the filename so
  // this integration test does not depend on an OCR binary being installed.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2bWQAAAAASUVORK5CYII=','base64');
  const first=await admin('/app/image?name='+encodeURIComponent('confidential-pwa.png'),{method:'POST',headers:{'Content-Type':'image/png'},body:png});
  assert.equal(first.status,409,JSON.stringify(await json(first.clone()))); const warning=await json(first);
  assert.equal(warning.error,'dlp-warning'); assert.ok(warning.dlp.findings.some(x=>x.type==='confidential-marker'));
  const before=await admin('/app/images?limit=500&includeInactive=1'); assert.equal(before.status,200); assert.equal((await json(before)).images.some(x=>x.name==='confidential-pwa.png'),false);

  const create=await admin('/app/image?name='+encodeURIComponent('confidential-pwa.png')+'&dlpOverride=1&duplicateOverride=1',{method:'POST',headers:{'Content-Type':'image/png'},body:png});
  assert.equal(create.status,201,JSON.stringify(await json(create.clone()))); const photo=await json(create); assert.ok(photo.token); assert.ok(photo.dlp&&photo.dlp.count>=1);

  const replaceWarn=await admin('/app/image/'+encodeURIComponent(photo.token)+'/replace?name='+encodeURIComponent('confidential-replaced.png'),{method:'POST',headers:{'Content-Type':'image/png'},body:png});
  assert.equal(replaceWarn.status,409,JSON.stringify(await json(replaceWarn.clone())));
  const unchanged=await admin('/app/image/'+encodeURIComponent(photo.token)+'/stats'); assert.equal(unchanged.status,200); assert.equal((await json(unchanged)).name,'confidential-pwa.png');

  const replace=await admin('/app/image/'+encodeURIComponent(photo.token)+'/replace?name='+encodeURIComponent('confidential-replaced.png')+'&dlpOverride=1&duplicateOverride=1',{method:'POST',headers:{'Content-Type':'image/png'},body:png});
  assert.equal(replace.status,200,JSON.stringify(await json(replace.clone()))); const replaced=await json(replace); assert.equal(replaced.image.name,'confidential-replaced.png'); assert.ok(replaced.dlp&&replaced.dlp.count>=1);
});

test('DLP block/warn policies fail safely when a file cannot be fully scanned', async()=>{
  fs.writeFileSync(path.join(root,'host','too-large.txt'), Buffer.alloc(2 * 1024 * 1024, 0x41));
  let set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'block',dlpMaxFiles:50,dlpMaxFileMB:1,dlpScanOcr:false})});
  assert.equal(set.status,200);
  let blocked=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/too-large.txt'})});
  assert.equal(blocked.status,403,JSON.stringify(await json(blocked.clone())));
  let bd=await json(blocked); assert.equal(bd.error,'dlp-blocked'); assert.equal(bd.dlp.count,0); assert.equal(bd.dlp.incomplete,true); assert.equal(bd.dlp.filesSkipped,1);

  set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'warn',dlpMaxFiles:50,dlpMaxFileMB:1,dlpScanOcr:false})});
  assert.equal(set.status,200);
  const warning=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/too-large.txt'})});
  assert.equal(warning.status,409,JSON.stringify(await json(warning.clone()))); const wd=await json(warning); assert.equal(wd.error,'dlp-warning'); assert.equal(wd.dlp.incomplete,true);
  const allowed=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/too-large.txt',dlpOverride:true})});
  assert.equal(allowed.status,201,JSON.stringify(await json(allowed.clone()))); const ad=await json(allowed); assert.equal(ad.share.dlp.incomplete,true);
});

test('DLP does not silently trust ZIP archives when the bounded member scan is incomplete', async()=>{
  const entries=[];
  for(let i=0;i<105;i++) entries.push([`bulk/file-${String(i).padStart(3,'0')}.txt`,'ordinary text']);
  await makeZip(path.join(root,'host','many-members.zip'),entries);
  const set=await admin('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dlpEnabled:true,dlpMode:'block',dlpMaxFiles:50,dlpMaxFileMB:25,dlpScanOcr:false})});
  assert.equal(set.status,200,JSON.stringify(await json(set.clone())));
  const blocked=await admin('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'/many-members.zip'})});
  assert.equal(blocked.status,403,JSON.stringify(await json(blocked.clone())));
  const d=await json(blocked);
  assert.equal(d.error,'dlp-blocked');
  assert.equal(d.dlp.count,0);
  assert.equal(d.dlp.incomplete,true);
  assert.equal(d.dlp.truncated,true);
  assert.ok(d.dlp.incompleteEntries>=1,JSON.stringify(d));
});
