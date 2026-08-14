'use strict';

// Integration tests for the added easy/medium features:
//   #5  download-goal alert  — notify once when a link reaches N completed downloads
//   #9  public "remaining slots" line when a link caps its unique visitors
//   #10 estimated "download all (.zip)" size shown before generation
//   #13 per-deposit "max files / upload" cap (stored + exposed to the public page)
//   #15 admin received-file browser with image thumbnails (reception / collab)

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

async function makeShare(reqPath, extra = {}) {
  const r = await adminFetch('/api/shares', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ path: reqPath, ...extra }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}
async function makeInbox(name, extra = {}) {
  const r = await adminFetch('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...extra }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}
async function makeCollab(name, extra = {}) {
  const r = await adminFetch('/api/collab', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name, ...extra }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  return (await bodyJson(r)).share;
}
async function uploadTo(token, name, buf) {
  return fetch(`${base}/u/${encodeURIComponent(token)}/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  });
}
async function shareById(id) {
  const shares = (await bodyJson(await adminFetch('/api/shares'))).shares || [];
  return shares.find((s) => s.id === id) || null;
}
// Downloads complete asynchronously; the per-link counter is bumped on stream end.
async function waitForShare(id, pred, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await shareById(id);
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 40));
  }
  return last;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-af591013-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  // Host files/dirs used by the download-share tests.
  fs.writeFileSync(path.join(root, 'host', 'goal.txt'), 'download me repeatedly');
  fs.writeFileSync(path.join(root, 'host', 'capped-visitors.txt'), 'limited-audience file');
  fs.mkdirSync(path.join(root, 'host', 'estflat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'estflat', 'a.bin'), Buffer.alloc(1500, 0x41));
  fs.writeFileSync(path.join(root, 'host', 'estflat', 'b.bin'), Buffer.alloc(2500, 0x42));
  fs.mkdirSync(path.join(root, 'host', 'estnested', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'estnested', 'top.bin'), Buffer.alloc(1000, 0x43));
  fs.writeFileSync(path.join(root, 'host', 'estnested', 'sub', 'deep.bin'), Buffer.alloc(9000, 0x44));

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'af-admin', ADMIN_PASSWORD: 'Added-features-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'af-admin', password: 'Added-features-2026!' }) });
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

// ---------------------------------------------------------------- feature 5
test('#5 the download-goal is stored and fires exactly once at the threshold', async () => {
  const share = await makeShare('/goal.txt', { notifyDownloadThreshold: 2 });
  assert.equal(share.notifyDownloadThreshold, 2, 'goal should persist on create');
  assert.equal(share.downloadThresholdReached, false, 'not reached yet');

  // One completed download: below the goal, still un-fired.
  const d1 = await fetch(`${base}/s/${share.token}/download`);
  assert.equal(d1.status, 200);
  await d1.arrayBuffer();
  const after1 = await waitForShare(share.id, (s) => (s.downloads || 0) >= 1);
  assert.equal(after1.downloadThresholdReached, false, 'one download is below the goal');

  // Second completed download reaches the goal → the one-shot alert fires.
  const d2 = await fetch(`${base}/s/${share.token}/download`);
  assert.equal(d2.status, 200);
  await d2.arrayBuffer();
  const after2 = await waitForShare(share.id, (s) => s.downloadThresholdReached === true);
  assert.equal(after2.downloadThresholdReached, true, 'goal reached after two downloads');
});

test('#5 editing the goal re-arms the one-shot alert', async () => {
  const share = await makeShare('/goal.txt', { notifyDownloadThreshold: 1 });
  const d1 = await fetch(`${base}/s/${share.token}/download`);
  await d1.arrayBuffer();
  const fired = await waitForShare(share.id, (s) => s.downloadThresholdReached === true);
  assert.equal(fired.downloadThresholdReached, true);

  // Raising the goal must clear the "reached" flag so a new target can fire again.
  const patched = await adminFetch('/api/shares/' + encodeURIComponent(share.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ notifyDownloadThreshold: 5 }) });
  assert.equal(patched.status, 200, JSON.stringify(await bodyJson(patched.clone())));
  const upd = (await bodyJson(patched)).share;
  assert.equal(upd.notifyDownloadThreshold, 5);
  assert.equal(upd.downloadThresholdReached, false, 'raising the goal re-arms the alert');

  // Setting it to 0 turns the alert off entirely.
  const off = await adminFetch('/api/shares/' + encodeURIComponent(share.id), { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ notifyDownloadThreshold: 0 }) });
  assert.equal((await bodyJson(off)).share.notifyDownloadThreshold, 0);
});

// ---------------------------------------------------------------- feature 9
test('#9 a visitor-capped link shows the remaining slots on its public page', async () => {
  const share = await makeShare('/capped-visitors.txt', { maxVisitors: 3 });
  assert.equal(share.maxVisitors, 3);
  const page = await fetch(`${base}/s/${share.token}`, { headers: { Cookie: 'lang=en' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /class="dl-slots/, 'the remaining-slots line must be rendered');
  // This first visitor is already counted, so 2 of 3 remain.
  assert.match(html, /2 slot\(s\) left of 3/, 'should show 2 of 3 remaining: ' + (html.match(/dl-slots[^<]*<[^>]*>[^<]*/) || ''));
});

test('#9 an uncapped link shows no remaining-slots line', async () => {
  const share = await makeShare('/goal.txt');
  const html = await (await fetch(`${base}/s/${share.token}`, { headers: { Cookie: 'lang=en' } })).text();
  assert.doesNotMatch(html, /class="dl-slots/, 'no slots line without a visitor cap');
});

// --------------------------------------------------------------- feature 10
test('#10 a folder page shows an exact ZIP size estimate (flat folder)', async () => {
  const share = await makeShare('/estflat'); // 1500 + 2500 = 4000 bytes, no subfolders
  const html = await (await fetch(`${base}/s/${share.token}`, { headers: { Cookie: 'lang=en' } })).text();
  assert.match(html, /class="zip-est/, 'the estimate span must be rendered next to the ZIP link');
  assert.doesNotMatch(html, /zip-est[^>]*>\(≈/, 'a flat folder yields an exact (non-≈) estimate');
  assert.match(html, /zip-est[^>]*>\(3\.9 KB\)/, 'estimate should be ~3.9 KB: ' + (html.match(/zip-est[^<]*<[^>]*>[^<]*/) || ''));
});

test('#10 a folder containing a subfolder shows an approximate (≈) estimate', async () => {
  const share = await makeShare('/estnested'); // top.bin known, sub/ unknown at this level
  const html = await (await fetch(`${base}/s/${share.token}`, { headers: { Cookie: 'lang=en' } })).text();
  assert.match(html, /zip-est[^>]*>\(≈ /, 'a subfolder makes the total approximate: ' + (html.match(/zip-est[^<]*<[^>]*>[^<]*/) || ''));
});

// --------------------------------------------------------------- feature 13
test('#13 max-files-per-upload is stored and exposed on the reception page', async () => {
  const inbox = await makeInbox('Per-deposit cap', { maxFilesPerUpload: 2 });
  assert.equal(inbox.inbox.maxFilesPerUpload, 2, 'the cap must be exposed to the admin');
  const html = await (await fetch(`${base}/u/${inbox.token}`, { headers: { Cookie: 'lang=en' } })).text();
  assert.match(html, /"maxFilesPerUpload":\s*2/, 'the page config must carry the cap for client enforcement');
  assert.match(html, /Max 2 files per upload/, 'the limits line must state the per-upload cap');
});

test('#13 collaboration links also carry a per-upload cap', async () => {
  const collab = await makeCollab('Collab deposit cap', { maxFilesPerUpload: 3 });
  assert.equal(collab.collab.maxFilesPerUpload, 3, 'the cap must be exposed to the admin');
  const html = await (await fetch(`${base}/c/${collab.token}`, { headers: { Cookie: 'lang=en' } })).text();
  assert.match(html, /"maxFilesPerUpload":\s*3/, 'the collab page config must carry the cap');
});

// --------------------------------------------------------------- feature 15
test('#15 the admin received-file browser lists files and flags images', async () => {
  const inbox = await makeInbox('Received browser');
  assert.equal((await uploadTo(inbox.token, 'notes.txt', Buffer.from('plain notes'))).status, 200);
  assert.equal((await uploadTo(inbox.token, 'photo.png', Buffer.from('not-a-real-png-but-named-png'))).status, 200);

  const list = await adminFetch('/api/shares/' + encodeURIComponent(inbox.id) + '/received');
  assert.equal(list.status, 200, JSON.stringify(await bodyJson(list.clone())));
  const data = await bodyJson(list);
  assert.equal(data.count, 2, JSON.stringify(data));
  const png = data.files.find((f) => f.name === 'photo.png');
  const txt = data.files.find((f) => f.name === 'notes.txt');
  assert.ok(png && png.image === true, 'the .png must be flagged as an image');
  assert.ok(txt && txt.image === false, 'the .txt must not be flagged as an image');
});

test('#15 received-file serves images inline and other files as a download', async () => {
  const inbox = await makeInbox('Received serve');
  await uploadTo(inbox.token, 'pic.png', Buffer.from('png-bytes'));
  await uploadTo(inbox.token, 'doc.txt', Buffer.from('text-bytes'));
  const bId = encodeURIComponent(inbox.id);

  const img = await adminFetch(`/api/shares/${bId}/received-file?path=pic.png&inline=1`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-disposition') || '', /^inline/);
  await img.arrayBuffer();

  // A non-image asked inline is still served as an attachment (never inline).
  const txtInline = await adminFetch(`/api/shares/${bId}/received-file?path=doc.txt&inline=1`);
  assert.equal(txtInline.status, 200);
  assert.equal(txtInline.headers.get('content-type'), 'application/octet-stream');
  assert.match(txtInline.headers.get('content-disposition') || '', /^attachment/);
  await txtInline.arrayBuffer();

  // Default (no inline) is always a download.
  const dl = await adminFetch(`/api/shares/${bId}/received-file?path=pic.png`);
  assert.match(dl.headers.get('content-disposition') || '', /^attachment/);
  await dl.arrayBuffer();
});

test('#15 the received browser refuses path traversal and non-reception links', async () => {
  const inbox = await makeInbox('Received guard');
  await uploadTo(inbox.token, 'ok.txt', Buffer.from('fine'));
  const bId = encodeURIComponent(inbox.id);

  const traversal = await adminFetch(`/api/shares/${bId}/received-file?path=${encodeURIComponent('../../secret')}`);
  assert.ok(traversal.status === 400 || traversal.status === 404, 'path traversal must be refused: ' + traversal.status);

  // A download share has no received files: the endpoint must not apply to it.
  const fileShare = await makeShare('/goal.txt');
  const wrong = await adminFetch('/api/shares/' + encodeURIComponent(fileShare.id) + '/received');
  assert.equal(wrong.status, 404, 'received list is only for reception/collab links');
});
