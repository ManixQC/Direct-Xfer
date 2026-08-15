'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');
const hostProject = fs.readFileSync(path.join(root, 'windows-server-host', 'DirectXfer.ServerHost.csproj'), 'utf8');
const project = fs.readFileSync(path.join(root, 'windows-launcher', 'DirectXfer.Launcher.csproj'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function request(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname:'127.0.0.1', port, path:pathname, method:'GET', headers: token ? {'X-Direct-Xfer-Launcher-Token':token} : {}, timeout:700 }, res => {
      let b=''; res.on('data', d => b += d); res.on('end', () => resolve({status:res.statusCode, body:b}));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end();
  });
}

test('launcher configuration changes are isolated from the running ServerHost session', () => {
  assert.match(launcher, /var next = CloneConfig\(_config\)/);
  assert.match(launcher, /var previous = _config/);
  assert.match(launcher, /ConfigSavedRestart/);
  assert.match(launcher, /IsServerHostRunning\(\)/);
  assert.match(host, /_config = LoadConfig\(\)/);
  assert.match(host, /EnvironmentVariables\["DATA_DIR"\] = _config\.dataDir/);
  assert.match(host, /EnvironmentVariables\["INBOX_DIR"\] = _config\.inboxDir/);
  assert.match(host, /EnvironmentVariables\["IMAGES_DIR"\] = _config\.imagesDir/);
});

test('Windows components are conventional C# WinForms/WinExe with transparent sidecar runtime', () => {
  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  assert.match(hostProject, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(hostProject, /<OutputType>WinExe<\/OutputType>/);
  assert.match(launcher, /ServerHostFileName = "Direct-Xfer\.ServerHost\.exe"/);
  assert.match(host, /RuntimeRoot[\s\S]*Path\.Combine\(PortableRoot, "runtime"\)/);
  assert.match(host, /Path\.Combine\(RuntimeRoot, "app"\)/);
  assert.match(host, /CriticalRuntimeSha256/);
  assert.match(host, /NodeExeSha256 = "3602f2bb/);
  assert.doesNotMatch(launcher + host, /direct-xfer-app\.zip|go:embed|SHASUMS256|nodejs\.org\/download|MkdirTemp|extractZip/);
  assert.equal(fs.existsSync(path.join(root,'windows-launcher','main.go')), false);
});

test('WinForms tray supports normal left click while ServerHost owns system-session shutdown', () => {
  assert.match(launcher, /new NotifyIcon/);
  assert.match(launcher, /_tray\.MouseClick \+=/);
  assert.match(launcher, /_tray\.MouseDoubleClick \+=/);
  assert.match(launcher, /ContextMenuStrip/);
  assert.doesNotMatch(launcher, /SystemEvents\.SessionEnding/);
  assert.match(host, /SystemEvents\.SessionEnding \+= OnSessionEnding/);
  assert.match(host, /OnSessionEnding[\s\S]*_stopEvent\.Set\(\)/);
});

test('Node child is hidden by ServerHost and readiness is bound to launcher token and PID', () => {
  assert.match(host, /CreateNoWindow = true/);
  assert.match(host, /WindowStyle = ProcessWindowStyle\.Hidden/);
  assert.match(host, /__dx_launcher\/ready/);
  assert.match(host, /X-Direct-Xfer-Launcher-Token/);
  assert.match(host, /expectedPid/);
  assert.match(server, /app\.get\('\/__dx_launcher\/ready'/);
  assert.match(server, /pid:process\.pid/);
});

test('private readiness endpoint rejects wrong token and identifies exact process', {timeout:15000}, async () => {
  const port = await freePort();
  const token = 'ready-' + Math.random().toString(16).slice(2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-ready-audit-'));
  for (const n of ['data','inbox','images']) fs.mkdirSync(path.join(tmp,n));
  const child = spawn(process.execPath, [path.join(root,'server.js')], { cwd:root, env:{...process.env, PORT:String(port), BIND:'127.0.0.1', DATA_DIR:path.join(tmp,'data'), INBOX_DIR:path.join(tmp,'inbox'), IMAGES_DIR:path.join(tmp,'images'), HOST_ROOT:tmp, UPDATE_CHECK:'0', NO_COLOR:'1', DX_WINDOWS_LAUNCHER_TOKEN:token}, stdio:['ignore','pipe','pipe'] });
  let out=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>out+=d);
  try {
    const deadline = Date.now()+9000;
    let good;
    while (Date.now()<deadline) {
      try { good = await request(port, '/__dx_launcher/ready', token); if (good.status===200) break; } catch {}
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(good && good.status, 200, out);
    const json = JSON.parse(good.body);
    assert.equal(json.ok, true); assert.equal(json.pid, child.pid); assert.equal(json.app, 'Direct-Xfer');
    const wrong = await request(port, '/__dx_launcher/ready', 'wrong-token');
    assert.equal(wrong.status, 404);
    const missing = await request(port, '/__dx_launcher/ready', '');
    assert.equal(missing.status, 404);
  } finally {
    child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
