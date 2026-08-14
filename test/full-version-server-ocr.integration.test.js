'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child;
let base;
let root;
let logs = '';
let auth;
let counterFile;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
async function waitForServer(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try { const res = await fetch(url, { cache:'no-store' }); if (res.ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const first = raw.split(';', 1)[0];
  assert.match(first, /^[^=]+=.+$/, `missing cookie in ${raw}`);
  return first;
}
async function bodyJson(res) { return res.json().catch(() => ({})); }
function adminHeaders(extra = {}) { return { Cookie:auth.cookie, 'X-CSRF-Token':auth.csrf, Origin:base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers:adminHeaders(opts.headers || {}) }); }
async function waitForIndex(minIndexed = 1, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  let status = null;
  do {
    const r = await adminFetch('/api/search/status');
    assert.equal(r.status, 200);
    status = await bodyJson(r);
    if (!status.building && status.builtAt && status.indexed >= minIndexed) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw new Error(`index timeout: ${JSON.stringify(status)}\n${logs}`);
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-full-ocr-'));
  for (const dir of ['data','host','inbox','images','bin']) fs.mkdirSync(path.join(root, dir), { recursive:true });
  fs.writeFileSync(path.join(root, 'host', 'scan.png'), Buffer.from('not-a-real-image-fake-ocr-binary-handles-it'));
  counterFile = path.join(root, 'ocr-counter.log');
  const fake = path.join(root, 'bin', 'fake-tesseract.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tesseract fake 5"; exit 0; fi\nif [ "$1" = "--list-langs" ]; then printf "List of available languages (2):\\neng\\nfra\\n"; exit 0; fi\necho run >> "$DX_FAKE_OCR_COUNTER"\necho "Full Direct-Xfer server OCR marker: amberquartzsatellite"\n`, { mode:0o755 });

  child = spawn(process.execPath, ['server.js'], {
    cwd:path.resolve(__dirname, '..'),
    env:{
      ...process.env,
      PORT:String(port), BIND:'127.0.0.1', TRUST_PROXY:'1',
      ADMIN_USERNAME:'ocr-admin', ADMIN_PASSWORD:'OCR-test-password-2026!',
      DATA_DIR:path.join(root,'data'), HOST_ROOT:path.join(root,'host'), INBOX_DIR:path.join(root,'inbox'), IMAGES_DIR:path.join(root,'images'),
      UPDATE_CHECK:'false', PUBLIC_URL:base, DATA_KEY:'Full-OCR-integration-data-key-2026!',
      SEARCH_OCR_ENABLED:'true', SEARCH_OCR_TESSERACT_BIN:fake, SEARCH_OCR_BATCH:'10', SEARCH_OCR_LANGS:'fra+eng',
      DX_FAKE_OCR_COUNTER:counterFile,
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
  const login = await fetch(`${base}/api/login`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ username:'ocr-admin', password:'OCR-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  const loginData = await bodyJson(login);
  auth = { cookie:cookieFrom(login), csrf:loginData.csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive:true, force:true });
});

test('full-version global index OCRs an image, finds its text and reuses the persistent OCR cache', async () => {
  const create = await adminFetch('/api/shares', {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:'/scan.png' }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;

  const first = await adminFetch('/api/search/reindex', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' });
  assert.equal(first.status, 202, JSON.stringify(await bodyJson(first.clone())));
  const firstStatus = await waitForIndex(1);
  assert.equal(firstStatus.ocr.enabled, true);
  assert.equal(firstStatus.ocr.available, true);
  assert.ok(firstStatus.ocr.processed >= 1, JSON.stringify(firstStatus));
  const cacheFile = path.join(root, 'data', 'search-ocr-cache.json');
  const indexFile = path.join(root, 'data', 'search-index.json');
  assert.ok(fs.existsSync(cacheFile));
  assert.ok(fs.existsSync(indexFile));
  for (const file of [cacheFile, indexFile]) {
    const raw = fs.readFileSync(file, 'utf8');
    const env = JSON.parse(raw);
    assert.equal(env.dxenc, 1, `${path.basename(file)} must follow DATA_KEY encryption at rest`);
    assert.doesNotMatch(raw, /amberquartzsatellite/i, `${path.basename(file)} must not leak OCR text in plaintext`);
  }

  const found = await adminFetch('/api/search?q=amberquartzsatellite');
  assert.equal(found.status, 200, JSON.stringify(await bodyJson(found.clone())));
  const data = await bodyJson(found);
  const hit = data.results.find((r) => r.shareId === share.id && r.file === 'scan.png');
  assert.ok(hit, JSON.stringify(data));
  assert.equal(hit.ocr, true);
  assert.equal(hit.ocrSource, 'image-ocr');

  const runsBefore = fs.readFileSync(counterFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  const second = await adminFetch('/api/search/reindex', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' });
  assert.equal(second.status, 202);
  const secondStatus = await waitForIndex(1);
  const runsAfter = fs.readFileSync(counterFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  assert.equal(runsAfter, runsBefore, 'unchanged image must be served from OCR cache');
  assert.ok(secondStatus.ocr.cached >= 1, JSON.stringify(secondStatus));
});

test('Images-section uploads are OCR-indexed and searchable from both the full UI API and PWA Images API', async () => {
  const upload = await adminFetch('/api/photos/upload?name=images-section-scan.png', {
    method:'POST',
    headers:{ 'Content-Type':'image/png' },
    body:Buffer.from('fake-image-body-for-images-section-ocr'),
  });
  assert.equal(upload.status, 201, JSON.stringify(await bodyJson(upload.clone())));
  const photo = (await bodyJson(upload)).share;
  assert.equal(photo.type, 'photo');

  const rebuild = await adminFetch('/api/search/reindex', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' });
  assert.equal(rebuild.status, 202, JSON.stringify(await bodyJson(rebuild.clone())));
  await waitForIndex(2);

  const fullResult = await adminFetch('/api/search?q=amberquartzsatellite&type=photo&limit=200');
  assert.equal(fullResult.status, 200, JSON.stringify(await bodyJson(fullResult.clone())));
  const fullData = await bodyJson(fullResult);
  const fullHit = fullData.results.find((r) => r.shareId === photo.id);
  assert.ok(fullHit, JSON.stringify(fullData));
  assert.equal(fullHit.type, 'photo');
  assert.equal(fullHit.token, photo.token);
  assert.equal(fullHit.ocr, true);
  assert.equal(fullHit.ocrSource, 'image-ocr');

  const fileOnly = await adminFetch('/api/search?q=amberquartzsatellite&type=file&limit=200');
  assert.equal(fileOnly.status, 200);
  assert.equal((await bodyJson(fileOnly)).results.some((r) => r.shareId === photo.id), false, 'photo must respect the type filter');

  const pwaResult = await adminFetch('/app/images/search?q=amberquartzsatellite&limit=500');
  assert.equal(pwaResult.status, 200, JSON.stringify(await bodyJson(pwaResult.clone())));
  const pwaData = await bodyJson(pwaResult);
  assert.ok(pwaData.tokens.includes(photo.token), JSON.stringify(pwaData));
  const pwaHit = pwaData.results.find((r) => r.shareId === photo.id);
  assert.ok(pwaHit, JSON.stringify(pwaData));
  assert.equal(pwaHit.ocr, true);
});
