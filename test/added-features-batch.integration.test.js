'use strict';

// Integration tests for the batch of added features:
//   #6  custom password hint on the public unlock page
//   #11 auto-tag received files with the sender name (filename prefix)
//   #12 per-sender file/byte caps on reception links
//   #16 live expiry countdown element on public download pages
//   #17 download-time estimate on the public file page
//   #24 per-IP download quota
//   #28 per-type file icons in folder listings

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
function cookieFrom(res) { const first = (res.headers.get('set-cookie') || '').split(';', 1)[0]; assert.match(first, /^[^=]+=.+$/); return first; }
async function bodyJson(res) { return res.json().catch(() => ({})); }
function adminHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) }); }
function jsonHeaders() { return { 'Content-Type': 'application/json' }; }
async function createShare(bodyObj) {
  const r = await adminFetch('/api/shares', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ dlpOverride: true, ...bodyObj }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}
async function makeInbox(name, extra = {}) {
  const r = await adminFetch('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...extra }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}
async function uploadTo(token, name, buf, sender) {
  const q = `name=${encodeURIComponent(name)}` + (sender ? `&sender=${encodeURIComponent(sender)}` : '');
  return fetch(`${base}/u/${encodeURIComponent(token)}/upload?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-batch-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'plain.txt'), 'hello there, nothing secret\n');
  fs.writeFileSync(path.join(root, 'host', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 0x41)); // 2 MB → ETA shows
  fs.mkdirSync(path.join(root, 'host', 'bundle'));
  fs.writeFileSync(path.join(root, 'host', 'bundle', 'report.pdf'), '%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(root, 'host', 'bundle', 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'batch-admin', ADMIN_PASSWORD: 'Batch-test-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base, SEARCH_OCR_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'batch-admin', password: 'Batch-test-2026!' }) });
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

test('#24 a per-IP download quota refuses further downloads from the same IP', async () => {
  const share = await createShare({ path: '/plain.txt', maxDownloadsPerIp: 1 });
  assert.equal(share.maxDownloadsPerIp, 1);
  const first = await fetch(`${base}${share.path}/download`);
  assert.equal(first.status, 200, 'the first download is allowed');
  await first.arrayBuffer();
  const second = await fetch(`${base}${share.path}/download`);
  assert.equal(second.status, 429, 'the second download from the same IP is refused');
});

test('#24 a managed resumed download is counted once against the per-IP quota', async () => {
  const share = await createShare({ path: '/big.bin', maxDownloadsPerIp: 1 });
  const resumeId = 'a'.repeat(48);
  // Start the logical download with the authenticated resume id used by the browser
  // manager. A bare Range header is intentionally NOT a quota bypass.
  const first = await fetch(`${base}${share.path}/download`, { headers: {
    Range: 'bytes=0-1048575', 'X-Direct-Xfer-Resume-Id': resumeId,
  } });
  assert.equal(first.status, 206);
  await first.arrayBuffer();
  const resume = await fetch(`${base}${share.path}/download`, { headers: {
    Range: 'bytes=1048576-', 'X-Direct-Xfer-Resume-Id': resumeId,
  } });
  assert.equal(resume.status, 206, 'a validated continuation must not be refused by the quota');
  await resume.arrayBuffer();
  // The completed logical download consumes exactly one unit.
  const fresh = await fetch(`${base}${share.path}/download`);
  assert.equal(fresh.status, 429, 'a fresh full download is still refused');
});

test('#6 a password hint is shown on the public unlock page (and cleared with the password)', async () => {
  const share = await createShare({ path: '/plain.txt', password: 'sesame123', pwHint: 'notre ville de naissance' });
  assert.equal(share.pwHint, 'notre ville de naissance');
  const page = await (await fetch(`${base}${share.path}`)).text();
  assert.match(page, /pw-hint/, 'the unlock page carries the hint element');
  assert.match(page, /notre ville de naissance/, 'the hint text is shown');

  // Clearing the password must drop the hint too.
  const patched = await adminFetch('/api/shares/' + encodeURIComponent(share.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ password: '' }) });
  assert.equal(patched.status, 200, JSON.stringify(await bodyJson(patched.clone())));
  assert.equal((await bodyJson(patched)).share.pwHint, '');
});

test('#16 & #17 a file page shows a live expiry countdown and a download-time estimate', async () => {
  const share = await createShare({ path: '/big.bin', expiresInSeconds: 7200 });
  const page = await (await fetch(`${base}${share.path}`)).text();
  assert.match(page, /dl-expiry[^>]*data-dx-expires="\d+"/, 'the countdown element is present with a deadline');
  assert.match(page, /dl-eta/, 'the ETA line is present');
  assert.match(page, /Mb\/s/, 'the ETA quotes a reference speed');
});

test('#28 a folder listing uses per-type file icons', async () => {
  const share = await createShare({ path: '/bundle' });
  const page = await (await fetch(`${base}${share.path}/browse`)).text();
  assert.match(page, /📕/, 'the PDF row uses the document icon');
  assert.match(page, /🖼️/, 'the JPG row uses the image icon');
});

test('#11 received files are prefixed with the sender name when tagBySender is on', async () => {
  const inbox = await makeInbox('Tagged deposits', { tagBySender: true });
  assert.equal(inbox.inbox.tagBySender, true);
  const up = await uploadTo(inbox.token, 'report.txt', Buffer.from('signed'), 'Alice Example');
  assert.equal(up.status, 200, JSON.stringify(await bodyJson(up.clone())));
  const files = fs.readdirSync(path.join(root, 'inbox', 'Tagged deposits'));
  assert.ok(files.some((n) => /^Alice Example - report\.txt$/.test(n)), 'stored file is sender-tagged: ' + JSON.stringify(files));
});

test('#12 a per-sender file cap refuses a sender who exceeds it, but the link stays open', async () => {
  const inbox = await makeInbox('Per-sender capped', { maxFilesPerSender: 1 });
  assert.equal(inbox.inbox.maxFilesPerSender, 1);
  const first = await uploadTo(inbox.token, 'a.txt', Buffer.from('one'), 'Bob');
  assert.equal(first.status, 200, JSON.stringify(await bodyJson(first.clone())));
  const second = await uploadTo(inbox.token, 'b.txt', Buffer.from('two'), 'Bob');
  assert.equal(second.status, 409, JSON.stringify(await bodyJson(second.clone())));
  assert.equal((await bodyJson(second)).error, 'sender-file-limit');
  // A different sender is unaffected.
  const other = await uploadTo(inbox.token, 'c.txt', Buffer.from('three'), 'Carol');
  assert.equal(other.status, 200, JSON.stringify(await bodyJson(other.clone())));
});

test('#12 a per-sender byte cap refuses an oversized sender total', async () => {
  const inbox = await makeInbox('Per-sender bytes', { maxBytesPerSender: 10 });
  const ok = await uploadTo(inbox.token, 'small.txt', Buffer.from('12345'), 'Dave'); // 5 bytes
  assert.equal(ok.status, 200, JSON.stringify(await bodyJson(ok.clone())));
  const over = await uploadTo(inbox.token, 'big.txt', Buffer.from('1234567890AB'), 'Dave'); // 12 bytes → total 17 > 10
  assert.equal(over.status, 413, JSON.stringify(await bodyJson(over.clone())));
  assert.equal((await bodyJson(over)).error, 'sender-storage-cap');
});
