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
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return;
    } catch (_) {}
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
function adminHeaders(extra = {}) {
  return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra };
}
async function adminFetch(url, opts = {}) {
  return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-22-25-27-'));
  for (const dir of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'universal-note.txt'),
    'Direct-Xfer universal search integration marker: cobaltmarigoldvector.\nSecond searchable line.\n');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      TRUST_PROXY: '1',
      ADMIN_USERNAME: 'feature-admin',
      ADMIN_PASSWORD: 'Feature-test-password-2026!',
      DATA_DIR: path.join(root, 'data'),
      HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'),
      IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false',
      PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'feature-admin', password: 'Feature-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  const loginData = await bodyJson(login);
  auth = { cookie: cookieFrom(login), csrf: loginData.csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('feature 27 persistently indexes and finds content inside a shared text file', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/universal-note.txt' }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;
  assert.ok(share && share.id);

  const reindex = await adminFetch('/api/search/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(reindex.status, 202, JSON.stringify(await bodyJson(reindex.clone())));

  const deadline = Date.now() + 10000;
  let status = null;
  do {
    const r = await adminFetch('/api/search/status');
    assert.equal(r.status, 200);
    status = await bodyJson(r);
    if (!status.building && status.builtAt && status.indexed >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.ok(status && !status.building && status.indexed >= 1, JSON.stringify(status));
  assert.ok(fs.existsSync(path.join(root, 'data', 'search-index.json')), 'persistent index file should exist');

  const search = await adminFetch('/api/search?q=cobaltmarigoldvector');
  assert.equal(search.status, 200, JSON.stringify(await bodyJson(search.clone())));
  const data = await bodyJson(search);
  assert.ok(data.results.some((r) => r.shareId === share.id && r.file === 'universal-note.txt'), JSON.stringify(data));
});

test('feature 25 blocks a suspicious ransomware-style upload burst but preserves uploaded files', async () => {
  const settings = await adminFetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ransomwareProtection: true, ransomwareUploadThreshold: 20, ransomwareBlockMinutes: 2 }),
  });
  assert.equal(settings.status, 200, JSON.stringify(await bodyJson(settings.clone())));

  const created = await adminFetch('/api/inbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ransomware integration inbox' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await bodyJson(created.clone())));
  const inbox = (await bodyJson(created)).share;
  assert.ok(inbox && inbox.token);

  const attackerIp = '203.0.113.77';
  for (let i = 0; i < 20; i++) {
    const payload = Buffer.from(`safe test payload ${i}`);
    const up = await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=${encodeURIComponent(`document-${i}.locked`)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': attackerIp }, body: payload,
    });
    assert.equal(up.status, 200, `upload ${i}: ${JSON.stringify(await bodyJson(up.clone()))}`);
  }

  const blocked = await fetch(`${base}/u/${encodeURIComponent(inbox.token)}/upload?name=blocked-21.locked`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Forwarded-For': attackerIp }, body: Buffer.from('blocked payload'),
  });
  assert.equal(blocked.status, 423, JSON.stringify(await bodyJson(blocked.clone())));
  const blockedData = await bodyJson(blocked);
  assert.ok(['security-blocked','security-link-suspended'].includes(blockedData.error), blockedData.error);
  assert.equal(blockedData.reason, 'suspicious-upload-burst');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

  const anomaly = await adminFetch('/api/security/anomalies');
  assert.equal(anomaly.status, 200);
  const anomalyData = await bodyJson(anomaly);
  assert.ok(anomalyData.blocks.some((b) => b.ip === attackerIp && b.reason === 'suspicious-upload-burst'), JSON.stringify(anomalyData));

  const inboxDir = path.join(root, 'inbox', 'Ransomware integration inbox');
  const uploaded = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.locked'));
  assert.equal(uploaded.length, 20, 'guard must not delete files that were already accepted');

  const unblocked = await adminFetch('/api/security/anomalies/unblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: attackerIp }),
  });
  assert.equal(unblocked.status, 200);
  assert.equal((await bodyJson(unblocked)).unblocked, true);
});

test('feature 27 does not duplicate an already-searchable PDF text layer', async () => {
  const marker = 'LayerTextAlphaBeta';
  const repeated = Array.from({ length: 120 }, () => marker).join(' ');
  fs.writeFileSync(path.join(root, 'host', 'long-layer.pdf'), Buffer.from(`%PDF-1.4\n(${repeated}) Tj\n%%EOF\n`, 'latin1'));

  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/long-layer.pdf', dlpOverride:true }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;

  const reindex = await adminFetch('/api/search/reindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(reindex.status, 202);
  const deadline = Date.now() + 10000;
  let status;
  do {
    const r = await adminFetch('/api/search/status'); status = await bodyJson(r);
    if (!status.building && status.builtAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.ok(status && !status.building, JSON.stringify(status));

  const index = JSON.parse(fs.readFileSync(path.join(root, 'data', 'search-index.json'), 'utf8'));
  const doc = index.docs.find((d) => d.shareId === share.id && d.file === 'long-layer.pdf');
  assert.ok(doc, 'PDF should be indexed');
  const occurrences = (doc.searchText.match(/layertextalphabeta/g) || []).length;
  assert.equal(occurrences, 120, 'existing PDF text must not be appended to itself a second time');
});

test('feature 22 full export reads the complete chain rather than the 500-row dashboard cache', async () => {
  const chainFile = path.join(root, 'data', 'audit-chain.log');
  const headFile = path.join(root, 'data', 'audit-chain-head.json');
  const keyFile = path.join(root, 'data', 'audit-chain.key');
  const key = fs.readFileSync(keyFile);
  const lines = fs.readFileSync(chainFile, 'utf8').trimEnd().split('\n').filter(Boolean);
  let last = lines.length ? JSON.parse(lines[lines.length - 1]) : { seq: 0, hash: '' };
  const crypto = require('node:crypto');
  const payload = (e) => JSON.stringify([
    Number(e.seq) || 0, Number(e.at) || 0, String(e.action || ''),
    e.actor == null ? null : String(e.actor), e.actorId == null ? null : String(e.actorId),
    e.role == null ? null : String(e.role), e.ip == null ? null : String(e.ip),
    e.detail == null ? null : String(e.detail), String(e.prevHash || ''),
  ]);
  for (let i = 0; i < 520; i++) {
    const e = { seq: last.seq + 1, at: Date.now() + i, action: 'synthetic-regression', actor: 'test', actorId: null, role: 'owner', ip: '127.0.0.1', detail: `row-${i}`, prevHash: last.hash || '' };
    e.hash = crypto.createHmac('sha256', key).update(payload(e)).digest('hex');
    fs.appendFileSync(chainFile, JSON.stringify(e) + '\n');
    last = e;
  }
  const seal = crypto.createHmac('sha256', key).update(`head|${last.seq}|${last.hash}`).digest('hex');
  fs.writeFileSync(headFile, JSON.stringify({ version: 1, seq: last.seq, hash: last.hash, seal, at: Date.now() }));

  const verify = await adminFetch('/api/audit/verify');
  const integrity = (await bodyJson(verify)).integrity;
  assert.equal(integrity.ok, true, JSON.stringify(integrity));
  assert.ok(integrity.entries > 500, JSON.stringify(integrity));

  const exported = await adminFetch('/api/audit/export?format=json');
  assert.equal(exported.status, 200);
  const data = await bodyJson(exported);
  assert.equal(data.integrity.ok, true, JSON.stringify(data.integrity));
  assert.equal(data.entries.length, data.integrity.entries, 'export should contain the complete verified chain snapshot including its own export event');
  assert.ok(data.entries.length > 500);
});

test('feature 22 verifies the audit chain and detects an on-disk entry modification', async () => {
  const before = await adminFetch('/api/audit/verify');
  assert.equal(before.status, 200);
  const beforeData = (await bodyJson(before)).integrity;
  assert.equal(beforeData.ok, true, JSON.stringify(beforeData));
  assert.ok(beforeData.entries >= 1);
  assert.match(beforeData.keyId || '', /^[a-f0-9]{12}$/);

  const chainFile = path.join(root, 'data', 'audit-chain.log');
  const headFile = path.join(root, 'data', 'audit-chain-head.json');
  const originalHead = fs.readFileSync(headFile, 'utf8');
  fs.unlinkSync(headFile);
  const missingHeadRes = await adminFetch('/api/audit/verify');
  const missingHead = (await bodyJson(missingHeadRes)).integrity;
  assert.equal(missingHead.ok, false, JSON.stringify(missingHead));
  assert.equal(missingHead.reason, 'head-missing');
  fs.writeFileSync(headFile, originalHead);
  const restoredHeadRes = await adminFetch('/api/audit/verify');
  assert.equal((await bodyJson(restoredHeadRes)).integrity.ok, true);

  const original = fs.readFileSync(chainFile, 'utf8');
  const fullLines = original.trimEnd().split('\n');
  assert.ok(fullLines.length > 2);
  fs.writeFileSync(chainFile, fullLines.slice(0, -1).join('\n') + '\n');
  fs.unlinkSync(headFile);
  const rollbackRes = await adminFetch('/api/audit/verify');
  const rollback = (await bodyJson(rollbackRes)).integrity;
  assert.equal(rollback.ok, false, JSON.stringify(rollback));
  assert.equal(rollback.reason, 'chain-rollback-detected');
  fs.writeFileSync(chainFile, original);
  fs.writeFileSync(headFile, originalHead);
  const restoredRollbackRes = await adminFetch('/api/audit/verify');
  assert.equal((await bodyJson(restoredRollbackRes)).integrity.ok, true);
  const lines = original.trimEnd().split('\n');
  const first = JSON.parse(lines[0]);
  first.detail = String(first.detail || '') + ' TAMPERED';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(chainFile, lines.join('\n') + '\n');

  const afterTamper = await adminFetch('/api/audit/verify');
  assert.equal(afterTamper.status, 200);
  const tampered = (await bodyJson(afterTamper)).integrity;
  assert.equal(tampered.ok, false, JSON.stringify(tampered));
  assert.ok(['entry-hash-mismatch', 'previous-hash-mismatch'].includes(tampered.reason), JSON.stringify(tampered));
});
