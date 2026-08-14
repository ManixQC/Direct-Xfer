'use strict';

// Integration tests for the added features:
//   #20 admin image editor — the /api/photos/:id/replace endpoint that saves an
//       edited (rotated/cropped) full image, archiving the prior version.
//   #28 anti-spam notification aggregation — N received events for the same link
//       within notifyAggregateSeconds collapse into ONE webhook digest.
//   #36 reusable link presets — per-account CRUD, sanitized config, overwrite-by-name.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let child, base, root, auth, hookServer, hookPort;
let webhookHits = [];
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
function cookieFrom(res) { return (res.headers.get('set-cookie') || '').split(';', 1)[0]; }
async function bodyJson(res) { return res.json().catch(() => ({})); }
function jsonHeaders() { return { 'Content-Type': 'application/json' }; }
function authHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: authHeaders(opts.headers || {}) }); }

before(async () => {
  // Local webhook sink so we can count how many notifications the server actually fires.
  hookServer = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => { webhookHits.push({ at: Date.now(), body: buf }); res.writeHead(200); res.end('ok'); });
  });
  hookPort = await freePort();
  await new Promise((r) => hookServer.listen(hookPort, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-f202836-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1',
      ADMIN_USERNAME: 'f-admin', ADMIN_PASSWORD: 'Features-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base, SEARCH_OCR_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'f-admin', password: 'Features-2026!' }) });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie: cookieFrom(login), csrf: (await bodyJson(login)).csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (hookServer) await new Promise((r) => hookServer.close(r));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('#36 link presets — CRUD, config sanitizing, overwrite-by-name and validation', async () => {
  let r = await adminFetch('/api/presets', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ type: 'inbox', name: 'Client docs', config: { expiry: '86400', block: 'exe,bat', 'block-exec': true, bogus: { nested: 1 }, arr: [1, 2] } }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  const preset = (await bodyJson(r)).preset;
  assert.ok(preset.id);
  // Scalars kept; nested object and array dropped.
  assert.equal(preset.config['block-exec'], true);
  assert.equal(preset.config.expiry, '86400');
  assert.equal(preset.config.bogus, undefined);
  assert.equal(preset.config.arr, undefined);

  r = await adminFetch('/api/presets?type=inbox');
  assert.deepEqual((await bodyJson(r)).presets.map((p) => p.name), ['Client docs']);

  // Re-saving under the same name overwrites (same id, no duplicate).
  r = await adminFetch('/api/presets', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ type: 'inbox', name: 'client DOCS', config: { expiry: '3600' } }) });
  assert.equal((await bodyJson(r)).preset.id, preset.id);
  r = await adminFetch('/api/presets?type=inbox');
  assert.equal((await bodyJson(r)).presets.length, 1);

  // Validation.
  assert.equal((await adminFetch('/api/presets', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ type: 'inbox', name: '', config: { a: '1' } }) })).status, 400);
  assert.equal((await adminFetch('/api/presets', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ type: 'nope', name: 'x', config: { a: '1' } }) })).status, 400);
  assert.equal((await adminFetch('/api/presets', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ type: 'inbox', name: 'x', config: {} }) })).status, 400);

  // A different type is a separate namespace, not an overwrite.
  r = await adminFetch('/api/presets', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ type: 'collab', name: 'Client docs', config: { allow: 'pdf' } }) });
  assert.equal(r.status, 201);
  assert.equal((await bodyJson(await adminFetch('/api/presets?type=inbox'))).presets.length, 1);
  assert.equal((await bodyJson(await adminFetch('/api/presets?type=collab'))).presets.length, 1);

  // Delete.
  assert.equal((await adminFetch('/api/presets/' + preset.id, { method: 'DELETE' })).status, 200);
  assert.equal((await bodyJson(await adminFetch('/api/presets?type=inbox'))).presets.length, 0);
  assert.equal((await adminFetch('/api/presets/' + preset.id, { method: 'DELETE' })).status, 404);
});

test('#20 admin photo replace archives the prior version and swaps the pixels', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
  let r = await adminFetch('/api/photos/upload?name=orig.png&dlpOverride=1', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  const photo = (await bodyJson(r)).share;
  const before = photo.photo && photo.photo.imgUrl;

  r = await adminFetch('/api/photos/' + photo.id + '/replace?name=orig.png&dlpOverride=1', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const edited = (await bodyJson(r)).share;
  assert.equal(edited.id, photo.id);
  // The public URL is token-based, so it stays stable across an edit (by design).
  assert.equal(edited.photo.imgUrl, before);
  // The prior pixels were archived as a restorable version.
  const versions = await bodyJson(await adminFetch('/app/image/' + photo.token + '/versions'));
  assert.ok(Array.isArray(versions.versions) && versions.versions.length >= 1, JSON.stringify(versions));

  assert.equal((await adminFetch('/api/photos/deadbeef/replace?name=x.png&dlpOverride=1', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 404);
});

test('#28 notification aggregation collapses many received events into one webhook', async () => {
  // Point the effective webhook at the local sink and turn on a short aggregation window.
  const cfg = await adminFetch('/api/settings', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ webhookUrl: `http://127.0.0.1:${hookPort}/hook`, webhookFormat: 'json', notifyUploads: true, notifyAggregateSeconds: 1 }) });
  assert.ok(cfg.ok, JSON.stringify(await bodyJson(cfg.clone())));

  const inbox = await bodyJson(await adminFetch('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Aggregated inbox' }) }));
  const token = inbox.share.token;

  webhookHits = [];
  for (let i = 0; i < 4; i++) {
    const up = await fetch(`${base}/u/${encodeURIComponent(token)}/upload?name=file${i}.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('payload ' + i) });
    assert.equal(up.status, 200, JSON.stringify(await bodyJson(up.clone())));
  }
  // Within the window: no webhook yet (all four are buffered under one link).
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(webhookHits.length, 0, 'no webhook should fire before the window elapses');

  // After the window: exactly ONE aggregated webhook for the four uploads.
  const deadline = Date.now() + 4000;
  while (webhookHits.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300)); // allow any stragglers to arrive (there should be none)
  assert.equal(webhookHits.length, 1, `exactly one aggregated webhook, got ${webhookHits.length}`);
  assert.match(webhookHits[0].body, /4/, 'digest mentions the count of 4');
});

test('#28 aggregation disabled (0) sends one webhook per event', async () => {
  const cfg = await adminFetch('/api/settings', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ notifyAggregateSeconds: 0 }) });
  assert.ok(cfg.ok);
  const inbox = await bodyJson(await adminFetch('/api/inbox', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ name: 'Immediate inbox' }) }));
  const token = inbox.share.token;
  webhookHits = [];
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/u/${encodeURIComponent(token)}/upload?name=imm${i}.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('imm ' + i) });
  }
  const deadline = Date.now() + 3000;
  while (webhookHits.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(webhookHits.length, 3, `one webhook per upload with aggregation off, got ${webhookHits.length}`);
});
