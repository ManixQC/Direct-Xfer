'use strict';

// Integration tests for the added easy/medium features:
//   #2  absolute expiry date (expiresAt) on create + edit
//   #9  reception links that require a visitor name (recorded with the deposit)
//   #10 server-wide reception storage cap
//   #11 reject sniffed executables regardless of extension (blockExecutables)
//   #16 unauthenticated /healthz liveness probe
//   #18 emergency pause-all / resume-all of active links

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth;
let logs = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close((e) => e ? reject(e) : resolve(port)); });
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
function cookieFrom(res) { const raw = res.headers.get('set-cookie') || ''; const first = raw.split(';', 1)[0]; assert.match(first, /^[^=]+=.+$/); return first; }
async function bodyJson(res) { return res.json().catch(() => ({})); }
function adminHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) }); }
function jsonHeaders() { return { 'Content-Type': 'application/json' }; }

async function makeInbox(name, extra = {}) {
  const r = await adminFetch('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...extra }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}
async function uploadTo(token, name, buf, headers = {}) {
  return fetch(`${base}/u/${encodeURIComponent(token)}/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: buf,
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-additions-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'add-admin', ADMIN_PASSWORD: 'Additions-test-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'add-admin', password: 'Additions-test-2026!' }) });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie: cookieFrom(login), csrf: (await bodyJson(login)).csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('#16 /healthz answers 200 with version and uptime, without authentication', async () => {
  const res = await fetch(`${base}/healthz`, { cache: 'no-store' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const data = await bodyJson(res);
  assert.equal(data.ok, true);
  assert.equal(typeof data.version, 'string');
  assert.ok(Number.isFinite(data.uptime));
});

test('#2 a share can be created and edited with an absolute expiry timestamp', async () => {
  const at = Date.now() + 3 * 3600 * 1000; // +3h
  const inbox = await makeInbox('Absolute expiry inbox', { expiresAt: at });
  assert.ok(Math.abs(inbox.expiresAt - at) < 2000, 'create should honour expiresAt: ' + inbox.expiresAt + ' vs ' + at);

  const at2 = Date.now() + 10 * 3600 * 1000; // +10h
  const patched = await adminFetch('/api/shares/' + encodeURIComponent(inbox.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ expiresAt: at2 }) });
  assert.equal(patched.status, 200, JSON.stringify(await bodyJson(patched.clone())));
  assert.ok(Math.abs((await bodyJson(patched)).share.expiresAt - at2) < 2000, 'edit should honour expiresAt');
});

test('#9 a require-name reception link rejects nameless uploads and records the name', async () => {
  const inbox = await makeInbox('Named deposits', { requireSenderName: true });

  const nameless = await uploadTo(inbox.token, 'anon.txt', Buffer.from('no name here'));
  assert.equal(nameless.status, 400, JSON.stringify(await bodyJson(nameless.clone())));
  assert.equal((await bodyJson(nameless)).error, 'sender-required');

  const named = await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=report.txt&sender=${encodeURIComponent('Alice Example')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('signed report') });
  assert.equal(named.status, 200, JSON.stringify(await bodyJson(named.clone())));
  // The file lands directly (no per-sender subfolder — that's a separate toggle).
  const files = fs.readdirSync(path.join(root, 'inbox', 'Named deposits'));
  assert.ok(files.includes('report.txt'), 'named upload should be stored: ' + JSON.stringify(files));

  const hist = await adminFetch('/api/history');
  const records = (await bodyJson(hist)).history || [];
  assert.ok(records.some((r) => r.sender === 'Alice Example' && r.direction === 'up'), 'the deposit should record the visitor name: ' + JSON.stringify(records.map((r) => r.sender)));
});

test('#11 blockExecutables rejects a disguised executable but accepts a normal file', async () => {
  const inbox = await makeInbox('Exe-guard inbox', { blockExecutables: true });

  const mz = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0)]); // "MZ" PE header
  const blocked = await uploadTo(inbox.token, 'invoice.jpg', mz); // disguised as an image
  assert.equal(blocked.status, 415, JSON.stringify(await bodyJson(blocked.clone())));
  assert.equal((await bodyJson(blocked)).error, 'content-blocked');

  const ok = await uploadTo(inbox.token, 'notes.txt', Buffer.from('just some plain text, definitely not a binary'));
  assert.equal(ok.status, 200, JSON.stringify(await bodyJson(ok.clone())));
  const files = fs.readdirSync(path.join(root, 'inbox', 'Exe-guard inbox'));
  assert.ok(files.includes('notes.txt') && !files.some((n) => n.endsWith('.jpg')), 'only the safe file should remain: ' + JSON.stringify(files));
});

test('#10 the server-wide reception storage cap refuses uploads once the total is exceeded', async () => {
  // ~5 KB cap so two 4 KB files cross it. GB is fractional here.
  const capGb = 5000 / (1024 * 1024 * 1024);
  const set = await adminFetch('/api/settings', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ receptionStorageCapGB: capGb }) });
  assert.equal(set.status, 200, JSON.stringify(await bodyJson(set.clone())));

  const inbox = await makeInbox('Capped inbox');
  const chunk = Buffer.alloc(4000, 0x41);
  const first = await uploadTo(inbox.token, 'a.bin', chunk);
  assert.equal(first.status, 200, 'first upload fits under the cap: ' + JSON.stringify(await bodyJson(first.clone())));
  const second = await uploadTo(inbox.token, 'b.bin', chunk);
  assert.equal(second.status, 413, JSON.stringify(await bodyJson(second.clone())));
  assert.equal((await bodyJson(second)).error, 'storage-cap');

  // Lift the cap so it can't disturb the later pause-all test's uploads.
  const clear = await adminFetch('/api/settings', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ receptionStorageCapGB: 0 }) });
  assert.equal(clear.status, 200);
});

test('#2 editing with a duration alone clears a previously-set absolute expiry', async () => {
  // Regression: the edit modal must not force the old absolute date back on save.
  // When only a duration is sent (datetime field left empty), it wins.
  const inbox = await makeInbox('Expiry precedence', { expiresAt: Date.now() + 3 * 3600 * 1000 });
  assert.ok(inbox.expiresAt, 'precondition: an absolute expiry is set');

  const cleared = await adminFetch('/api/shares/' + encodeURIComponent(inbox.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ expiresInSeconds: 0 }) });
  assert.equal(cleared.status, 200, JSON.stringify(await bodyJson(cleared.clone())));
  assert.equal((await bodyJson(cleared)).share.expiresAt, null, 'a "Never" preset must clear the expiry, not keep the old date');

  // And an absolute date sent on its own still takes effect.
  const at = Date.now() + 5 * 3600 * 1000;
  const setAgain = await adminFetch('/api/shares/' + encodeURIComponent(inbox.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ expiresAt: at }) });
  assert.ok(Math.abs((await bodyJson(setAgain)).share.expiresAt - at) < 2000);
});

test('#18 resume-all preserves a link that was manually paused before the panic', async () => {
  const manual = await makeInbox('Manually paused');
  const active = await makeInbox('Active before panic');

  const pause = await adminFetch('/api/shares/' + encodeURIComponent(manual.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ disabled: true }) });
  assert.equal(pause.status, 200);

  await adminFetch('/api/shares/pause-all', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  await adminFetch('/api/shares/resume-all', { method: 'POST', headers: jsonHeaders(), body: '{}' });

  const shares = (await bodyJson(await adminFetch('/api/shares'))).shares || [];
  const m = shares.find((s) => s.id === manual.id);
  const a = shares.find((s) => s.id === active.id);
  assert.ok(m && m.disabled, 'the manually-paused link must stay paused after resume-all');
  assert.ok(a && !a.disabled, 'the panic-paused link must be resumed');
});

test('#18 pause-all suspends every active link and resume-all restores them', async () => {
  const a = await makeInbox('Panic A');
  const b = await makeInbox('Panic B');

  const paused = await adminFetch('/api/shares/pause-all', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  assert.equal(paused.status, 200);
  assert.ok((await bodyJson(paused)).paused >= 2, 'at least the two new links should be paused');

  // A paused reception link no longer accepts uploads (403 revoked).
  const blocked = await uploadTo(a.token, 'x.txt', Buffer.from('nope'));
  assert.equal(blocked.status, 403);

  const shares = (await bodyJson(await adminFetch('/api/shares'))).shares || [];
  assert.ok(shares.filter((s) => s.id === a.id || s.id === b.id).every((s) => s.disabled), 'both links should be marked disabled');

  const resumed = await adminFetch('/api/shares/resume-all', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  assert.equal(resumed.status, 200);
  assert.ok((await bodyJson(resumed)).resumed >= 2);
  const after = (await bodyJson(await adminFetch('/api/shares'))).shares || [];
  assert.ok(after.filter((s) => s.id === a.id || s.id === b.id).every((s) => !s.disabled), 'both links should be active again');
});
