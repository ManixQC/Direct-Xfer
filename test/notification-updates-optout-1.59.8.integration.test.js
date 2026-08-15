'use strict';
const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_USER = 'updates-optout-admin';
const ADMIN_PASS = 'Updates-optout-2026!';
let child = null;
let logs = '';
let tempRoot = null;
let base = '';
let port = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((err) => err ? reject(err) : resolve(p));
    });
  });
}
async function waitForServer() {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early (${child.exitCode})\n${logs}`);
    try {
      const r = await fetch(`${base}/api/meta`, { cache:'no-store' });
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
function firstCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const first = raw.split(';', 1)[0];
  assert.match(first, /^[^=]+=.+$/);
  return first;
}
async function startServer() {
  logs = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd:ROOT,
    env:{
      ...process.env,
      PORT:String(port), BIND:'127.0.0.1', ADMIN_USERNAME:ADMIN_USER, ADMIN_PASSWORD:ADMIN_PASS,
      DATA_DIR:path.join(tempRoot,'data'), HOST_ROOT:path.join(tempRoot,'host'),
      INBOX_DIR:path.join(tempRoot,'inbox'), IMAGES_DIR:path.join(tempRoot,'images'),
      UPDATE_CHECK:'false', PUBLIC_URL:base,
    },
    stdio:['ignore','pipe','pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer();
}
async function stopServer() {
  if (!child || child.exitCode != null) { child = null; return; }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (child && child.exitCode == null) child.kill('SIGKILL');
  child = null;
}
async function login() {
  const r = await fetch(`${base}/api/login`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASS}),
  });
  assert.equal(r.status, 200, logs);
  const cookie = firstCookie(r);
  const body = await r.json();
  assert.ok(body.csrf);
  return { cookie, csrf:body.csrf };
}

after(async () => {
  await stopServer();
  if (tempRoot) fs.rmSync(tempRoot, { recursive:true, force:true });
});

test('muting Updates suppresses both queued and startup update notifications', async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-updates-optout-'));
  for (const n of ['data','host','inbox','images']) fs.mkdirSync(path.join(tempRoot,n), { recursive:true });

  await startServer();
  const first = await login();
  const save = await fetch(`${base}/api/notifications/prefs`, {
    method:'POST',
    headers:{'Content-Type':'application/json','X-CSRF-Token':first.csrf,Cookie:first.cookie,Origin:base},
    body:JSON.stringify({ mutedCategories:['updates'] }),
  });
  assert.equal(save.status, 200, logs);
  const saved = await save.json();
  assert.ok(saved.mutedCategories.includes('updates'));
  await stopServer();

  const storeFile = path.join(tempRoot, 'data', 'shares.json');
  const state = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const owner = state.meta.accounts.find((a) => a && a.username === ADMIN_USER);
  assert.ok(owner && owner.id, 'owner account missing from persisted state');
  state.meta.notificationReadStateVersion = 1;
  state.meta.notificationCategorySchemaVersion = 3;
  state.meta.notificationLastAppVersion = '1.59.7'; // forces the 1.59.8 startup update-installed path
  state.meta.notifications = Array.isArray(state.meta.notifications) ? state.meta.notifications : [];
  state.meta.notifications.unshift({
    id:'stale-update-before-delivery', accountId:owner.id, type:'update-available',
    at:Date.now(), category:'updates', severity:'info', latest:'9.9.9', readAt:null,
  });
  fs.writeFileSync(storeFile, JSON.stringify(state, null, 2));

  await startServer();
  const second = await login();
  const prefs = await fetch(`${base}/api/notifications/prefs`, { headers:{Cookie:second.cookie}, cache:'no-store' });
  assert.equal(prefs.status, 200, logs);
  const prefBody = await prefs.json();
  assert.ok(prefBody.mutedCategories.includes('updates'), 'Updates mute did not survive restart');

  const notifications = await fetch(`${base}/api/notifications`, { headers:{Cookie:second.cookie}, cache:'no-store' });
  assert.equal(notifications.status, 200, logs);
  const body = await notifications.json();
  assert.ok(Array.isArray(body.notifications));
  assert.equal(body.notifications.some((n) => n.category === 'updates'), false, 'muted Updates rows leaked through notification delivery');
  assert.equal(body.notifications.some((n) => n.type === 'update-installed' || n.type === 'update-available'), false);

  // The startup detector should not even create update-installed when Updates is muted.
  await new Promise((r) => setTimeout(r, 250));
  const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const ownerAfter = persisted.meta.accounts.find((a) => a && a.id === owner.id);
  assert.ok(ownerAfter.notifMutedCategories.includes('updates'));
  assert.equal((persisted.meta.notifications || []).some((n) => n.type === 'update-installed'), false, 'update-installed was stored despite opt-out');
});
