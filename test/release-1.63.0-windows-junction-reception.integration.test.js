'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth, junctionReady = false, logs = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
async function wait(url) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${logs}`);
    try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 70));
  }
  throw new Error('server did not start\n' + logs);
}
async function json(r) { return r.json().catch(() => ({})); }
function cookieFrom(r) {
  const raw = r.headers.get('set-cookie') || '';
  const m = raw.match(/(?:sid|dxsession)=[^;]+/);
  assert.ok(m, raw);
  return m[0];
}
function adminHeaders(extra = {}) {
  return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra };
}
async function admin(url, opts = {}) {
  return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) });
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
async function upload(inbox, name, id, buf, action = '', expire = 0) {
  const q = new URLSearchParams({ name, id, size: String(buf.length), offset: '0', sha256: sha(buf) });
  if (action) q.set('duplicate', action);
  if (expire) q.set('expire', String(expire));
  return fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  });
}
async function createInbox(extra = {}) {
  const r = await admin('/api/inbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Junction ' + crypto.randomBytes(3).toString('hex'), maxFiles: 10, ...extra }),
  });
  assert.equal(r.status, 201, JSON.stringify(await json(r.clone())));
  return (await json(r)).share;
}
function state() { return JSON.parse(fs.readFileSync(path.join(root, 'data', 'shares.json'), 'utf8')); }
function shareState(id) { return state().shares.find((s) => s.id === id); }

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-1623-junction-'));
  for (const d of ['data', 'host', 'images', 'real-inbox']) fs.mkdirSync(path.join(root, d), { recursive: true });
  try {
    fs.symlinkSync(path.join(root, 'real-inbox'), path.join(root, 'inbox'), process.platform === 'win32' ? 'junction' : 'dir');
    junctionReady = true;
  } catch (_) {
    fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  }

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), BIND: '127.0.0.1',
      ADMIN_USERNAME: 'junction1623', ADMIN_PASSWORD: 'Junction-1623-test!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  await wait(base + '/api/meta');
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'junction1623', password: 'Junction-1623-test!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const body = await json(login);
  auth = { cookie: cookieFrom(login), csrf: body.csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('reception dedupe metadata survives a real-path alias/junction and stays relative to INBOX_DIR', async (t) => {
  if (!junctionReady) return t.skip('directory junction/symlink unavailable on this runner');
  const buf = Buffer.from('junction duplicate metadata 1623');
  const inbox = await createInbox({ maxFiles: 1, maxTotalBytes: buf.length });
  let r = await upload(inbox, 'first.txt', 'junction-first-1623', buf, '', 3600);
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));

  const h = sha(buf);
  const sh = shareState(inbox.id);
  const entry = sh.receivedHashes && sh.receivedHashes[h];
  assert.ok(entry && typeof entry === 'object' && entry.path, JSON.stringify(entry));
  const lexicalStored = path.join(root, 'inbox', entry.path);
  const st = state();
  assert.ok(st.meta.fileExpiry && st.meta.fileExpiry[lexicalStored], JSON.stringify(st.meta.fileExpiry));

  r = await fetch(`${base}/u/${inbox.token}/duplicate-check?sha256=${h}`);
  assert.equal(r.status, 200);
  const preflight = await json(r);
  assert.equal(preflight.duplicate, true, JSON.stringify(preflight));
  assert.equal(preflight.existingName, 'first.txt');

  r = await upload(inbox, 'replacement.txt', 'junction-replace-1623', buf, 'replace');
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));
  const replaced = await json(r);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.filesReceived, 1);
  assert.equal(replaced.bytesReceived, buf.length);
});

test('rejectDuplicates still permits exact Replace through a junction while Keep both stays rejected', async (t) => {
  if (!junctionReady) return t.skip('directory junction/symlink unavailable on this runner');
  const buf = Buffer.from('junction reject duplicate 1623');
  const inbox = await createInbox({ rejectDuplicates: true });
  let r = await upload(inbox, 'dup.txt', 'junction-reject-first-1623', buf);
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));
  r = await upload(inbox, 'keep.txt', 'junction-reject-keep-1623', buf, 'keep');
  assert.equal(r.status, 409, JSON.stringify(await json(r.clone())));
  assert.equal((await json(r)).error, 'duplicate');
  r = await upload(inbox, 'replace.txt', 'junction-reject-replace-1623', buf, 'replace');
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));
  assert.equal((await json(r)).replaced, true);
});
