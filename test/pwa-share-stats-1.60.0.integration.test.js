'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, tempRoot, logs = '';
let adminCookie, adminCsrf, deviceCookie;
let createdShare;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
async function waitForServer(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/(?:^|,\s*)((?:dxpwa|dxsession)=[^;]+)/);
  const cookie = match ? match[1] : raw.split(';', 1)[0];
  assert.match(cookie, /^[^=]+=.+$/, `missing cookie in ${raw}`);
  return cookie;
}
async function body(response) { return response.json().catch(() => ({})); }

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-pwa-stats160-'));
  for (const name of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, name), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'host', 'stats-sample.txt'), 'Direct-Xfer stats integration test\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      ADMIN_USERNAME: 'stats-admin',
      ADMIN_PASSWORD: 'Stats-test-2026!',
      DATA_DIR: path.join(tempRoot, 'data'),
      HOST_ROOT: path.join(tempRoot, 'host'),
      INBOX_DIR: path.join(tempRoot, 'inbox'),
      IMAGES_DIR: path.join(tempRoot, 'images'),
      UPDATE_CHECK: 'false',
      PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'stats-admin', password: 'Stats-test-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await body(login.clone())));
  adminCookie = cookieFrom(login);
  adminCsrf = (await body(login)).csrf;
  assert.ok(adminCsrf);

  const register = await fetch(`${base}/app/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': adminCsrf, Cookie: adminCookie, Origin: base },
    body: JSON.stringify({ name: 'Stats paired tablet' }),
  });
  assert.equal(register.status, 200, JSON.stringify(await body(register.clone())));
  deviceCookie = cookieFrom(register);
  assert.match(deviceCookie, /^dxpwa=/);

  const create = await fetch(`${base}/app/host/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': adminCsrf, Cookie: adminCookie, Origin: base },
    body: JSON.stringify({ paths: ['/stats-sample.txt'], expiresInSeconds: 1, maxDownloads: 3 }),
  });
  assert.equal(create.status, 201, JSON.stringify(await body(create.clone())));
  createdShare = (await body(create)).share;
  assert.ok(createdShare && createdShare.id && createdShare.token);
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('paired-device PWA stats works without a live admin browser session and matches standard payload', async () => {
  const standard = await fetch(`${base}/api/shares/${encodeURIComponent(createdShare.id)}/stats-detail`, {
    headers: { Cookie: adminCookie }, cache: 'no-store',
  });
  assert.equal(standard.status, 200, JSON.stringify(await body(standard.clone())));
  const standardData = await body(standard);

  const pwa = await fetch(`${base}/app/host/shares/${encodeURIComponent(createdShare.token)}/stats-detail`, {
    headers: { Cookie: deviceCookie }, cache: 'no-store',
  });
  assert.equal(pwa.status, 200, JSON.stringify(await body(pwa.clone())));
  assert.equal(pwa.headers.get('cache-control'), 'no-store');
  const pwaData = await body(pwa);

  for (const key of ['id', 'name', 'type', 'status', 'effectiveExpiresAt', 'itemCount', 'logicalBytes', 'downloads']) {
    assert.deepEqual(pwaData.share[key], standardData.share[key], `share.${key}`);
  }
  for (const key of ['count', 'bytes', 'completed', 'interrupted', 'successRate']) {
    assert.deepEqual(pwaData.aggregate[key], standardData.aggregate[key], `aggregate.${key}`);
  }
  assert.ok(Number(pwaData.share.effectiveExpiresAt) > Date.now());
  assert.deepEqual(pwaData.quota, [{ kind: 'downloads', used: 0, max: 3 }]);
});

test('1.62.2 detailed stats accepts 24h, 7d and lifetime periods in standard and PWA routes', async () => {
  for (const period of ['1', '7', 'all']) {
    const standard = await fetch(`${base}/api/shares/${encodeURIComponent(createdShare.id)}/stats-detail?period=${period}`, { headers: { Cookie: adminCookie }, cache: 'no-store' });
    const pwa = await fetch(`${base}/app/host/shares/${encodeURIComponent(createdShare.token)}/stats-detail?period=${period}`, { headers: { Cookie: deviceCookie }, cache: 'no-store' });
    assert.equal(standard.status, 200); assert.equal(pwa.status, 200);
    const a = await body(standard), b = await body(pwa);
    assert.equal(a.period.days, period === 'all' ? 0 : Number(period));
    assert.equal(b.period.days, a.period.days);
    assert.equal(b.period.granularity, a.period.granularity);
    if (period === '1') assert.equal(a.timeline.length, 24);
    assert.deepEqual(b.comparison, a.comparison);
    assert.ok(Array.isArray(a.failureReasons));
  }
});

test('detailed stats reports the effective expiry as expired once the link actually expires', async () => {
  const waitMs = Math.max(0, Number(createdShare.effectiveExpiresAt || createdShare.expiresAt) - Date.now() + 150);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const pwa = await fetch(`${base}/app/host/shares/${encodeURIComponent(createdShare.token)}/stats-detail`, {
    headers: { Cookie: deviceCookie }, cache: 'no-store',
  });
  assert.equal(pwa.status, 200, JSON.stringify(await body(pwa.clone())));
  const data = await body(pwa);
  assert.equal(data.share.status, 'expired');
  assert.equal(data.share.active, false);
  assert.equal(data.share.effectiveExpiresAt, createdShare.effectiveExpiresAt || createdShare.expiresAt);
});

test('anonymous clients cannot read PWA management statistics', async () => {
  const response = await fetch(`${base}/app/host/shares/${encodeURIComponent(createdShare.token)}/stats-detail`, { cache: 'no-store' });
  assert.equal(response.status, 401);
});
