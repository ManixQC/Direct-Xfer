'use strict';
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, tempRoot, logs = '';
const ADMIN_USER = 'notification-runtime-admin';
const ADMIN_PASS = 'Notification-runtime-2026!';

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
async function waitForServer(url) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try { const r = await fetch(url, { cache:'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
async function json(response) { return response.json().catch(() => ({})); }
function firstCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const first = raw.split(';', 1)[0];
  assert.match(first, /^[^=]+=.+$/);
  return first;
}
function pwaCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const m = raw.match(/(?:^|,\s*)(dxpwa=[^;]+)/);
  if (m) return m[1];
  return firstCookie(response);
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-notification-runtime-'));
  for (const n of ['data','host','inbox','images']) fs.mkdirSync(path.join(tempRoot,n), { recursive:true });
  child = spawn(process.execPath, ['server.js'], {
    cwd:path.resolve(__dirname, '..'),
    env:{ ...process.env, PORT:String(port), BIND:'127.0.0.1', ADMIN_USERNAME:ADMIN_USER, ADMIN_PASSWORD:ADMIN_PASS,
      DATA_DIR:path.join(tempRoot,'data'), HOST_ROOT:path.join(tempRoot,'host'), INBOX_DIR:path.join(tempRoot,'inbox'),
      IMAGES_DIR:path.join(tempRoot,'images'), UPDATE_CHECK:'false', PUBLIC_URL:base },
    stdio:['ignore','pipe','pipe']
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive:true, force:true });
});

test('standard and paired-PWA notification reads execute without runtime errors', async () => {
  const login = await fetch(`${base}/api/login`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASS})
  });
  assert.equal(login.status, 200, logs);
  const adminCookie = firstCookie(login);
  const loginBody = await json(login);
  assert.ok(loginBody.csrf);

  const adminNotifications = await fetch(`${base}/api/notifications`, { headers:{ Cookie:adminCookie }, cache:'no-store' });
  assert.equal(adminNotifications.status, 200, logs);
  const adminBody = await json(adminNotifications);
  assert.ok(Array.isArray(adminBody.notifications));
  const loginNote = adminBody.notifications.find((n) => n.type === 'admin-login');
  assert.ok(loginNote);
  assert.equal(loginNote.unread, true, 'new notifications start unread');
  assert.equal(loginNote.readAt, 0);

  const markAdminRead = await fetch(`${base}/api/notifications/read`, {
    method:'POST', headers:{'X-CSRF-Token':loginBody.csrf,Cookie:adminCookie,Origin:base}
  });
  assert.equal(markAdminRead.status, 200, logs);
  const markAdminBody = await json(markAdminRead);
  assert.ok(markAdminBody.marked >= 1);
  assert.ok(Array.isArray(markAdminBody.ids) && markAdminBody.ids.includes(loginNote.id));
  assert.ok(Array.isArray(markAdminBody.existingIds) && markAdminBody.existingIds.includes(loginNote.id));
  const markAdminAgain = await fetch(`${base}/api/notifications/read`, {
    method:'POST', headers:{'X-CSRF-Token':loginBody.csrf,Cookie:adminCookie,Origin:base}
  });
  assert.equal(markAdminAgain.status, 200, logs);
  const markAdminAgainBody = await json(markAdminAgain);
  assert.equal(markAdminAgainBody.marked, 0);
  assert.ok(markAdminAgainBody.ids.includes(loginNote.id), 'already-read ids are still authoritative for stale clients');
  assert.ok(markAdminAgainBody.existingIds.includes(loginNote.id));
  const adminAfterRead = await json(await fetch(`${base}/api/notifications`, { headers:{Cookie:adminCookie}, cache:'no-store' }));
  assert.equal(adminAfterRead.notifications.find((n) => n.id === loginNote.id).unread, false);
  assert.ok(adminAfterRead.notifications.find((n) => n.id === loginNote.id).readAt > 0);

  const register = await fetch(`${base}/app/device/register`, {
    method:'POST',
    headers:{'Content-Type':'application/json','X-CSRF-Token':loginBody.csrf,Cookie:adminCookie,Origin:base},
    body:JSON.stringify({name:'Notification test device'})
  });
  assert.equal(register.status, 200, logs);
  const deviceCookie = pwaCookie(register);

  const pwaNotifications = await fetch(`${base}/app/notifications`, { headers:{ Cookie:deviceCookie }, cache:'no-store' });
  assert.equal(pwaNotifications.status, 200, logs);
  const pwaBody = await json(pwaNotifications);
  assert.ok(Array.isArray(pwaBody.notifications));
  const pairedNote = pwaBody.notifications.find((n) => n.type === 'pwa-device-paired');
  assert.ok(pairedNote);
  assert.equal(pairedNote.unread, true, 'PWA sees newly-created account notification as unread');

  const deviceStatus = await json(await fetch(`${base}/app/device/status`, { headers:{Cookie:deviceCookie}, cache:'no-store' }));
  assert.ok(deviceStatus.csrf);
  const markPwaRead = await fetch(`${base}/app/notifications/read`, {
    method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':deviceStatus.csrf,Cookie:deviceCookie,Origin:base}, body:'{}'
  });
  assert.equal(markPwaRead.status, 200, logs);
  const pwaMarked = await json(markPwaRead);
  assert.ok(pwaMarked.ids.includes(pairedNote.id));
  const adminSynced = await json(await fetch(`${base}/api/notifications`, { headers:{Cookie:adminCookie}, cache:'no-store' }));
  assert.equal(adminSynced.notifications.find((n) => n.id === pairedNote.id).unread, false, 'PWA read state is shared with standard UI');
  assert.doesNotMatch(logs, /notificationsForAccount is not defined/);
});
