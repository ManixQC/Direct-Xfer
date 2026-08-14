'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Windows launcher falls back to a free port and uses it consistently', () => {
  assert.match(launcher, /DefaultPort = 55750/);
  assert.match(launcher, /MaxFallbackPort = 55769/);
  assert.match(launcher, /ChooseRuntimePort\(\)/);
  assert.match(launcher, /new TcpListener\(IPAddress\.Any, port\)/);
  assert.match(launcher, /EnvironmentVariables\["PORT"\] = _runtimePort/);
  assert.match(launcher, /TryReady\(_runtimePort, _token/);
  assert.match(launcher, /LauncherRequestAnyScheme\("POST", _runtimePort, "\/__dx_launcher\/shutdown"/);
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.1-launcher27-csharp"/);
  assert.match(launcher, /PortFallback/);
});

test('server bind failure is explicit and cannot masquerade as exit code 0', async () => {
  assert.match(serverSrc, /server\.on\('error'/);
  assert.match(serverSrc, /server error on/);
  assert.match(serverSrc, /process\.exitCode = 1/);
  assert.match(serverSrc, /process\.exit\(1\)/);

  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  const port = address.port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-bind-test-'));
  for (const name of ['data', 'inbox', 'images']) fs.mkdirSync(path.join(tmp, name));

  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      DATA_DIR: path.join(tmp, 'data'),
      INBOX_DIR: path.join(tmp, 'inbox'),
      IMAGES_DIR: path.join(tmp, 'images'),
      HOST_ROOT: tmp,
      NO_COLOR: '1',
      UPDATE_CHECK: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('bind failure did not terminate server')), 6000)),
  ]);
  blocker.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.equal(code, 1, output);
  assert.match(output, /server error on .*EADDRINUSE/);
});
