'use strict';

// Regression: when DLP is enabled with OCR scanning but the OCR tool (tesseract)
// is NOT installed, an image/PDF scan is "incomplete" only because the tool is
// missing — a static deployment condition, not sensitive content. The policy must
// keep failing closed, but:
//   * as an OVERRIDABLE warning (409), never an un-overridable hard block (403),
//     even in 'block' mode, so a host without OCR isn't cut off from every upload;
//   * a real finding is still hard-blocked in 'block' mode (never softened);
//   * the missing tool is signalled at most once (deduped), not on every upload.
// CI normally has tesseract, so this path is forced by pointing the tesseract
// binary at a name that cannot resolve.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth;
let logs = '';

// 1x1 transparent PNG — a real image so extraction succeeds (no scanErrors) and
// the OCR branch is the only reason the scan is incomplete.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=', 'base64');

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
async function createShare(pathValue, extra = {}) {
  return adminFetch('/api/shares', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ path: pathValue, ...extra }) });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-dlp-ocr-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'scan.png'), PNG_1x1);
  fs.writeFileSync(path.join(root, 'host', 'scan2.png'), PNG_1x1);
  fs.writeFileSync(path.join(root, 'host', 'notes.txt'), 'just a harmless note, nothing sensitive here at all.\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'dlp-ocr-admin', ADMIN_PASSWORD: 'Dlp-ocr-test-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
      // Force the OCR tool to be treated as unavailable regardless of the host.
      SEARCH_OCR_ENABLED: 'true', SEARCH_OCR_TESSERACT_BIN: 'dx-no-such-tesseract-binary-xyz' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'dlp-ocr-admin', password: 'Dlp-ocr-test-2026!' }) });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie: cookieFrom(login), csrf: (await bodyJson(login)).csrf };

  // Strictest policy: block mode with OCR scanning on.
  const set = await adminFetch('/api/settings', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ dlpEnabled: true, dlpMode: 'block', dlpScanOcr: true }) });
  assert.equal(set.status, 200, JSON.stringify(await bodyJson(set.clone())));
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('block mode: a missing OCR tool yields an OVERRIDABLE warning, not a 403 hard block', async () => {
  const res = await createShare('/scan.png');
  assert.equal(res.status, 409, JSON.stringify(await bodyJson(res.clone())));
  const data = await bodyJson(res);
  assert.equal(data.error, 'dlp-warning', 'a missing OCR tool must not become a dlp-blocked 403');
  assert.equal(data.reason, 'ocr-unavailable');
  assert.equal(data.dlp.count, 0, 'there is no actual finding — only the OCR tool is missing');
  assert.equal(data.dlp.ocrUnavailable, true);
  assert.equal(data.dlp.ocrErrors, 0, 'a missing tool is not a per-file OCR error');
});

test('block mode: the OCR-unavailable warning can be overridden to proceed', async () => {
  const res = await createShare('/scan.png', { dlpOverride: true });
  assert.equal(res.status, 201, JSON.stringify(await bodyJson(res.clone())));
  const share = (await bodyJson(res)).share;
  assert.ok(share && share.id, 'the upload proceeds when the admin overrides');
});

test('block mode: a non-OCR file is never blocked merely because the OCR tool is missing', async () => {
  const res = await createShare('/notes.txt');
  assert.equal(res.status, 201, JSON.stringify(await bodyJson(res.clone())));
});

test('the missing OCR tool is signalled once, not on every blocked upload', async () => {
  // A second OCR-unavailable block (scan2.png) must not append a second notice.
  const again = await createShare('/scan2.png');
  assert.equal(again.status, 409, JSON.stringify(await bodyJson(again.clone())));
  assert.equal((await bodyJson(again)).reason, 'ocr-unavailable');

  const audit = await adminFetch('/api/audit?limit=500');
  const entries = (await bodyJson(audit)).entries || [];
  const notices = entries.filter((e) => e.action === 'dlp-ocr-unavailable');
  assert.equal(notices.length, 1, 'the OCR-unavailable condition must be audited once, not per upload: ' + notices.length);
  // And the per-upload blocks must NOT each spam a dlp-warning/dlp-blocked entry.
  assert.equal(entries.filter((e) => e.action === 'dlp-blocked').length, 0, 'a missing tool must never be logged as a hard block');
});
