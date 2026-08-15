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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((e) => e ? reject(e) : resolve(p));
    });
  });
}
function waitHealth(port, child, outputRef) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      if (child.exitCode != null) return reject(new Error(`server exited early (${child.exitCode})\n${outputRef()}`));
      const req = http.get({ hostname:'127.0.0.1', port, path:'/healthz', timeout:500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        setTimeout(tick, 100);
      });
      req.on('error', () => Date.now() > deadline ? reject(new Error(`health timeout\n${outputRef()}`)) : setTimeout(tick, 100));
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

test('Windows C# launcher exits independently while ServerHost owns bounded server shutdown', () => {
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.4-launcher30-csharp"/);
  assert.match(launcher, /RequestExit\(\)/);
  assert.match(launcher, /lock \(_exitSync\)/);
  assert.doesNotMatch(launcher, /SignalServerHostStop\(\)|WaitForProcessExit\(session\.hostPid|SystemEvents\.SessionEnding/);
  assert.doesNotMatch(launcher, /taskkill\.exe|TerminateJobObject|procTerminateProcess|Process\.Kill\(/);
  assert.match(host, /SystemEvents\.SessionEnding \+= OnSessionEnding/);
  assert.match(host, /OnSessionEnding[\s\S]*_stopEvent\.Set\(\)/);
  assert.match(host, /private void StopNode\(\)/);
  assert.match(host, /server\.WaitForExit\(6500\)/);
  assert.match(host, /server\.Kill\(\)/);
  assert.match(launcher, /Ui\(\(\) =>/);
});

test('server shutdown drains live streams, aborts connector jobs and bounds lingering sockets', () => {
  assert.match(server, /function closeLiveStreamsForShutdown\(\)/);
  assert.match(server, /liveActivityClients/);
  assert.match(server, /presenceClients/);
  assert.match(server, /inboxEventSubs\.clear\(\)/);
  assert.match(server, /controller\.abort\(\)/);
  assert.match(server, /waitForConnectorJobsToStop/);
  assert.match(server, /server\.closeIdleConnections/);
  assert.match(server, /server\.closeAllConnections/);
  assert.match(server, /shutdown hard deadline reached/);
  assert.match(server, /if \(shutdownPromise\) return shutdownPromise/);
});

test('private launcher shutdown exits cleanly even with a lingering TCP client and persists clean state', { timeout: 20000 }, async () => {
  const port = await freePort();
  const token = 'shutdown-audit-' + Math.random().toString(16).slice(2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-shutdown-audit-'));
  for (const name of ['data','inbox','images']) fs.mkdirSync(path.join(tmp, name));
  let output = '';
  const marker = path.join(tmp, 'data', '.clean-marker');
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT:String(port), BIND:'127.0.0.1',
      DATA_DIR:path.join(tmp,'data'), INBOX_DIR:path.join(tmp,'inbox'), IMAGES_DIR:path.join(tmp,'images'), HOST_ROOT:tmp,
      NO_COLOR:'1', UPDATE_CHECK:'0', DX_WINDOWS_LAUNCHER_TOKEN:token, DX_WINDOWS_SHUTDOWN_MARKER:marker,
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  try {
    await waitHealth(port, child, () => output);

    // Half-open client: server.close() alone can wait on this kind of connection.
    const lingering = net.createConnection({ host:'127.0.0.1', port });
    await new Promise((resolve, reject) => { lingering.once('connect', resolve); lingering.once('error', reject); });
    lingering.write('GET / HTTP/1.1\r\nHost: localhost\r\n'); // intentionally no terminating CRLFCRLF

    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname:'127.0.0.1', port, path:'/__dx_launcher/shutdown', method:'POST', headers:{'X-Direct-Xfer-Launcher-Token':token}, timeout:2000 }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('shutdown request timeout'))); req.end();
    });
    assert.equal(status, 202);

    const started = Date.now();
    const deadline = Date.now() + 3500;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    lingering.destroy();
    assert.equal(fs.existsSync(marker), true, `clean marker was not produced promptly\n${output}`);
    assert.ok(Date.now() - started < 3500, `clean shutdown state took too long: ${Date.now()-started} ms\n${output}`);
    assert.match(output, /shutting down \(windows-server-host\)/);
    const closedDeadline = Date.now() + 2000;
    while (!/server closed/.test(output) && Date.now() < closedDeadline) await new Promise(r => setTimeout(r, 25));
    assert.match(output, /server closed/);
    const rebound = net.createServer();
    await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => rebound.close(err => err ? reject(err) : resolve()));

    const storePath = path.join(tmp, 'data', 'shares.json');
    const state = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(state.meta?.notificationRuntime?.clean, true);
    assert.equal(state.meta?.notificationRuntime?.shutdownSignal, 'windows-server-host');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});
