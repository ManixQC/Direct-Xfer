'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'Audit-migration-test-password-2026!';

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
async function waitFor(url, child, getLogs, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode != null) throw new Error(`server exited (${child.exitCode})\n${getLogs()}`);
    try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`server did not start\n${getLogs()}`);
}
async function startServer(root, extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'audit-owner', ADMIN_PASSWORD: PASSWORD,
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitFor(`${base}/api/meta`, child, () => logs);
  return { child, base, getLogs: () => logs };
}
async function stopServer(instance) {
  if (!instance || instance.child.exitCode != null) return;
  instance.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => instance.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  if (instance.child.exitCode == null) instance.child.kill('SIGKILL');
}
async function login(base) {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'audit-owner', password: PASSWORD }),
  });
  const body = await r.json().catch(() => ({}));
  assert.equal(r.status, 200, JSON.stringify(body));
  const cookie = (r.headers.get('set-cookie') || '').split(';', 1)[0];
  return { cookie, csrf: body.csrf };
}
async function adminFetch(base, auth, url, opts = {}) {
  return fetch(base + url, {
    ...opts,
    headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...(opts.headers || {}) },
  });
}
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-audit-migrate-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test('AUDIT_HMAC_KEY automatically and safely migrates an existing local audit key', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let first;
  try {
    first = await startServer(root);
    const auth = await login(first.base);
    const r = await adminFetch(first.base, auth, '/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifySecurity: true }),
    });
    assert.equal(r.status, 200);
  } finally { await stopServer(first); }

  const localKey = path.join(root, 'data', 'audit-chain.key');
  const chain = path.join(root, 'data', 'audit-chain.log');
  assert.equal(fs.existsSync(localKey), true, 'legacy local key should exist before migration');
  const oldLocalKeyBytes = fs.readFileSync(localKey);
  const beforeActions = fs.readFileSync(chain, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).action);
  assert.ok(beforeActions.includes('login'));

  const secret = 'external-audit-hmac-key-for-integration-test-2026-very-long';
  let second;
  try {
    second = await startServer(root, { AUDIT_HMAC_KEY: secret });
    assert.equal(fs.existsSync(localKey), false, 'local key must be retired only after successful migration');
    assert.equal(fs.existsSync(path.join(root, 'data', 'audit-key-migration.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'audit-chain.log.pre-key-migration')), false);

    const auth = await login(second.base);
    const verify = await adminFetch(second.base, auth, '/api/audit/verify');
    assert.equal(verify.status, 200);
    const integrity = (await verify.json()).integrity;
    assert.equal(integrity.ok, true, JSON.stringify(integrity));
    assert.equal(integrity.keyMode, 'env');
    assert.equal(integrity.migration && integrity.migration.ok, true, JSON.stringify(integrity.migration));
    assert.equal(integrity.migration && integrity.migration.migrated, true);

    const exported = await adminFetch(second.base, auth, '/api/audit/export?format=json');
    const data = await exported.json();
    const actions = data.entries.map((e) => e.action);
    for (const action of beforeActions) assert.ok(actions.includes(action), `migration lost audit action ${action}`);
    const migrationEntry = data.entries.find((e) => e.action === 'audit-key-migrated');
    assert.ok(migrationEntry, 'migration must be recorded in the new audit chain');
    assert.match(migrationEntry.detail || '', /^local-file [a-f0-9]{12} -> AUDIT_HMAC_KEY [a-f0-9]{12}$/);
  } finally { await stopServer(second); }

  // Simulate an interruption after the new chain was committed but before cleanup:
  // the old key + marker are still present. Startup must recognize that the
  // external chain is already valid and finish cleanup without re-signing again.
  fs.writeFileSync(localKey, oldLocalKeyBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'data', 'audit-key-migration.json'), JSON.stringify({ version: 1, createdAt: Date.now(), simulated: true }), { mode: 0o600 });

  let third;
  try {
    third = await startServer(root, { AUDIT_HMAC_KEY: secret });
    const auth = await login(third.base);
    const verify = await adminFetch(third.base, auth, '/api/audit/verify');
    const integrity = (await verify.json()).integrity;
    assert.equal(integrity.ok, true, JSON.stringify(integrity));
    assert.equal(integrity.keyMode, 'env');
    assert.equal(integrity.migration && integrity.migration.recovered, true, JSON.stringify(integrity.migration));
    assert.equal(fs.existsSync(localKey), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'audit-key-migration.json')), false);
  } finally { await stopServer(third); }
});

test('AUDIT_HMAC_KEY migration refuses to bless a tampered local chain', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let first;
  try {
    first = await startServer(root);
    await login(first.base);
  } finally { await stopServer(first); }

  const localKey = path.join(root, 'data', 'audit-chain.key');
  const chain = path.join(root, 'data', 'audit-chain.log');
  const original = fs.readFileSync(chain, 'utf8');
  const lines = original.trimEnd().split('\n');
  const entry = JSON.parse(lines[0]);
  entry.detail = 'tampered-before-migration';
  lines[0] = JSON.stringify(entry);
  fs.writeFileSync(chain, lines.join('\n') + '\n');

  let second;
  try {
    second = await startServer(root, { AUDIT_HMAC_KEY: 'new-key-that-must-not-bless-corruption-2026' });
    assert.equal(fs.existsSync(localKey), true, 'local key must be preserved when migration is refused');
    assert.match(second.getLogs(), /refusing AUDIT_HMAC_KEY migration: existing local-key chain is not valid/);
    assert.equal(fs.readFileSync(chain, 'utf8'), lines.join('\n') + '\n', 'migration refusal must not rewrite the damaged chain');
  } finally { await stopServer(second); }
});
