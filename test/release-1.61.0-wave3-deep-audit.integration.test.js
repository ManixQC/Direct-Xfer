'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const forge = require('node-forge');

let child, base, root, certPath, keyPath, auth, logs='';
const previousRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(e=>e?reject(e):resolve(port));});});}
async function wait(url,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!=null)throw new Error(`server exited ${child.exitCode}\n${logs}`);try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,70));}throw new Error(logs);}
function cookieFrom(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}
async function body(r){return r.json().catch(()=>({}));}
async function adminFetch(url,opts={}){const headers={Cookie:auth.cookie,Origin:base,...(opts.headers||{})};if(!['GET','HEAD'].includes(opts.method||'GET'))headers['X-CSRF-Token']=auth.csrf;return fetch(base+url,{...opts,headers});}
function makeCert(commonName) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now()) + String(Math.floor(Math.random()*10000));
  cert.validity.notBefore = new Date(Date.now()-60_000);
  cert.validity.notAfter = new Date(Date.now()+30*24*3600_000);
  const attrs = [{name:'commonName',value:commonName}];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([
    {name:'basicConstraints',cA:false},
    {name:'keyUsage',digitalSignature:true,keyEncipherment:true},
    {name:'extKeyUsage',serverAuth:true},
    {name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]},
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert:forge.pki.certificateToPem(cert), key:forge.pki.privateKeyToPem(keys.privateKey) };
}

before(async()=>{
  process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
  const port=await freePort(); base=`https://127.0.0.1:${port}`;
  root=fs.mkdtempSync(path.join(os.tmpdir(),'dx-wave3-audit-'));
  for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(root,d),{recursive:true});
  const initial=makeCert('direct-xfer-test');
  certPath=path.join(root,'provided-cert.pem'); keyPath=path.join(root,'provided-key.pem');
  fs.writeFileSync(certPath,initial.cert); fs.writeFileSync(keyPath,initial.key);
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),BIND:'127.0.0.1',ADMIN_USERNAME:'audit-admin',ADMIN_PASSWORD:'Audit-test-2026!',DATA_DIR:path.join(root,'data'),HOST_ROOT:path.join(root,'host'),INBOX_DIR:path.join(root,'inbox'),IMAGES_DIR:path.join(root,'images'),TLS_CERT:certPath,TLS_KEY:keyPath,TLS_SELF_SIGNED:'false',UPDATE_CHECK:'false',TRUST_PROXY:'false',PUBLIC_URL:base,SEARCH_OCR_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs+=c); child.stderr.on('data',c=>logs+=c);
  await wait(base+'/api/meta');
  const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 Firefox/153.0'},body:JSON.stringify({username:'audit-admin',password:'Audit-test-2026!'})});
  assert.equal(r.status,200,JSON.stringify(await body(r.clone()))); const d=await body(r); auth={cookie:cookieFrom(r),csrf:d.csrf};
});

after(async()=>{
  if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);if(child.exitCode==null)child.kill('SIGKILL');}
  if(root)fs.rmSync(root,{recursive:true,force:true});
  if(previousRejectUnauthorized===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previousRejectUnauthorized;
});

async function tlsCheck(){
  const r=await adminFetch('/api/diagnostics/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,200,JSON.stringify(await body(r.clone()))); const d=await body(r); const tls=d.checks.find(c=>c.id==='tls-certificate'); assert.ok(tls,JSON.stringify(d.checks)); return tls;
}

test('provided TLS diagnostic starts from the certificate actually loaded by the HTTPS listener',async()=>{
  const tls=await tlsCheck();
  assert.equal(tls.mode,'provided');
  assert.equal(tls.status,'ok',JSON.stringify(tls));
  assert.equal(tls.disk.valid,true);
  assert.equal(tls.disk.matchesActive,true);
  assert.ok(tls.fingerprint);
});

test('invalid certificate material written to disk does not replace or masquerade as the active TLS context',async()=>{
  const before=await tlsCheck();
  fs.writeFileSync(certPath,'-----BEGIN CERTIFICATE-----\nBROKEN\n-----END CERTIFICATE-----\n');
  const tls=await tlsCheck();
  assert.equal(tls.mode,'provided');
  assert.equal(tls.status,'warn',JSON.stringify(tls));
  assert.equal(tls.reason,'disk-material-invalid-active-context-kept');
  assert.equal(tls.disk.valid,false);
  assert.equal(tls.disk.matchesActive,false);
  assert.equal(tls.fingerprint,before.fingerprint,'live listener fingerprint must remain the known-good certificate');
  assert.equal(tls.fix == null,true,'provided TLS material must not offer the Local-CA auto-fix');
});

test('a complete new provided certificate/key pair is reported as pending until the live listener reloads it',async()=>{
  const replacement=makeCert('direct-xfer-test-replacement');
  fs.writeFileSync(keyPath,replacement.key);
  fs.writeFileSync(certPath,replacement.cert);
  let tls=await tlsCheck();
  // The watcher may reload very quickly on some systems. Both states are correct,
  // but it must never call mismatched valid material "active" unless fingerprints agree.
  if(tls.disk && tls.disk.matchesActive===false){
    assert.equal(tls.status,'warn',JSON.stringify(tls));
    assert.equal(tls.reason,'disk-material-pending-reload');
  } else {
    assert.equal(tls.disk.matchesActive,true,JSON.stringify(tls));
    assert.equal(tls.status,'ok',JSON.stringify(tls));
  }
});

test('a generic X-Forwarded-Server value is not mislabeled as Traefik',async()=>{
  const r=await adminFetch('/api/network/proxy-check',{headers:{'X-Forwarded-For':'198.51.100.25','X-Forwarded-Proto':'https','X-Forwarded-Server':'nginx-edge'}});
  assert.equal(r.status,200); const d=await body(r);
  assert.equal(d.detectedProxy,'Reverse proxy (nginx-edge)');
  assert.notEqual(d.detectedProxy,'Traefik');
});
