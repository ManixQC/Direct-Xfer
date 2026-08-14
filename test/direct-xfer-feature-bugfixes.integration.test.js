'use strict';

// Regression tests for two bugs found in the latest Direct-Xfer "difficult"
// features:
//   * Feature 27 (universal search): a query that produces no [a-z0-9] index
//     tokens (e.g. CJK / Cyrillic scripts) returned EVERY accessible document as
//     a false-positive match instead of doing an honest substring match.
//   * Feature 25 (ransomware guard): the block record was stored under the raw
//     client IP but looked up after stripping the "::ffff:" IPv4-mapped-IPv6
//     prefix, so a client presenting an "::ffff:x.x.x.x" address was never
//     actually blocked once the threshold was crossed.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child;
let base;
let root;
let logs = '';
let auth;

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

async function bodyJson(res) { return res.json().catch(() => ({})); }
function adminHeaders(extra = {}) {
  return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra };
}
async function adminFetch(url, opts = {}) {
  return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) });
}

async function reindexAndWait() {
  const reindex = await adminFetch('/api/search/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(reindex.status, 202, JSON.stringify(await bodyJson(reindex.clone())));
  const deadline = Date.now() + 10000;
  let status = null;
  do {
    const r = await adminFetch('/api/search/status');
    status = await bodyJson(r);
    if (!status.building && status.builtAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.ok(status && !status.building && status.builtAt, JSON.stringify(status));
  return status;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-bugfix-'));
  for (const dir of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'latin-note.txt'), 'A perfectly ordinary latin document about invoices.\n');
  fs.writeFileSync(path.join(root, 'host', 'cjk-note.txt'), 'Marker latinword. 契約書の秘密メモ CobaltMarigold.\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      TRUST_PROXY: '1',
      ADMIN_USERNAME: 'bugfix-admin',
      ADMIN_PASSWORD: 'Bugfix-test-password-2026!',
      DATA_DIR: path.join(root, 'data'),
      HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'),
      IMAGES_DIR: path.join(root, 'images'),
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
    body: JSON.stringify({ username: 'bugfix-admin', password: 'Bugfix-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  const loginData = await bodyJson(login);
  auth = { cookie: cookieFrom(login), csrf: loginData.csrf };
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
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('feature 27 does not return every document for a non-latin query with no index tokens', async () => {
  for (const file of ['/latin-note.txt', '/cjk-note.txt']) {
    const create = await adminFetch('/api/shares', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file }),
    });
    assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  }
  await reindexAndWait();

  // A CJK query that is present in NO document must not match anything.
  const miss = await adminFetch('/api/search?q=' + encodeURIComponent('存在しない'));
  assert.equal(miss.status, 200, JSON.stringify(await bodyJson(miss.clone())));
  const missData = await bodyJson(miss);
  assert.equal(missData.results.length, 0, 'a non-matching non-latin query must not return documents: ' + JSON.stringify(missData.results.map((r) => r.file)));

  // A CJK substring that IS present in one document must still be found.
  const hit = await adminFetch('/api/search?q=' + encodeURIComponent('契約'));
  assert.equal(hit.status, 200);
  const hitData = await bodyJson(hit);
  assert.ok(hitData.results.some((r) => r.file === 'cjk-note.txt'), 'CJK substring present in a document should be findable: ' + JSON.stringify(hitData.results.map((r) => r.file)));
  assert.ok(!hitData.results.some((r) => r.file === 'latin-note.txt'), 'the latin-only document must not match a CJK query');
});

test('feature 25 blocks a burst arriving from an ::ffff: IPv4-mapped IPv6 address', async () => {
  const settings = await adminFetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ransomwareProtection: true, ransomwareUploadThreshold: 20, ransomwareBlockMinutes: 2 }),
  });
  assert.equal(settings.status, 200, JSON.stringify(await bodyJson(settings.clone())));

  const created = await adminFetch('/api/inbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mapped IPv6 inbox' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await bodyJson(created.clone())));
  const inbox = (await bodyJson(created)).share;
  assert.ok(inbox && inbox.token);

  const attackerIp = '::ffff:198.51.100.9';
  for (let i = 0; i < 20; i++) {
    const up = await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=${encodeURIComponent(`doc-${i}.locked`)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': attackerIp }, body: Buffer.from(`payload ${i}`),
    });
    assert.equal(up.status, 200, `upload ${i}: ${JSON.stringify(await bodyJson(up.clone()))}`);
  }

  const blocked = await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=blocked.locked`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': attackerIp }, body: Buffer.from('blocked'),
  });
  assert.equal(blocked.status, 423, 'the mapped-IPv6 client must be blocked once the burst threshold is crossed');
  const blockedData = await bodyJson(blocked);
  assert.equal(blockedData.reason, 'suspicious-upload-burst');

  // The admin view and the unblock route must key on the same normalized IP.
  const anomaly = await adminFetch('/api/security/anomalies');
  const anomalyData = await bodyJson(anomaly);
  assert.ok(anomalyData.blocks.some((b) => b.ip === '198.51.100.9'), 'block should be recorded under the normalized IP: ' + JSON.stringify(anomalyData.blocks));

  const unblocked = await adminFetch('/api/security/anomalies/unblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: '198.51.100.9' }),
  });
  assert.equal((await bodyJson(unblocked)).unblocked, true);
});
