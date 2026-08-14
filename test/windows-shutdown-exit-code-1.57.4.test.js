'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
function waitReady(port, token, child, getOutput) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      if (child.exitCode != null) return reject(new Error('early exit '+child.exitCode+'\n'+getOutput()));
      const req = http.get({hostname:'127.0.0.1', port, path:'/__dx_launcher/ready', headers:{'X-Direct-Xfer-Launcher-Token':token}, timeout:400}, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() > deadline) return reject(new Error('readiness timeout\n'+getOutput()));
        setTimeout(tick, 60);
      });
      req.on('error', () => Date.now() > deadline ? reject(new Error('readiness timeout\n'+getOutput())) : setTimeout(tick, 60));
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

test('successful launcher shutdown releases the listener cleanly before any last-resort child kill', {timeout:20000}, async () => {
  assert.match(server, /process\.exit\(Number\(code\) === 0 \? 0 : 1\)/);
  assert.doesNotMatch(server, /process\.kill\(process\.pid, 'SIGKILL'\)/);
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.1-launcher27-csharp"/);
  assert.match(launcher, /ConsumeCleanShutdownMarker\(\)/);
  assert.doesNotMatch(launcher, /terminateProcessTree\(0\)/);
  assert.doesNotMatch(launcher, /TerminateJobObject/);
  assert.doesNotMatch(launcher, /procTerminateProcess/);
  assert.doesNotMatch(launcher, /taskkill\.exe/);
  assert.match(launcher, /!wasExpected && exitCode != 0/);

  const port = await freePort();
  const token = 'exit-code-' + Math.random().toString(16).slice(2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-exit-code-'));
  const data = path.join(tmp, 'data');
  const inbox = path.join(tmp, 'inbox');
  const images = path.join(tmp, 'images');
  for (const d of [data,inbox,images]) fs.mkdirSync(d);
  const marker = path.join(data, '.clean-marker');
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {...process.env, PORT:String(port), BIND:'127.0.0.1', DATA_DIR:data, INBOX_DIR:inbox, IMAGES_DIR:images, HOST_ROOT:tmp, UPDATE_CHECK:'0', NO_COLOR:'1', DX_WINDOWS_LAUNCHER_TOKEN:token, DX_WINDOWS_SHUTDOWN_MARKER:marker},
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', d => output += d);
  child.stderr.on('data', d => output += d);
  try {
    await waitReady(port, token, child, () => output);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({hostname:'127.0.0.1', port, path:'/__dx_launcher/shutdown', method:'POST', headers:{'X-Direct-Xfer-Launcher-Token':token}, timeout:1500}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('shutdown timeout'))); req.end();
    });
    assert.equal(status, 202);
    const markerDeadline = Date.now() + 3500;
    while (!fs.existsSync(marker) && Date.now() < markerDeadline) await new Promise(r => setTimeout(r, 25));
    assert.equal(fs.existsSync(marker), true, 'clean marker should be written before the launcher fallback is ever needed');
    assert.match(output, /shutting down \(windows-launcher\)/);
    const outputDeadline = Date.now() + 2000;
    while (!/server closed/.test(output) && Date.now() < outputDeadline) await new Promise(r => setTimeout(r, 25));
    assert.match(output, /server closed/);
    const rebound = net.createServer();
    await new Promise((resolve,reject)=>{rebound.once('error',reject);rebound.listen(port,'127.0.0.1',resolve);});
    await new Promise((resolve,reject)=>rebound.close(err=>err?reject(err):resolve()));
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(tmp, {recursive:true, force:true});
  }
});
