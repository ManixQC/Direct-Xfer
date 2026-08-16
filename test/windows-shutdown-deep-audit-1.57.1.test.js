'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function freePort() { return new Promise((resolve,reject)=>{ const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});}); }
function waitHealth(port, child, out) { return new Promise((resolve,reject)=>{ const deadline=Date.now()+10000; const tick=()=>{ if(child.exitCode!=null)return reject(new Error('early exit '+child.exitCode+'\n'+out())); const r=http.get({hostname:'127.0.0.1',port,path:'/healthz',timeout:400},res=>{res.resume();if(res.statusCode===200)return resolve();setTimeout(tick,80);}); r.on('error',()=>Date.now()>deadline?reject(new Error('health timeout\n'+out())):setTimeout(tick,80));r.on('timeout',()=>r.destroy());};tick();}); }

test('C# launcher and ServerHost deep shutdown audit prevents duplicate/stuck desktop processes', () => {
  assert.match(launcher, /RuntimeAppBuild = "1\.63\.4-launcher52-csharp"/);
  assert.match(launcher, /new Mutex\(true, MutexName/);
  assert.match(launcher, /Local\\DirectXferLauncherInstance/);
  assert.match(launcher, /EventWaitHandle/);
  assert.match(launcher, /RequestExit\(\)/);
  assert.doesNotMatch(launcher, /SignalServerHostStop\(\)|server\.Kill\(\)|node\.exe|StopNode\(\)/);
  assert.match(host, /Local\\DirectXferServerHostInstance/);
  assert.match(host, /SystemEvents\.SessionEnding \+= OnSessionEnding/);
  assert.match(host, /StopNode\(\)/);
  assert.match(host, /server\.WaitForExit\(6500\)/);
  assert.match(host, /server\.Kill\(\)/);
  assert.doesNotMatch(launcher + host, /taskkill\.exe|TerminateJobObject|AssignProcessToJobObject/);
  assert.match(launcher, /_tray\.Visible = false/);
});

test('server has an absolute shutdown deadline independent of persistence promises', () => {
  assert.match(server, /function forceProcessExit\(code = 0\)/);
  assert.match(server, /process\.exit\(Number\(code\) === 0 \? 0 : 1\)/);
  assert.doesNotMatch(server, /process\.kill\(process\.pid, 'SIGKILL'\)/);
  assert.match(server, /markWindowsCleanShutdown\(signal\)/);
  assert.match(server, /function settleWithin\(promise, timeoutMs\)/);
  assert.match(server, /settleWithin\(waitForConnectorJobsToStop\(\), 700\)/);
  assert.match(server, /settleWithin\(flushNow\(\), 900\)/);
  assert.match(server, /server\.closeAllConnections/);
  assert.match(server, /resetActiveHttpSocketsForShutdown\(\)/);
  assert.match(server, /}, 650\)/);
  assert.match(server, /shutdown hard deadline reached/);
  assert.match(server, /}, 3000\)/);
});

test('launcher shutdown endpoint exits Node rapidly even with a half-open client', {timeout:15000}, async () => {
  const port=await freePort(); const token='deep-'+Math.random().toString(16).slice(2); const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-deep-shutdown-'));
  for(const n of ['data','inbox','images']) fs.mkdirSync(path.join(tmp,n));
  let output='';
  const marker=path.join(tmp,'data','.clean-marker');
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...process.env,PORT:String(port),BIND:'127.0.0.1',DATA_DIR:path.join(tmp,'data'),INBOX_DIR:path.join(tmp,'inbox'),IMAGES_DIR:path.join(tmp,'images'),HOST_ROOT:tmp,NO_COLOR:'1',UPDATE_CHECK:'0',DX_WINDOWS_LAUNCHER_TOKEN:token,DX_WINDOWS_SHUTDOWN_MARKER:marker},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  let lingering;
  try {
    await waitHealth(port,child,()=>output);
    lingering=net.createConnection({host:'127.0.0.1',port}); await new Promise((res,rej)=>{lingering.once('connect',res);lingering.once('error',rej)}); lingering.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
    const started=Date.now();
    const status=await new Promise((res,rej)=>{const r=http.request({hostname:'127.0.0.1',port,path:'/__dx_launcher/shutdown',method:'POST',headers:{'X-Direct-Xfer-Launcher-Token':token},timeout:1500},x=>{x.resume();x.on('end',()=>res(x.statusCode));});r.on('error',rej);r.on('timeout',()=>r.destroy(new Error('timeout')));r.end();});
    assert.equal(status,202);
    const markerDeadline=Date.now()+2500;
    while(!fs.existsSync(marker) && Date.now()<markerDeadline) await new Promise(r=>setTimeout(r,25));
    assert.equal(fs.existsSync(marker), true, 'clean marker was not produced promptly\n'+output);
    assert.ok(Date.now()-started < 2500, 'clean shutdown state took too long: '+(Date.now()-started)+'ms\n'+output);
    // The listening socket must already be released before the Windows launcher
    // sees the marker and finishes the Job Object with exit code 0. Linux has no
    // launcher monitor here, so the Node process itself may remain briefly while
    // native worker threads wind down; the port invariant is what matters here.
    const rebound = net.createServer();
    await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => rebound.close(err => err ? reject(err) : resolve()));
  } finally { if(lingering) lingering.destroy(); if(child.exitCode==null) child.kill('SIGKILL'); fs.rmSync(tmp,{recursive:true,force:true}); }
});
