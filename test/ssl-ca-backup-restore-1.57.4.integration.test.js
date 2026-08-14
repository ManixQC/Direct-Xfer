'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'Tls-Backup-Audit-2026!';
const DATA_KEY = 'Tls-Backup-Audit-Data-Key-2026';

function freePort() { return new Promise((resolve,reject)=>{ const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));}); }); }
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function dirsUnder(base){ const d={data:path.join(base,'data'),host:path.join(base,'host'),inbox:path.join(base,'inbox'),images:path.join(base,'images')}; for(const v of Object.values(d))fs.mkdirSync(v,{recursive:true}); return d; }
function start(dirs, port, extra={}) {
  const logs=[];
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',DATA_DIR:dirs.data,HOST_ROOT:dirs.host,INBOX_DIR:dirs.inbox,IMAGES_DIR:dirs.images,ADMIN_PASSWORD,UPDATE_CHECK:'0',NO_COLOR:'1',...extra},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>logs.push(c.toString())); child.stderr.on('data',c=>logs.push(c.toString())); child.logs=logs; return child;
}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(12000).then(()=>{throw new Error('shutdown timeout\n'+child.logs.join(''));})]);}
function req({scheme='http',port,ca=null,method='GET',pathname='/',headers={},body=null}){
  const mod=scheme==='https'?https:http;
  return new Promise((resolve,reject)=>{
    const options={hostname:'127.0.0.1',port,path:pathname,method,headers:{...headers},...(scheme==='https'?{ca,rejectUnauthorized:true}: {})};
    if(body!=null&&!Buffer.isBuffer(body))body=Buffer.from(body);
    if(body!=null&&!('Content-Length' in options.headers))options.headers['Content-Length']=String(body.length);
    const r=mod.request(options,res=>{const chunks=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});
    r.on('error',reject); r.setTimeout(2500,()=>r.destroy(new Error('request timeout'))); if(body)r.write(body);r.end();
  });
}
async function waitReady(child, scheme, port, ca=null){const end=Date.now()+20000;while(Date.now()<end){if(child.exitCode!==null)throw new Error('server exited '+child.exitCode+'\n'+child.logs.join(''));try{const r=await req({scheme,port,ca,pathname:'/healthz'});if(r.status===200)return;}catch(_){}await delay(100);}throw new Error('server readiness timeout\n'+child.logs.join(''));}
async function login(scheme,port,ca=null){const body=Buffer.from(JSON.stringify({username:'admin',password:ADMIN_PASSWORD}));const r=await req({scheme,port,ca,method:'POST',pathname:'/api/login',headers:{'Content-Type':'application/json'},body});assert.equal(r.status,200,r.body.toString());const cookie=(r.headers['set-cookie']||[])[0]?.split(';')[0];const json=JSON.parse(r.body.toString());assert.ok(cookie&&json.csrf);return{cookie,csrf:json.csrf};}
async function adminReq(scheme,port,ca,auth,method,pathname,body=null,contentType='application/json'){const headers={Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,Origin:`${scheme}://127.0.0.1:${port}`};if(body!=null)headers['Content-Type']=contentType;return req({scheme,port,ca,method,pathname,headers,body});}

function copyDir(src,dst){fs.mkdirSync(dst,{recursive:true});for(const ent of fs.readdirSync(src,{withFileTypes:true})){const a=path.join(src,ent.name),b=path.join(dst,ent.name);if(ent.isDirectory())copyDir(a,b);else fs.copyFileSync(a,b);}}

test('encrypted full backup preserves the Local CA trust anchor; plaintext backup never exports its private key', {timeout:90000}, async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-tls-backup-audit-'));
  let srcChild=null,plainChild=null,staleChild=null,dstChild=null,restartChild=null;
  try{
    const src=dirsUnder(path.join(tmp,'src'));
    fs.writeFileSync(path.join(src.data,'shares.json'),JSON.stringify({version:1,shares:[],settings:{tlsLocalCa:true}}));
    const srcPort=await freePort(); srcChild=start(src,srcPort,{DATA_KEY,LOCAL_IP:'192.168.88.20'});
    const caFile=path.join(src.data,'tls','local-ca-cert.pem');
    const end=Date.now()+20000;while(!fs.existsSync(caFile)&&Date.now()<end){if(srcChild.exitCode!==null)throw new Error(srcChild.logs.join(''));await delay(100);}assert.ok(fs.existsSync(caFile));
    const ca=fs.readFileSync(caFile); await waitReady(srcChild,'https',srcPort,ca);
    const sourceFingerprint=new crypto.X509Certificate(ca).fingerprint256;
    const auth=await login('https',srcPort,ca);
    const backup=await adminReq('https',srcPort,ca,auth,'GET','/api/backup/download');
    assert.equal(backup.status,200,backup.body.toString());
    const envelope=JSON.parse(backup.body.toString());
    assert.equal(envelope.dxenc,1,'backup carrying the CA private key must be encrypted on the wire');
    assert.equal(backup.body.includes(Buffer.from('localCaKey')),false,'CA key material must not appear in plaintext envelope bytes');
    await stop(srcChild);srcChild=null;

    // The same TLS material in a plaintext deployment must not cause the private
    // trust-anchor key to be exported by a normal full backup.
    const plain=dirsUnder(path.join(tmp,'plain'));
    copyDir(path.join(src.data,'tls'),path.join(plain.data,'tls'));
    fs.writeFileSync(path.join(plain.data,'shares.json'),JSON.stringify({version:1,shares:[],settings:{tlsLocalCa:false}}));
    const plainPort=await freePort(); plainChild=start(plain,plainPort,{TLS_SELF_SIGNED:'false'});await waitReady(plainChild,'http',plainPort);
    const plainAuth=await login('http',plainPort);
    const plainBackup=await adminReq('http',plainPort,null,plainAuth,'GET','/api/backup/download');
    assert.equal(plainBackup.status,200);const plainBundle=JSON.parse(plainBackup.body.toString());
    assert.equal(plainBundle.v,3);assert.equal(plainBundle.tls,null,'plaintext backup must omit CA private material');
    await stop(plainChild);plainChild=null;

    // Corrupt TLS leftovers from a previously disabled Local CA must not make an
    // otherwise healthy encrypted backup fail. They are not an active trust
    // anchor and are safely omitted.
    const stale=dirsUnder(path.join(tmp,'stale'));
    fs.writeFileSync(path.join(stale.data,'shares.json'),JSON.stringify({version:1,shares:[],settings:{tlsLocalCa:false}}));
    fs.mkdirSync(path.join(stale.data,'tls'),{recursive:true});
    fs.writeFileSync(path.join(stale.data,'tls','local-ca-cert.pem'),'not-a-certificate');
    fs.writeFileSync(path.join(stale.data,'tls','local-ca-key.pem'),'not-a-key');
    const stalePort=await freePort(); staleChild=start(stale,stalePort,{DATA_KEY,TLS_SELF_SIGNED:'false'}); await waitReady(staleChild,'http',stalePort);
    const staleAuth=await login('http',stalePort);
    const staleBackup=await adminReq('http',stalePort,null,staleAuth,'GET','/api/backup/download');
    assert.equal(staleBackup.status,200,'disabled corrupt TLS leftovers must not break full backup');
    await stop(staleChild);staleChild=null;

    // Restore the encrypted backup onto a fresh HTTP instance using the same
    // DATA_KEY; the next restart must present a leaf chaining to the original CA.
    const dst=dirsUnder(path.join(tmp,'dst'));
    fs.writeFileSync(path.join(dst.data,'shares.json'),JSON.stringify({version:1,shares:[],settings:{tlsLocalCa:false}}));
    const dstPort=await freePort();dstChild=start(dst,dstPort,{DATA_KEY,TLS_SELF_SIGNED:'false'});await waitReady(dstChild,'http',dstPort);
    const dstAuth=await login('http',dstPort);
    const restored=await adminReq('http',dstPort,null,dstAuth,'POST','/api/restore',backup.body,'application/octet-stream');
    assert.equal(restored.status,200,restored.body.toString());
    const restoredCa=fs.readFileSync(path.join(dst.data,'tls','local-ca-cert.pem'));
    assert.equal(new crypto.X509Certificate(restoredCa).fingerprint256,sourceFingerprint,'restore must preserve the exact trusted root');
    assert.ok(fs.existsSync(path.join(dst.data,'tls','local-ca-key.pem')),'encrypted restore must preserve CA signing ability');
    await stop(dstChild);dstChild=null;

    const restartPort=await freePort();restartChild=start(dst,restartPort,{DATA_KEY,LOCAL_IP:'192.168.88.20'});await waitReady(restartChild,'https',restartPort,ca);
    assert.equal(new crypto.X509Certificate(fs.readFileSync(path.join(dst.data,'tls','local-ca-cert.pem'))).fingerprint256,sourceFingerprint);
  } finally {
    for(const c of [srcChild,plainChild,staleChild,dstChild,restartChild])await stop(c).catch(()=>{});
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
