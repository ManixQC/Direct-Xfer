'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const project = path.resolve(__dirname, '..');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitReady(base, child, logs) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs()}`);
    try {
      const r = await fetch(base + '/api/meta');
      if (r.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${logs()}`);
}

test('Windows launcher receives a freshly generated admin password exactly once and it remains valid', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-first-pw-'));
  const dirs = Object.fromEntries(['data', 'host', 'inbox', 'images'].map(n => [n, path.join(root, n)]));
  Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
  const port = await freePort();
  const token = 'launcher-test-' + Math.random().toString(36).slice(2);
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const env = {
    ...process.env,
    PORT: String(port),
    BIND: '127.0.0.1',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: '',
    DATA_DIR: dirs.data,
    HOST_ROOT: dirs.host,
    INBOX_DIR: dirs.inbox,
    IMAGES_DIR: dirs.images,
    UPDATE_CHECK: 'false',
    SEARCH_OCR_ENABLED: 'false',
    DX_WINDOWS_LAUNCHER_TOKEN: token,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  await waitReady(base, child, () => output);

  const wrong = await fetch(base + '/__dx_launcher/initial-admin-password', {
    method: 'POST', headers: { 'X-Direct-Xfer-Launcher-Token': token + '-wrong' },
  });
  assert.equal(wrong.status, 404);

  const first = await fetch(base + '/__dx_launcher/initial-admin-password', {
    method: 'POST', headers: { 'X-Direct-Xfer-Launcher-Token': token },
  });
  assert.equal(first.status, 200, output);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const payload = await first.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.fresh, true);
  assert.equal(payload.username, 'admin');
  assert.equal(typeof payload.password, 'string');
  assert.ok(payload.password.length >= 12);

  const second = await fetch(base + '/__dx_launcher/initial-admin-password', {
    method: 'POST', headers: { 'X-Direct-Xfer-Launcher-Token': token },
  });
  assert.equal(second.status, 204);

  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: payload.username, password: payload.password }),
  });
  assert.equal(login.status, 200, output);

  const persisted = fs.readFileSync(path.join(dirs.data, 'shares.json'), 'utf8');
  assert.equal(persisted.includes(payload.password), false, 'plaintext password must never be persisted');
  assert.match(persisted, /scrypt\$/);
  assert.equal(output.includes(payload.password), false, 'Windows launcher log must not contain the plaintext password');
});

test('launcher source displays the one-time password before opening the browser', () => {
  const src = fs.readFileSync(path.join(project, 'windows-launcher', 'Program.cs'), 'utf8');
  assert.match(src, /RuntimeAppBuild = "1\.59\.8-launcher34-csharp"/);
  assert.match(src, /ShowInitialAdminPassword\(\)/);
  assert.match(src, /__dx_launcher\/initial-admin-password/);
  assert.match(src, /ShowInitialAdminPassword\(\);[\s\S]*OpenBrowser\(\)/);
  assert.match(src, /InitialPasswordForm/);
});
