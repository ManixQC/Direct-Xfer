'use strict';

// Regression: PWA image-retention rules are owner-scoped. A paired device's images
// are account-owned (ownerId = the account that paired the device), so the retention
// owner key derived from a request must resolve to that SAME account — otherwise, in
// the common device-only state (admin session expired, device still paired), the
// retention page reports "0 images" and the rules never enforce.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, tempRoot, logs = '';
const ADMIN_USER = 'retention-admin';
const ADMIN_PASS = 'Retention-test-2026!';
// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => e ? reject(e) : resolve(port)); });
  });
}
async function waitForServer(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try { const res = await fetch(url, { cache: 'no-store' }); if (res.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const first = raw.split(';', 1)[0];
  assert.match(first, /^[^=]+=.+$/, `missing cookie in ${raw}`);
  return first;
}
const json = (r) => r.json().catch(() => ({}));

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-retention-'));
  for (const n of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, n), { recursive: true });
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), BIND: '127.0.0.1',
      ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS,
      DATA_DIR: path.join(tempRoot, 'data'), HOST_ROOT: path.join(tempRoot, 'host'),
      INBOX_DIR: path.join(tempRoot, 'inbox'), IMAGES_DIR: path.join(tempRoot, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  await waitForServer(`${base}/api/meta`);
});
after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('retention rules on a paired device resolve to the account that owns its images', async () => {
  // Admin login (session) + pair a device (account-linked).
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const sessionCookie = cookieFrom(login);
  const sessionCsrf = (await json(login)).csrf;

  const register = await fetch(`${base}/app/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionCsrf, Cookie: sessionCookie, Origin: base },
    body: JSON.stringify({ name: 'Retention phone' }),
  });
  assert.equal(register.status, 200, JSON.stringify(await json(register.clone())));
  const deviceCookie = cookieFrom(register);
  const deviceCsrf = (await json(await fetch(`${base}/app/device/status`, { headers: { Cookie: deviceCookie } }))).csrf;
  assert.ok(deviceCsrf);

  // Upload an image FROM the device only (no admin session cookie) — this is how an
  // installed PWA works day-to-day. The image is account-owned (ownerId set).
  const upload = await fetch(`${base}/app/image?name=holiday.png`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': deviceCsrf, Cookie: deviceCookie, Origin: base },
    body: PNG,
  });
  assert.equal(upload.status, 201, JSON.stringify(await json(upload.clone())));

  // The retention page, opened with ONLY the device cookie, must see that image.
  const deviceView = await json(await fetch(`${base}/app/images/retention`, { headers: { Cookie: deviceCookie } }));
  assert.ok(deviceView.summary, 'retention response must carry a summary');
  assert.equal(deviceView.summary.images, 1, 'device-only retention view must count the device\'s account-owned image');

  // And enforcing a rule from the device-only context must actually target it.
  const enforce = await fetch(`${base}/app/images/retention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceCsrf, Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ enabled: true, maxStorageMB: 0.0000001, runNow: true }),
  });
  assert.equal(enforce.status, 200, JSON.stringify(await json(enforce.clone())));
  const result = (await json(enforce)).result || {};
  assert.equal(result.checked, 1, 'enforcement must consider the device\'s image');
  assert.equal(result.revoked, 1, 'a storage cap below the image size must revoke it');
});
