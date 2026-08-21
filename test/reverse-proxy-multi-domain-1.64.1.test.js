'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const net=require('node:net');
const path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n').replace(/\r/g,'\n');

async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
async function waitFor(url,child,logs){const until=Date.now()+15000;while(Date.now()<until){if(child.exitCode!=null)throw new Error('server exited '+child.exitCode+'\n'+logs.join(''));try{const r=await fetch(url);if(r.ok)return;}catch(_){}await new Promise(r=>setTimeout(r,80));}throw new Error('server timeout\n'+logs.join(''));}
function cookieHeader(r){return (r.headers.get('set-cookie')||'').split(';',1)[0];}

test('proxy diagnostic treats configured Images domain as a distinct public base',()=>{
  const server=read('server.js'), app=read('public/app.js'), html=read('public/index.html');
  assert.match(server,/alternatePublicBase/);
  assert.match(server,/alternate-public-base/);
  assert.match(server,/configuredImageBase/);
  assert.match(server,/getSettings\(\)\.linkBase \|\| PUBLIC_URL/);
  assert.match(app,/proxy\.msg\.alternate-public-base/);
  assert.match(html,/app\.js\?v=347/);
});

test('real proxy check does not flag main admin host against configured Images host',{timeout:30000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-proxy-multi-'));
  const dirs=['host','data','images','inbox'];for(const d of dirs)fs.mkdirSync(path.join(temp,d),{recursive:true});
  const port=await freePort(),base=`http://127.0.0.1:${port}`,logs=[];
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',HOST_ROOT:path.join(temp,'host'),DATA_DIR:path.join(temp,'data'),IMAGES_DIR:path.join(temp,'images'),INBOX_DIR:path.join(temp,'inbox'),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'ProxyPass123!',UPDATE_CHECK:'false',TRUST_PROXY:'1',PUBLIC_URL:'https://xfer.example.test'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs.push(d.toString()));child.stderr.on('data',d=>logs.push(d.toString()));
  try{
    await waitFor(base+'/healthz',child,logs);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','Host':'xfer.example.test','X-Forwarded-Proto':'https','X-Forwarded-Host':'xfer.example.test','X-Forwarded-For':'192.168.50.1'},body:JSON.stringify({username:'admin',password:'ProxyPass123!'})});
    assert.equal(login.status,200,logs.join(''));const body=await login.json();const cookie=cookieHeader(login);
    const common={Cookie:cookie,Origin:'https://xfer.example.test','X-CSRF-Token':body.csrf,'Content-Type':'application/json','Host':'xfer.example.test','X-Forwarded-Proto':'https','X-Forwarded-Host':'xfer.example.test','X-Forwarded-For':'192.168.50.1'};
    const save=await fetch(base+'/api/settings',{method:'POST',headers:common,body:JSON.stringify({linkBase:'https://xfer.example.test',imageBase:'https://img.example.test'})});
    assert.equal(save.status,200,await save.clone().text());
    const r=await fetch(base+'/api/network/proxy-check?base='+encodeURIComponent('https://img.example.test'),{headers:{Cookie:cookie,'Host':'xfer.example.test','X-Forwarded-Proto':'https','X-Forwarded-Host':'xfer.example.test','X-Forwarded-For':'192.168.50.1'}});
    assert.equal(r.status,200,await r.clone().text());const diag=await r.json();
    assert.equal(diag.expectedBase,'https://img.example.test');
    assert.equal(diag.alternatePublicBase,true);
    assert.equal(diag.verdict,'ok',JSON.stringify(diag.checks));
    assert.equal(diag.checks.some(c=>c.code==='base-host-mismatch'),false,JSON.stringify(diag.checks));
    assert.ok(diag.checks.some(c=>c.code==='alternate-public-base'&&c.level==='info'),JSON.stringify(diag.checks));
  }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(temp,{recursive:true,force:true});}
});
