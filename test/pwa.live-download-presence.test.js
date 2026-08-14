'use strict';
// Feature 20 — live "downloading now" presence. A download in progress must be
// reflected, per link, in the snapshot endpoint and pushed over SSE; both the
// standard admin (/api) and the paired PWA (/app) surfaces must see it, and the
// count must return to zero once the download ends.
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const standardApp = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const standardCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const pwaApp = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let child, base, tempRoot, logs = '';
const ADMIN_USER = 'presence-admin';
const ADMIN_PASS = 'Presence-runtime-2026!';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((err) => err ? reject(err) : resolve(port)); });
  });
}
async function waitForServer(url) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
async function json(response) { return response.json().catch(() => ({})); }
function firstCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';', 1)[0];
}
function pwaCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const m = raw.match(/(?:^|,\s*)(dxpwa=[^;]+)/);
  return m ? m[1] : firstCookie(response);
}
async function presence(cookie, prefix) {
  const r = await fetch(`${base}${prefix}/shares/presence`, { headers: { Cookie: cookie }, cache: 'no-store' });
  return { status: r.status, body: await json(r) };
}
async function pollPresence(cookie, prefix, shareId, want) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const p = await presence(cookie, prefix);
    if (p.status === 200 && (Number(p.body.counts && p.body.counts[shareId]) || 0) === want) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-presence-'));
  for (const n of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, n), { recursive: true });
  // A file big enough that the server cannot flush it all before we observe the
  // in-progress download (the test client deliberately stops reading the body).
  fs.writeFileSync(path.join(tempRoot, 'host', 'big.bin'), Buffer.alloc(24 * 1024 * 1024, 7));
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS,
      DATA_DIR: path.join(tempRoot, 'data'), HOST_ROOT: path.join(tempRoot, 'host'), INBOX_DIR: path.join(tempRoot, 'inbox'),
      IMAGES_DIR: path.join(tempRoot, 'images'), UPDATE_CHECK: 'false', PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
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

test('a download in progress is reflected per-link on /api and /app presence, then clears', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(login.status, 200, logs);
  const adminCookie = firstCookie(login);
  const csrf = (await json(login)).csrf;
  assert.ok(csrf);

  // Create a share for the big file.
  const create = await fetch(`${base}/api/shares`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: adminCookie, Origin: base },
    body: JSON.stringify({ path: 'big.bin', dlpOverride: true }),
  });
  assert.equal(create.status, 201, JSON.stringify(await json(create.clone())) + logs);
  const share = (await json(create)).share;
  assert.ok(share && share.id && share.token);

  // Pair a PWA device so the /app presence surface can be checked too.
  const register = await fetch(`${base}/app/device/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: adminCookie, Origin: base },
    body: JSON.stringify({ name: 'Presence test device' }),
  });
  assert.equal(register.status, 200, logs);
  const deviceCookie = pwaCookie(register);

  // Baseline: nothing downloading.
  const base0 = await presence(adminCookie, '/api');
  assert.equal(base0.status, 200);
  assert.equal(Number(base0.body.counts && base0.body.counts[share.id]) || 0, 0);
  const app0 = await presence(deviceCookie, '/app');
  assert.equal(app0.status, 200, JSON.stringify(app0.body));

  // Start a public download but stop reading the body so it stays in flight.
  const ac = new AbortController();
  const dl = await fetch(`${base}/s/${share.token}/download`, { signal: ac.signal });
  assert.equal(dl.status, 200, logs);
  const reader = dl.body.getReader();
  await reader.read(); // ensure streaming has actually started

  try {
    assert.ok(await pollPresence(adminCookie, '/api', share.id, 1), 'admin presence should show 1 in progress\n' + logs);
    assert.ok(await pollPresence(deviceCookie, '/app', share.id, 1), 'PWA presence should show 1 in progress');

    // SSE: the stream must deliver a presence event with the same count.
    const sse = await fetch(`${base}/api/shares/presence/stream`, { headers: { Cookie: adminCookie, Accept: 'text/event-stream' } });
    assert.equal(sse.status, 200);
    const sseReader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = '', gotCount = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && gotCount == null) {
      const { value, done } = await sseReader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const frame of frames) {
        if (!/event: presence/.test(frame)) continue;
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (line) { try { const d = JSON.parse(line.slice(5).trim()); gotCount = Number(d.counts && d.counts[share.id]) || 0; } catch (_) {} }
      }
    }
    try { await sseReader.cancel(); } catch (_) {}
    assert.equal(gotCount, 1, 'SSE presence event should report 1 in progress');
  } finally {
    ac.abort();
    try { await reader.cancel(); } catch (_) {}
  }

  // After the download ends, the count returns to zero.
  assert.ok(await pollPresence(adminCookie, '/api', share.id, 0), 'presence should clear after the download ends\n' + logs);
});

test('presence requires authentication', async () => {
  const anon = await fetch(`${base}/api/shares/presence`, { cache: 'no-store' });
  assert.equal(anon.status, 401);
  // requireAppAuth rejects a fully anonymous /app request up front with 401 (the
  // route's own 403 is reserved for an authenticated but non-admin principal).
  const anonApp = await fetch(`${base}/app/shares/presence`, { cache: 'no-store' });
  assert.equal(anonApp.status, 401);
});

test('standard and PWA interfaces render authoritative SSE presence badges', () => {
  assert.match(standardApp, /new EventSource\('\/api\/shares\/presence\/stream'/);
  assert.match(standardApp, /data-share-id/);
  assert.match(standardApp, /function applySharePresence\(\)/);
  assert.match(standardApp, /download-presence-badge/);
  assert.match(standardCss, /\.badge\.download-presence-badge/);
  assert.match(pwaApp, /new EventSource\('\/app\/shares\/presence\/stream'/);
  assert.match(pwaApp, /presenceCounts/);
  assert.match(serverSource, /function pwaPresenceValidator\(req, scope\)/);
  assert.match(serverSource, /sessionLockedAt/);
});
