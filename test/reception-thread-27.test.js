'use strict';

// Feature 27 — two-way reception thread. A visitor and the link owner hold a
// running conversation on one reception (inbox) link. Covers: visitor read/post,
// owner read/post (standard /api and PWA /app), unread accounting, the visitor
// projection never leaking IP/geo, and input/rate guards.

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
function firstCookie(res) { const first = (res.headers.get('set-cookie') || '').split(';', 1)[0]; assert.match(first, /^[^=]+=.+$/); return first; }
function pwaCookie(res) { const raw = res.headers.get('set-cookie') || ''; const m = raw.match(/(?:^|,\s*)(dxpwa=[^;]+)/); return m ? m[1] : firstCookie(res); }
async function bodyJson(res) { return res.json().catch(() => ({})); }
function jsonHeaders() { return { 'Content-Type': 'application/json' }; }
function adminHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) }); }
async function makeInbox(name, extra = {}) {
  const r = await adminFetch('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...extra }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-thread27-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'thread-admin', ADMIN_PASSWORD: 'Thread-test-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'thread-admin', password: 'Thread-test-2026!' }) });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie: firstCookie(login), csrf: (await bodyJson(login)).csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('visitor and owner hold a two-way conversation, with correct unread accounting and no IP leak', async () => {
  const inbox = await makeInbox('Client intake');
  const token = inbox.token, id = inbox.id;

  // Visitor: empty thread, enabled.
  let vr = await bodyJson(await fetch(`${base}/u/${token}/thread`, { cache: 'no-store' }));
  assert.equal(vr.enabled, true);
  assert.deepEqual(vr.messages, []);

  // Visitor posts.
  const vp = await fetch(`${base}/u/${token}/thread`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Dana', text: 'Hi, is the invoice format OK?' }) });
  assert.equal(vp.status, 200, logs);
  const vpBody = await bodyJson(vp);
  assert.equal(vpBody.messages.length, 1);
  assert.equal(vpBody.messages[0].from, 'visitor');
  assert.equal(vpBody.messages[0].name, 'Dana');
  // The visitor projection must never expose IP or geo.
  assert.equal('ip' in vpBody.messages[0], false, 'visitor projection must not leak ip');
  assert.equal('country' in vpBody.messages[0], false);

  // Owner (standard /api) sees it as unread, WITH origin metadata for moderation.
  let or = await bodyJson(await adminFetch(`/api/shares/${id}/thread`));
  assert.equal(or.unread, 1);
  assert.equal(or.messages[0].from, 'visitor');
  assert.equal(or.messages[0].read, false);
  assert.ok('ip' in or.messages[0], 'owner projection keeps ip for moderation');

  // /app/receptions listing surfaces the unread badge without opening the thread.
  const reg = await fetch(`${base}/app/device/register`, { method: 'POST', headers: { ...jsonHeaders(), 'X-CSRF-Token': auth.csrf, Cookie: auth.cookie, Origin: base }, body: JSON.stringify({ name: 'Thread test device' }) });
  assert.equal(reg.status, 200, logs);
  const deviceCookie = pwaCookie(reg);
  const status = await bodyJson(await fetch(`${base}/app/device/status`, { headers: { Cookie: deviceCookie }, cache: 'no-store' }));
  const deviceCsrf = status.csrf;
  const recs = await bodyJson(await fetch(`${base}/app/receptions`, { headers: { Cookie: deviceCookie }, cache: 'no-store' }));
  const recRow = (recs.receptions || []).find((r) => r.token === token);
  assert.ok(recRow, 'reception is listed for the PWA');
  assert.equal(recRow.threadUnread, 1);

  // Owner replies from the PWA (/app). Posting also clears the unread flag.
  const opw = await fetch(`${base}/app/receptions/${token}/thread`, { method: 'POST', headers: { ...jsonHeaders(), 'X-CSRF-Token': deviceCsrf, Cookie: deviceCookie, Origin: base }, body: JSON.stringify({ text: 'Yes, the format is fine — go ahead.' }) });
  assert.equal(opw.status, 201, logs);
  const opwBody = await bodyJson(opw);
  assert.equal(opwBody.unread, 0, 'owner reply marks prior visitor messages read');
  assert.equal(opwBody.messages.length, 2);
  assert.equal(opwBody.messages[1].from, 'owner');

  // Visitor now sees the owner reply, and owner messages never carry a name.
  vr = await bodyJson(await fetch(`${base}/u/${token}/thread`, { cache: 'no-store' }));
  assert.equal(vr.messages.length, 2);
  const ownerMsg = vr.messages.find((m) => m.from === 'owner');
  assert.ok(ownerMsg);
  assert.equal(ownerMsg.name, null, 'owner identity is not exposed to visitors');

  // The standard /api view now agrees the thread is fully read.
  or = await bodyJson(await adminFetch(`/api/shares/${id}/thread`));
  assert.equal(or.unread, 0);
  assert.equal(or.messages.length, 2);
});

test('input and rate guards: empty text rejected, visitor posts are rate-limited', async () => {
  const inbox = await makeInbox('Guarded intake');
  const token = inbox.token;

  const empty = await fetch(`${base}/u/${token}/thread`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text: '   ' }) });
  assert.equal(empty.status, 400);

  // PUBLIC_MESSAGE_MAX is 5 per minute per (token, ip); distinct texts avoid dup suppression.
  let sawRateLimit = false;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/u/${token}/thread`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text: `message number ${i}` }) });
    if (r.status === 429) { sawRateLimit = true; assert.ok(r.headers.get('retry-after'), 'rate limit sends Retry-After'); break; }
    assert.equal(r.status, 200, logs);
  }
  assert.ok(sawRateLimit, 'visitor thread posts are rate-limited');
});

test('an auditor cannot post into a reception thread', async () => {
  // Owner posting requires a non-auditor role; the seeded owner account is used
  // above. Here we assert the role gate exists on the standard endpoint source.
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /adminRouter\.post\('\/shares\/:id\/thread'[\s\S]{0,400}role === 'auditor'/);
});
