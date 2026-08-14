'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const USER = 'own-device-owner';
const PASS = 'Own-device-test-2026!';
let child, root, logs = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
async function wait(url) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (child && child.exitCode != null) throw new Error('server exited\n' + logs);
    try { const r = await fetch(url, { cache:'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server timeout\n' + logs);
}
async function body(r) { return r.json().catch(() => ({})); }
function cookie(raw, name) {
  const m = new RegExp('(?:^|,\\s*)' + name + '=([^; ,]+)').exec(raw || '');
  assert.ok(m, `missing ${name} cookie in ${raw}`);
  return `${name}=${m[1]}`;
}
async function login(base, userAgent, extraCookie = '', route = '/api/login') {
  const r = await fetch(base + route, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'User-Agent':userAgent, ...(extraCookie ? { Cookie:extraCookie } : {}) },
    body:JSON.stringify({ username:USER, password:PASS, deviceName:'Trusted phone' })
  });
  assert.equal(r.status, 200, logs);
  const d = await body(r);
  return { response:r, data:d, sid:cookie(r.headers.get('set-cookie') || '', 'sid') };
}
async function notes(base, sid) {
  const r = await fetch(base + '/api/notifications', { headers:{ Cookie:sid }, cache:'no-store' });
  assert.equal(r.status, 200, logs);
  return (await body(r)).notifications || [];
}
function adminLoginCount(rows) { return rows.filter((n) => n.type === 'admin-login').length; }
function unusualCount(rows) { return rows.filter((n) => n.type === 'admin-login-unusual').length; }

test('recognized own devices do not create administrator-login notifications', async (t) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-own-login-device-'));
  for (const n of ['data','host','inbox','images']) fs.mkdirSync(path.join(root, n), { recursive:true });
  t.after(async () => {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 2500))]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive:true, force:true });
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd:path.resolve(__dirname, '..'),
    env:{ ...process.env, PORT:String(port), BIND:'127.0.0.1', ADMIN_USERNAME:USER, ADMIN_PASSWORD:PASS,
      DATA_DIR:path.join(root,'data'), HOST_ROOT:path.join(root,'host'), INBOX_DIR:path.join(root,'inbox'),
      IMAGES_DIR:path.join(root,'images'), UPDATE_CHECK:'false', PUBLIC_URL:base, TRUST_PROXY:'false' },
    stdio:['ignore','pipe','pipe']
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await wait(base + '/api/meta');

  // First sighting of a browser is still security-relevant and must notify.
  const first = await login(base, 'DX-Trusted-Desktop/1');
  let rows = await notes(base, first.sid);
  const initialAdmin = adminLoginCount(rows);
  const initialUnusual = unusualCount(rows);
  assert.equal(initialAdmin, 1, JSON.stringify(rows));
  assert.equal(initialUnusual, 1, JSON.stringify(rows));

  // Re-login from the same remembered browser/IP: audit it, but do not notify again.
  const second = await login(base, 'DX-Trusted-Desktop/1');
  rows = await notes(base, second.sid);
  assert.equal(adminLoginCount(rows), initialAdmin, JSON.stringify(rows));
  assert.equal(unusualCount(rows), initialUnusual, JSON.stringify(rows));

  // Pair a PWA device owned by this account.
  const reg = await fetch(base + '/app/device/register', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':second.data.csrf, Cookie:second.sid, Origin:base },
    body:JSON.stringify({ name:'My paired phone' })
  });
  assert.equal(reg.status, 200, logs);
  const dxpwa = cookie(reg.headers.get('set-cookie') || '', 'dxpwa');

  // Change User-Agent so the legacy UA+IP fingerprint looks new. The verified
  // paired-device credential must still identify this as the owner's own device.
  const pwaRelogin = await login(base, 'DX-Trusted-Phone-Changed-UA/99', dxpwa, '/app/login');
  rows = await notes(base, pwaRelogin.sid);
  assert.equal(adminLoginCount(rows), initialAdmin, JSON.stringify(rows));
  assert.equal(unusualCount(rows), initialUnusual, JSON.stringify(rows));

  // The login must remain present in the durable audit trail despite suppression.
  const auditResponse = await fetch(base + '/api/audit', { headers:{ Cookie:pwaRelogin.sid }, cache:'no-store' });
  assert.equal(auditResponse.status, 200, logs);
  const audit = await body(auditResponse);
  const loginRows = (audit.audit || audit.entries || []).filter((e) => e.action === 'login');
  assert.ok(loginRows.length >= 3, JSON.stringify(audit));
  assert.ok(loginRows.some((e) => e.detail === 'known device'));
  assert.ok(loginRows.some((e) => e.detail === 'paired device'));
});

test('login audit suppression is scoped to notifications, not audit logging', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /if \(!opts\.suppressSecurityAlert\) maybeSecurityAlert\(entry\)/);
  assert.match(src, /recognizedOwnDevice = knownLoginDevice \|\| ownPairedDevice/);
  assert.match(src, /recognizedOwnDevice \? null : addCenterNotification\(acc\.id, 'admin-login'/);
});
