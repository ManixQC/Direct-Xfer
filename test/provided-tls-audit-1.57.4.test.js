'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const forge=require('node-forge');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');

function makeKey(){const p=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicExponent:0x10001});return{priv:p.privateKey.export({type:'pkcs1',format:'pem'}).toString(),pub:p.publicKey.export({type:'pkcs1',format:'pem'}).toString()};}
function selfSigned(k){const cert=forge.pki.createCertificate();cert.publicKey=forge.pki.publicKeyFromPem(k.pub);cert.serialNumber='01'+crypto.randomBytes(8).toString('hex');cert.validity.notBefore=new Date(Date.now()-60000);cert.validity.notAfter=new Date(Date.now()+86400000);const attrs=[{name:'commonName',value:'localhost'}];cert.setSubject(attrs);cert.setIssuer(attrs);cert.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]);cert.sign(forge.pki.privateKeyFromPem(k.priv),forge.md.sha256.create());return forge.pki.certificateToPem(cert);}

test('provided TLS is prevalidated and mismatched cert/key abort before listen', {timeout:15000}, async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-provided-tls-'));
  try{
    for(const d of ['data','host','inbox','images'])fs.mkdirSync(path.join(tmp,d),{recursive:true});
    fs.writeFileSync(path.join(tmp,'data','shares.json'),JSON.stringify({version:1,shares:[],settings:{}}));
    const k1=makeKey(),k2=makeKey();const certFile=path.join(tmp,'cert.pem'),keyFile=path.join(tmp,'key.pem');fs.writeFileSync(certFile,selfSigned(k1));fs.writeFileSync(keyFile,k2.priv);
    const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'58471',BIND:'127.0.0.1',DATA_DIR:path.join(tmp,'data'),HOST_ROOT:path.join(tmp,'host'),INBOX_DIR:path.join(tmp,'inbox'),IMAGES_DIR:path.join(tmp,'images'),ADMIN_PASSWORD:'Provided-Tls-Test-123!',TLS_CERT:certFile,TLS_KEY:keyFile,UPDATE_CHECK:'0',NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
    let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
    const code=await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,rej)=>setTimeout(()=>rej(new Error('server did not reject mismatched TLS pair')),8000))]);
    assert.notEqual(code,0);assert.match(logs,/provided TLS certificate\/key are invalid|key values mismatch|private key/i);
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});

test('provided TLS files are monitored and hot-reloaded from last-known-good context',()=>{
  const s=fs.readFileSync(path.join(root,'server.js'),'utf8');
  assert.match(s,/function refreshProvidedTlsServerContext\(server\)/);
  assert.match(s,/function tlsMaterialFingerprint\(cert, key\)/);
  assert.match(s,/activeProvidedTlsMaterialFingerprint/);
  assert.match(s,/reloaded the provided TLS certificate\/key chain without interrupting existing connections/);
  assert.match(s,/provided TLS certificate refresh failed; keeping the current TLS context/);
  assert.match(s,/tlsProvidedCertificateExpiresAt/);
});
