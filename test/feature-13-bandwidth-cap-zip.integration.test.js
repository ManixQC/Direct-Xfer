'use strict';

// Feature 13 — total-bytes-served bandwidth cap. Regression test for the bug where
// ZIP downloads (folder `/s/:token/zip` and collection `/s/:token/all.zip`) served
// bytes WITHOUT calling noteBytesServed(), so the cap never accrued and could be
// bypassed entirely by downloading as a ZIP. Also checks the cap auto-revokes the
// share once crossed, on the ZIP path itself.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth, logs = '';

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
    try { const res = await fetch(url, { cache: 'no-store' }); if (res.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';', 1)[0];
}
async function bodyJson(res) { return res.json().catch(() => ({})); }
function adminHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) }); }

async function findShare(id) {
  const list = await adminFetch('/api/shares');
  const shares = (await bodyJson(list)).shares || [];
  return shares.find((x) => x.id === id) || null;
}
// The bytes are recorded in the response's 'finish' handler, which runs just after
// the client finishes reading the body — poll briefly for it.
async function waitForBytesServed(id, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  let s = null;
  do {
    s = await findShare(id);
    if (s && s.bytesServed > 0) return s;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < end);
  return s;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-f13-'));
  for (const dir of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'capped.txt'), 'x'.repeat(2048));
  fs.mkdirSync(path.join(root, 'host', 'cappeddir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'cappeddir', 'inner.txt'), 'y'.repeat(2048));

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'cap-admin', ADMIN_PASSWORD: 'Cap-test-password-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cap-admin', password: 'Cap-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie: cookieFrom(login), csrf: (await bodyJson(login)).csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('collection all.zip counts served bytes toward the cap and auto-revokes', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/capped.txt', maxBytesServed: 1 }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;
  assert.equal(share.maxBytesServed, 1, 'cap should persist');

  const zip1 = await fetch(`${base}/s/${share.token}/all.zip`);
  assert.equal(zip1.status, 200, 'first ZIP download allowed (cap not yet crossed)');
  const buf = Buffer.from(await zip1.arrayBuffer());
  assert.ok(buf.length > 1, 'ZIP should actually contain data');

  const after1 = await waitForBytesServed(share.id);
  assert.ok(after1 && after1.bytesServed > 1, `ZIP bytes must accrue to bytesServed, got ${JSON.stringify(after1 && after1.bytesServed)}`);

  const zip2 = await fetch(`${base}/s/${share.token}/all.zip`);
  assert.equal(zip2.status, 404, 'cap crossed → share auto-revoked → second ZIP refused');
});

test('folder /zip counts served bytes toward the cap and auto-revokes', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/cappeddir', maxBytesServed: 1 }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;
  assert.equal(share.type, 'folder');

  const zip1 = await fetch(`${base}/s/${share.token}/zip`);
  assert.equal(zip1.status, 200, 'first folder ZIP allowed');
  const buf = Buffer.from(await zip1.arrayBuffer());
  assert.ok(buf.length > 1, 'folder ZIP should contain data');

  const after1 = await waitForBytesServed(share.id);
  assert.ok(after1 && after1.bytesServed > 1, `folder ZIP bytes must accrue, got ${JSON.stringify(after1 && after1.bytesServed)}`);

  const zip2 = await fetch(`${base}/s/${share.token}/zip`);
  assert.equal(zip2.status, 404, 'cap crossed → folder share auto-revoked → second ZIP refused');
});
