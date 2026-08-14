'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
async function wait(child,port){const end=Date.now()+12000;while(Date.now()<end){if(child.exitCode!==null)throw new Error('early exit '+child.exitCode);try{const r=await new Promise((resolve,reject)=>{const q=http.get(`http://127.0.0.1:${port}/healthz`,resolve);q.on('error',reject);q.setTimeout(500,()=>q.destroy());});if(r.statusCode===200){r.resume();return;}r.resume();}catch(_){}await delay(100);}throw new Error('timeout');}
async function stop(child){if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(8000)]);if(child.exitCode===null)child.kill('SIGKILL');}
async function runCase(committed){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-tls-restore-crash-'));
  const data=path.join(tmp,'data');for(const d of [data,path.join(tmp,'host'),path.join(tmp,'inbox'),path.join(tmp,'images')])fs.mkdirSync(d,{recursive:true});
  const id='abcdef0123456789abcdef01';
  fs.writeFileSync(path.join(data,'shares.json'),JSON.stringify({version:1,shares:[],settings:{tlsLocalCa:false},meta:committed?{tlsRestoreCommitId:id}:{}}));
  const live=path.join(data,'tls'),old=path.join(data,'tls.restore-old-test'),stage=path.join(data,'tls.restore-stage-test');fs.mkdirSync(live);fs.mkdirSync(old);fs.writeFileSync(path.join(live,'sentinel'),'new');fs.writeFileSync(path.join(old,'sentinel'),'old');
  fs.writeFileSync(path.join(data,'.tls-restore-transaction.json'),JSON.stringify({v:1,id,stage,old,hadOld:true,phase:'swapped'}));
  const port=await freePort();const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',DATA_DIR:data,HOST_ROOT:path.join(tmp,'host'),INBOX_DIR:path.join(tmp,'inbox'),IMAGES_DIR:path.join(tmp,'images'),ADMIN_PASSWORD:'Crash-Recovery-123!',TLS_SELF_SIGNED:'false',UPDATE_CHECK:'0',NO_COLOR:'1'},stdio:'ignore'});
  try{await wait(child,port);assert.equal(fs.readFileSync(path.join(live,'sentinel'),'utf8'),committed?'new':'old');assert.equal(fs.existsSync(old),false);assert.equal(fs.existsSync(path.join(data,'.tls-restore-transaction.json')),false);}finally{await stop(child);fs.rmSync(tmp,{recursive:true,force:true});}
}
test('uncommitted TLS restore crash rolls back to the previously trusted CA directory',()=>runCase(false));
test('committed TLS restore crash keeps the restored CA and only finishes cleanup',()=>runCase(true));
