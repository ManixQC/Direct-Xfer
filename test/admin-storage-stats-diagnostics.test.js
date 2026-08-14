'use strict';

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
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => e ? reject(e) : resolve(port)); });
  });
}
async function waitForServer(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited (${child.exitCode})\n${logs}`);
    try { const r = await fetch(url, { cache:'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`server did not start\n${logs}`);
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || ''; const first = raw.split(';', 1)[0];
  assert.match(first, /^[^=]+=.+$/); return first;
}
async function j(res) { return res.json().catch(() => ({})); }
async function adminFetch(url, opts = {}) {
  const headers = { Cookie:auth.cookie, Origin:base, ...(opts.headers || {}) };
  if (!['GET','HEAD'].includes(opts.method || 'GET')) headers['X-CSRF-Token'] = auth.csrf;
  return fetch(base + url, { ...opts, headers });
}

before(async () => {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-stats-diag-'));
  for (const dir of ['data','host','inbox','images']) fs.mkdirSync(path.join(root, dir), { recursive:true });
  fs.mkdirSync(path.join(root, 'images', 'Full'), { recursive:true });
  fs.writeFileSync(path.join(root, 'inbox', 'sample-photo.jpg'), Buffer.alloc(1200, 1));
  fs.writeFileSync(path.join(root, 'inbox', 'movie.mp4'), Buffer.alloc(2200, 2));
  fs.writeFileSync(path.join(root, 'inbox', 'notes.pdf'), Buffer.alloc(800, 3));
  fs.writeFileSync(path.join(root, 'inbox', 'stale.part'), Buffer.alloc(400, 4));
  fs.utimesSync(path.join(root, 'inbox', 'stale.part'), new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));
  fs.writeFileSync(path.join(root, 'images', 'Full', 'managed.png'), Buffer.alloc(1600, 5));
  const now = Date.now();
  const records = [
    { id:'a', name:'sample-photo.jpg', direction:'down', bytes:1200, completed:true, durationMs:1000, endedAt:now },
    { id:'b', name:'movie.mp4', direction:'up', bytes:2200, completed:true, durationMs:1000, endedAt:now },
    { id:'c', name:'notes.pdf', direction:'down', bytes:800, completed:false, durationMs:500, endedAt:now, reason:'test' },
  ];
  fs.writeFileSync(path.join(root, 'data', 'transfers.log'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd:path.resolve(__dirname, '..'),
    env:{ ...process.env, PORT:String(port), BIND:'127.0.0.1', ADMIN_USERNAME:'stats-admin', ADMIN_PASSWORD:'Stats-test-2026!', DATA_DIR:path.join(root,'data'), HOST_ROOT:path.join(root,'host'), INBOX_DIR:path.join(root,'inbox'), IMAGES_DIR:path.join(root,'images'), UPDATE_CHECK:'false', TRUST_PROXY:'false', PUBLIC_URL:'', SEARCH_OCR_ENABLED:'false' },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); }); child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
  const login = await fetch(`${base}/api/login`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ username:'stats-admin', password:'Stats-test-2026!' }) });
  assert.equal(login.status, 200, JSON.stringify(await j(login.clone())));
  const data = await j(login); auth = { cookie:cookieFrom(login), csrf:data.csrf };
});

after(async () => {
  if (child && child.exitCode == null) { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 2500))]); if (child.exitCode == null) child.kill('SIGKILL'); }
  if (root) fs.rmSync(root, { recursive:true, force:true });
});

test('feature 23 combines broad file-category storage with transfer traffic', async () => {
  const res = await adminFetch('/api/dashboard?days=30');
  assert.equal(res.status, 200, JSON.stringify(await j(res.clone())));
  const data = await j(res);
  const by = Object.fromEntries((data.fileTypeStats || []).map((r) => [r.category, r]));
  assert.ok(by.image && by.image.storageBytes >= 2800, JSON.stringify(by)); // reception JPG + managed Images PNG
  assert.ok(by.image.trafficBytes >= 1200 && by.image.transfers >= 1);
  assert.ok(by.video && by.video.storageBytes >= 2200 && by.video.upBytes >= 2200);
  assert.ok(by.document && by.document.storageBytes >= 800 && by.document.interrupted >= 1);
});

test('feature 24 reports Direct-Xfer storage components and reclaimable stale partials', async () => {
  const res = await adminFetch('/api/dashboard?days=30');
  assert.equal(res.status, 200);
  const report = (await j(res)).storageReport;
  assert.ok(report && report.managedBytes > 0, JSON.stringify(report));
  const parts = Object.fromEntries((report.components || []).map((r) => [r.key, r]));
  assert.ok(parts.reception.bytes >= 4200, JSON.stringify(parts));
  assert.ok(parts.imagesFull.bytes >= 1600, JSON.stringify(parts));
  assert.ok(parts.temporary.bytes >= 400, JSON.stringify(parts));
  assert.ok(report.reclaimableBytes >= 400, JSON.stringify(report));
});

test('feature 30 runs bounded integrated diagnostics as a full admin', async () => {
  const res = await adminFetch('/api/diagnostics/run', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' });
  assert.equal(res.status, 200, JSON.stringify(await j(res.clone())));
  const data = await j(res);
  const ids = new Set((data.checks || []).map((c) => c.id));
  for (const id of ['data-writable','reception-writable','images-writable','disk-space','audit-chain','search-index','ocr','clamav','webhook','email','web-push','pwa-assets','public-port','reverse-proxy']) assert.ok(ids.has(id), id);
  assert.equal((data.checks || []).find((c) => c.id === 'data-writable').status, 'ok');
  assert.equal((data.checks || []).find((c) => c.id === 'reception-writable').status, 'ok');
  assert.equal((data.checks || []).find((c) => c.id === 'images-writable').status, 'ok');
  assert.equal((data.checks || []).find((c) => c.id === 'audit-chain').status, 'ok');
  assert.ok(data.summary && Number.isInteger(data.summary.bad));
});
