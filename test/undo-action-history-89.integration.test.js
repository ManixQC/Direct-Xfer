'use strict';

// Integration tests for feature #89 — undoable admin action history.
// A bounded, persisted, chronological log of destructive admin actions, each
// reversible in one click. Verified here: settings changes and share deletion
// are recorded, listed via /api/undo, reversed, and reversal is idempotent.

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
function jsonHeaders() { return { 'Content-Type': 'application/json' }; }
function adminHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) }); }

async function getSettings() { return bodyJson(await adminFetch('/api/settings')); }
async function postSettings(patch) { return adminFetch('/api/settings', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(patch) }); }
async function undoList() { return (await bodyJson(await adminFetch('/api/undo'))).items || []; }
async function undo(id) { return adminFetch('/api/undo/' + encodeURIComponent(id), { method: 'POST', headers: jsonHeaders(), body: '{}' }); }
async function shares() { return (await bodyJson(await adminFetch('/api/shares'))).shares || []; }
function newestOfType(items, type) { return items.find((e) => e.type === type) || null; }

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-undo89-'));
  for (const d of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'undo-me.txt'), 'delete then restore me');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'undo-admin', ADMIN_PASSWORD: 'Undo-history-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ username: 'undo-admin', password: 'Undo-history-2026!' }) });
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

test('a settings change is recorded and undo restores the previous value', async () => {
  const original = (await getSettings()).announcement || '';
  const r = await postSettings({ announcement: 'UNDO-TEST-BANNER' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  assert.equal((await getSettings()).announcement, 'UNDO-TEST-BANNER', 'change applied');

  const entry = newestOfType(await undoList(), 'settings-changed');
  assert.ok(entry && !entry.undone, 'settings change logged as undoable');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shares.json'), 'utf8'));
  assert.ok((onDisk.undoLog || []).some((e) => e.id === entry.id), 'Undo descriptor is durable before the mutation response completes');

  const u = await undo(entry.id);
  assert.equal(u.status, 200, JSON.stringify(await bodyJson(u.clone())));
  assert.equal((await getSettings()).announcement, original, 'undo restored the prior value');

  const after = (await undoList()).find((e) => e.id === entry.id);
  assert.ok(after && after.undone, 'entry now marked undone');

  const again = await undo(entry.id);
  assert.equal(again.status, 409, 'undoing an already-undone action is refused');
});

test('deleting a share is undoable and restores the live link', async () => {
  const created = await adminFetch('/api/shares', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ path: '/undo-me.txt' }) });
  assert.equal(created.status, 201, JSON.stringify(await bodyJson(created.clone())));
  const share = (await bodyJson(created)).share;

  const del = await adminFetch('/api/shares/' + encodeURIComponent(share.id), { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(await bodyJson(del.clone())));
  assert.ok(!(await shares()).some((s) => s.id === share.id), 'share removed from the live list');

  const entry = newestOfType(await undoList(), 'share-trashed');
  assert.ok(entry && !entry.undone, 'deletion logged as undoable');

  const u = await undo(entry.id);
  assert.equal(u.status, 200, JSON.stringify(await bodyJson(u.clone())));
  assert.ok((await shares()).some((s) => s.token === share.token), 'undo restored the share from trash');
});




test('standard bulk revoke records each removed share as an independent Undo entry', async () => {
  const priorIds=new Set((await undoList()).map((e)=>e.id));
  const made=[];
  for (const name of ['bulk-a','bulk-b']) {
    const r=await adminFetch('/api/shares',{method:'POST',headers:jsonHeaders(),body:JSON.stringify({path:'/undo-me.txt',name})});
    assert.equal(r.status,201,JSON.stringify(await bodyJson(r.clone())));made.push((await bodyJson(r)).share);
  }
  const r=await adminFetch('/api/shares/bulk',{method:'POST',headers:jsonHeaders(),body:JSON.stringify({ids:made.map((x)=>x.id),action:'revoke'})});
  assert.equal(r.status,200,JSON.stringify(await bodyJson(r.clone())));
  const entries=(await undoList()).filter((e)=>e.type==='share-trashed'&&!priorIds.has(e.id)).slice(0,2);
  assert.equal(entries.length,2,'bulk revoke creates two fresh history entries');
  assert.ok(entries.every((e)=>e.canUndo),'each bulk-revoked share gets its own Undo');
  for(const e of entries) assert.equal((await undo(e.id)).status,200);
  const live=await shares();
  assert.ok(made.every((share)=>live.some((row)=>row.id===share.id)),'both shares are restored');
});

test('an older settings Undo is blocked when the same setting changed again', async () => {
  const original = (await getSettings()).announcement || '';
  let r = await postSettings({ announcement: 'UNDO-CONFLICT-FIRST' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const first = newestOfType(await undoList(), 'settings-changed');
  assert.ok(first && first.canUndo, 'first change starts undoable');

  r = await postSettings({ announcement: 'UNDO-CONFLICT-SECOND' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const items = await undoList();
  const second = newestOfType(items, 'settings-changed');
  const staleFirst = items.find((e) => e.id === first.id);
  assert.ok(second && second.id !== first.id && second.canUndo, 'newest change remains undoable');
  assert.ok(staleFirst && staleFirst.canUndo === false, 'older conflicting change is disabled');
  assert.equal(staleFirst.unavailableReason, 'state-changed');

  const blocked = await undo(first.id);
  assert.equal(blocked.status, 409, 'stale Undo is refused instead of clobbering newer state');
  assert.equal((await getSettings()).announcement, 'UNDO-CONFLICT-SECOND');

  assert.equal((await undo(second.id)).status, 200, 'undo newest change first');
  const firstAgain = (await undoList()).find((e) => e.id === first.id);
  assert.ok(firstAgain && firstAgain.canUndo, 'older action becomes safe again once current state matches its post-action snapshot');
  assert.equal((await undo(first.id)).status, 200);
  assert.equal((await getSettings()).announcement, original);
});



test('recipient Undo refuses to overwrite recipient changes made afterward', async () => {
  const created = await adminFetch('/api/shares', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ path: '/undo-me.txt' }) });
  assert.equal(created.status, 201, JSON.stringify(await bodyJson(created.clone())));
  const share = (await bodyJson(created)).share;
  let r = await adminFetch('/api/shares/' + encodeURIComponent(share.id) + '/recipients', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ names:['Alice'] }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  let live = (await bodyJson(r)).share;
  const alice = (live.recipients || []).find((x) => x.name === 'Alice');
  assert.ok(alice && alice.token);
  r = await adminFetch('/api/shares/' + encodeURIComponent(share.id) + '/recipients/' + encodeURIComponent(alice.token), { method: 'DELETE' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const removed = newestOfType(await undoList(), 'recipient-removed');
  assert.ok(removed && removed.canUndo);

  r = await adminFetch('/api/shares/' + encodeURIComponent(share.id) + '/recipients', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ names:['Bob'] }) });
  assert.equal(r.status, 201, JSON.stringify(await bodyJson(r.clone())));
  const stale = (await undoList()).find((e) => e.id === removed.id);
  assert.ok(stale && stale.canUndo === false);
  assert.equal(stale.unavailableReason, 'state-changed');
  assert.equal((await undo(removed.id)).status, 409);
  live = (await shares()).find((x) => x.id === share.id);
  assert.deepEqual((live.recipients || []).map((x) => x.name), ['Bob'], 'newer recipient state is preserved');
});

test('manual trash restore marks its deletion Undo as already restored', async () => {
  const created = await adminFetch('/api/shares', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ path: '/undo-me.txt' }) });
  assert.equal(created.status, 201, JSON.stringify(await bodyJson(created.clone())));
  const share = (await bodyJson(created)).share;
  const del = await adminFetch('/api/shares/' + encodeURIComponent(share.id), { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(await bodyJson(del.clone())));
  const deleted = await bodyJson(del);
  const entry = newestOfType(await undoList(), 'share-trashed');
  assert.ok(entry && entry.canUndo);
  const restored = await adminFetch('/api/trash/' + encodeURIComponent(deleted.trashId) + '/restore', { method: 'POST', headers: jsonHeaders(), body: '{}' });
  assert.equal(restored.status, 200, JSON.stringify(await bodyJson(restored.clone())));
  const after = (await undoList()).find((e) => e.id === entry.id);
  assert.ok(after && after.canUndo === false);
  assert.equal(after.unavailableReason, 'already-restored');
  assert.equal((await undo(entry.id)).status, 410);
});


test('clearing IP nicknames is undoable but refuses to overwrite a newer nickname', async () => {
  let r = await adminFetch('/api/ip-names', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ip:'203.0.113.5', name:'Alice device' }) });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  r = await adminFetch('/api/ip-names', { method: 'DELETE' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const cleared = newestOfType(await undoList(), 'ip-names-cleared');
  assert.ok(cleared && cleared.canUndo, 'clear-all action is recorded');

  r = await adminFetch('/api/ip-names', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ip:'203.0.113.6', name:'Newer device' }) });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const stale = (await undoList()).find((e) => e.id === cleared.id);
  assert.ok(stale && stale.canUndo === false);
  assert.equal(stale.unavailableReason, 'state-changed');
  assert.equal((await undo(cleared.id)).status, 409, 'Undo cannot erase a nickname created after the clear');

  await adminFetch('/api/ip-names', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ip:'203.0.113.6', name:'' }) });
  const safeAgain = (await undoList()).find((e) => e.id === cleared.id);
  assert.ok(safeAgain && safeAgain.canUndo, 'clear Undo becomes safe again once state matches its post-action snapshot');
  assert.equal((await undo(cleared.id)).status, 200);
});

test('resetting share statistics records an exact baseline and can restore the prior baseline', async () => {
  const created = await adminFetch('/api/shares', { method:'POST', headers:jsonHeaders(), body:JSON.stringify({ path:'/undo-me.txt' }) });
  assert.equal(created.status, 201, JSON.stringify(await bodyJson(created.clone())));
  const share = (await bodyJson(created)).share;
  let r = await adminFetch('/api/shares/' + encodeURIComponent(share.id) + '/reset-stats', { method:'POST', headers:jsonHeaders(), body:'{}' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const firstReset = newestOfType(await undoList(), 'share-stats-reset');
  assert.ok(firstReset && firstReset.canUndo);
  assert.equal((await undo(firstReset.id)).status, 200);
  const live = (await shares()).find((s) => s.id === share.id);
  assert.ok(live);
  assert.equal(Object.prototype.hasOwnProperty.call(live, 'statsBaseline'), false, 'Undo removes a baseline that did not exist before the reset');
});


test('full backup restore preserves and sanitizes the Undo journal snapshot', async () => {
  let r = await postSettings({ announcement:'UNDO-BACKUP-SNAPSHOT' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const savedEntry = newestOfType(await undoList(), 'settings-changed');
  assert.ok(savedEntry && savedEntry.canUndo);

  const backupResponse = await adminFetch('/api/backup/download');
  assert.equal(backupResponse.status, 200);
  const backupBytes = Buffer.from(await backupResponse.arrayBuffer());
  assert.ok(backupBytes.length > 100);

  r = await postSettings({ announcement:'UNDO-AFTER-BACKUP' });
  assert.equal(r.status, 200, JSON.stringify(await bodyJson(r.clone())));
  const laterEntry = newestOfType(await undoList(), 'settings-changed');
  assert.ok(laterEntry && laterEntry.id !== savedEntry.id);

  const restore = await adminFetch('/api/restore', { method:'POST', headers:{ 'Content-Type':'application/octet-stream' }, body:backupBytes });
  assert.equal(restore.status, 200, JSON.stringify(await bodyJson(restore.clone())));

  const login = await fetch(base + '/api/login', { method:'POST', headers:jsonHeaders(), body:JSON.stringify({ username:'undo-admin', password:'Undo-history-2026!' }) });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie:cookieFrom(login), csrf:(await bodyJson(login)).csrf };

  const restoredItems = await undoList();
  assert.ok(restoredItems.some((e) => e.id === savedEntry.id), 'Undo history included in the backup is restored');
  assert.equal(restoredItems.some((e) => e.id === laterEntry.id), false, 'actions created after the backup do not leak through restore');
  assert.equal((await getSettings()).announcement, 'UNDO-BACKUP-SNAPSHOT');
});

test('the undo log is bounded and rejects an unknown id', async () => {
  const items = await undoList();
  assert.ok(items.length <= 25, 'log stays within its bound');
  const bogus = await undo('deadbeefdeadbeef');
  assert.equal(bogus.status, 404, 'unknown undo id is 404');
});
