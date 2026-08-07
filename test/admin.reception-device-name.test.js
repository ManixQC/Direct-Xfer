'use strict';

// A reception link created from a paired mobile companion must expose, in the
// regular admin shares list, the CURRENT name of the device that created it —
// so an in-app device rename is reflected live on the admin card.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child;
let base;
let tempRoot;
let logs = '';

const ADMIN_USER = 'device-admin';
const ADMIN_PASS = 'Device-name-test-2026!';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const first = raw.split(';', 1)[0];
  assert.match(first, /^[^=]+=.+$/, `missing cookie in ${raw}`);
  return first;
}

async function json(response) {
  return response.json().catch(() => ({}));
}

async function adminLogin() {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  return { cookie: cookieFrom(login), csrf: (await json(login)).csrf };
}

async function adminShares(cookie) {
  const res = await fetch(`${base}/api/shares`, { headers: { Cookie: cookie, Accept: 'application/json' } });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  return (await json(res)).shares || [];
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-device-name-'));
  for (const name of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, name), { recursive: true });

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      ADMIN_USERNAME: ADMIN_USER,
      ADMIN_PASSWORD: ADMIN_PASS,
      DATA_DIR: path.join(tempRoot, 'data'),
      HOST_ROOT: path.join(tempRoot, 'host'),
      INBOX_DIR: path.join(tempRoot, 'inbox'),
      IMAGES_DIR: path.join(tempRoot, 'images'),
      UPDATE_CHECK: 'false',
      PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  await waitForServer(`${base}/api/meta`);
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a device-created reception link shows the current device name in the admin list, live across renames', async () => {
  const admin = await adminLogin();

  // Pair a companion device with an explicit, human name.
  const register = await fetch(`${base}/app/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': admin.csrf, Cookie: admin.cookie, Origin: base },
    body: JSON.stringify({ name: 'Tablette cuisine' }),
  });
  assert.equal(register.status, 200, JSON.stringify(await json(register.clone())));
  const deviceCookie = cookieFrom(register);

  // Read the device's own CSRF token (no admin session on this cookie).
  const status = await json(await fetch(`${base}/app/device/status`, { headers: { Cookie: deviceCookie } }));
  assert.equal(status.paired, true);
  const deviceCsrf = status.csrf;
  assert.ok(deviceCsrf);

  // Create a reception link FROM the device.
  const created = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceCsrf, Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ name: 'Photos vacances' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  const token = (await json(created)).token;
  assert.ok(token);

  // The regular admin shares list carries the device name, distinct from the
  // owning account (ownerName), and scoped to the inbox object.
  let shares = await adminShares(admin.cookie);
  let link = shares.find((s) => s.token === token);
  assert.ok(link, 'device-created reception link must appear in the admin list');
  assert.equal(link.type, 'inbox');
  assert.ok(link.inbox, 'inbox details must be decorated');
  assert.equal(link.inbox.deviceName, 'Tablette cuisine');
  assert.equal(link.ownerName, ADMIN_USER, 'ownerName tracks the account, not the device');

  // Renaming the device in the companion app updates the admin card live,
  // because the name is resolved from ownerDeviceId, not snapshotted.
  const renamed = await fetch(`${base}/app/device/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceCsrf, Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ name: 'iPad de Francis' }),
  });
  assert.equal(renamed.status, 200, JSON.stringify(await json(renamed.clone())));

  shares = await adminShares(admin.cookie);
  link = shares.find((s) => s.token === token);
  assert.ok(link);
  assert.equal(link.inbox.deviceName, 'iPad de Francis', 'admin list must reflect the live device name');
});

test('a reception link created from the browser admin has no device name', async () => {
  const admin = await adminLogin();

  const created = await fetch(`${base}/api/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': admin.csrf, Cookie: admin.cookie, Origin: base },
    body: JSON.stringify({ name: 'Dépôt navigateur' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  const token = (await json(created)).share.token;

  const shares = await adminShares(admin.cookie);
  const link = shares.find((s) => s.token === token);
  assert.ok(link);
  assert.equal(link.inbox.deviceName, null, 'a browser-created link is not attributed to any device');
});
