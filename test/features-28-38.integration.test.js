'use strict';

// Feature 28 — "request access" gate: a locked link shows a form; the admin approves;
// the same browser (cookie) is then let in automatically.
// Feature 38 — moderated visitor feedback on a shared file, private to the admin.

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

let child, base, root, auth, logs = '';

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
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
function cookieFrom(response, name) {
  const raw = response.headers.get('set-cookie') || '';
  const m = new RegExp('(?:^|, )(' + name + '=[^;]+)').exec(raw);
  return m ? m[1] : (raw.split(';', 1)[0]);
}
async function bodyJson(res) { return res.json().catch(() => ({})); }
function adminHeaders(extra = {}) { return { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, Origin: base, ...extra }; }
async function adminFetch(url, opts = {}) { return fetch(base + url, { ...opts, headers: adminHeaders(opts.headers || {}) }); }

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-28-38-'));
  for (const dir of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'private.txt'), 'top secret contents');
  fs.writeFileSync(path.join(root, 'host', 'public.txt'), 'nothing to hide here');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), BIND: '127.0.0.1', TRUST_PROXY: '1',
      ADMIN_USERNAME: 'gate-admin', ADMIN_PASSWORD: 'Gate-test-password-2026!',
      DATA_DIR: path.join(root, 'data'), HOST_ROOT: path.join(root, 'host'),
      INBOX_DIR: path.join(root, 'inbox'), IMAGES_DIR: path.join(root, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'gate-admin', password: 'Gate-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await bodyJson(login.clone())));
  auth = { cookie: cookieFrom(login, 'sid') || cookieFrom(login), csrf: (await bodyJson(login)).csrf };
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('feature 28 — locked link shows request form, admin approval auto-unlocks that browser', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/private.txt', requestAccess: true }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;
  assert.equal(share.requestAccess, true, 'requestAccess flag should persist');
  const token = share.token;

  // A fresh visitor is gated: 401 + the request form (not the file).
  const gated = await fetch(`${base}/s/${token}`, { redirect: 'manual' });
  assert.equal(gated.status, 401, 'locked link must not serve content');
  const gatedHtml = await gated.text();
  assert.match(gatedHtml, new RegExp(`/s/${token}/request-access`), 'should render the request form');
  assert.doesNotMatch(gatedHtml, /top secret/, 'must not leak content');

  // Submit the form → 302 back, and a per-link tracking cookie is set.
  const submit = await fetch(`${base}/s/${token}/request-access`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Alice Visitor', email: 'alice@example.com', message: 'please' }).toString(),
  });
  assert.equal(submit.status, 302, 'submission redirects');
  const reqCookie = cookieFrom(submit, 'dxreq_' + token);
  assert.match(reqCookie, new RegExp('^dxreq_' + token + '='), `expected a dxreq cookie, got ${reqCookie}`);

  // With the cookie, the visitor now sees a PENDING page (still 401, still no content).
  const pending = await fetch(`${base}/s/${token}`, { redirect: 'manual', headers: { Cookie: reqCookie } });
  assert.equal(pending.status, 401);
  assert.match(await pending.text(), /awaiting an administrator/i, 'pending status shown');

  // Admin sees exactly one pending request for this share.
  const list = await adminFetch('/api/access-requests');
  assert.equal(list.status, 200);
  const listData = await bodyJson(list);
  const mine = (listData.requests || []).filter((r) => r.shareId === share.id);
  assert.equal(mine.length, 1, JSON.stringify(listData));
  assert.equal(mine[0].status, 'pending');
  assert.equal(mine[0].name, 'Alice Visitor');
  const rid = mine[0].id;

  // A second, cookie-less browser is still gated (per-visitor, not global).
  const other = await fetch(`${base}/s/${token}`, { redirect: 'manual' });
  assert.equal(other.status, 401);

  // Admin approves.
  const approve = await adminFetch(`/api/shares/${share.id}/access-requests/${rid}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(approve.status, 200, JSON.stringify(await bodyJson(approve.clone())));

  // The approved browser is let in automatically; a cookie-less one is still blocked.
  const granted = await fetch(`${base}/s/${token}`, { redirect: 'manual', headers: { Cookie: reqCookie } });
  assert.equal(granted.status, 200, 'approved browser gets the file page');
  const stillBlocked = await fetch(`${base}/s/${token}`, { redirect: 'manual' });
  assert.equal(stillBlocked.status, 401, 'other browsers remain gated after one approval');

  // The approved browser can download the file.
  const dl = await fetch(`${base}/s/${token}/download`, { headers: { Cookie: reqCookie } });
  assert.equal(dl.status, 200);
  assert.equal((await dl.text()), 'top secret contents');
});

test('feature 28 — deny shows a declined page and never grants access', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/private.txt', requestAccess: true }),
  });
  const share = (await bodyJson(create)).share;
  const token = share.token;
  const submit = await fetch(`${base}/s/${token}/request-access`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Mallory' }).toString(),
  });
  const reqCookie = cookieFrom(submit, 'dxreq_' + token);
  const list = await bodyJson(await adminFetch('/api/access-requests'));
  const rid = list.requests.find((r) => r.shareId === share.id).id;
  const deny = await adminFetch(`/api/shares/${share.id}/access-requests/${rid}/deny`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(deny.status, 200);
  const denied = await fetch(`${base}/s/${token}`, { redirect: 'manual', headers: { Cookie: reqCookie } });
  assert.equal(denied.status, 401, 'denied request must not grant access');
  assert.match(await denied.text(), /declined/i);
});

test('feature 38 — visitors leave feedback that only the admin can read/manage', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/public.txt', allowFeedback: true }),
  });
  assert.equal(create.status, 201, JSON.stringify(await bodyJson(create.clone())));
  const share = (await bodyJson(create)).share;
  assert.equal(share.allowFeedback, true);
  const token = share.token;

  // The public file page shows the feedback form.
  const page = await fetch(`${base}/s/${token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`/s/${token}/feedback`), 'feedback form should be present');

  // A visitor submits feedback → redirect back with a flag.
  const submit = await fetch(`${base}/s/${token}/feedback`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Bob', body: 'Great file, thanks!' }).toString(),
  });
  assert.equal(submit.status, 302);
  assert.match(submit.headers.get('location') || '', /feedback=sent/);

  // Admin sees it as unread; the feedback is not visible on the public page.
  const list = await bodyJson(await adminFetch(`/api/shares/${share.id}/feedback`));
  assert.equal(list.feedback.length, 1, JSON.stringify(list));
  assert.equal(list.unread, 1);
  assert.equal(list.feedback[0].body, 'Great file, thanks!');
  assert.equal(list.feedback[0].name, 'Bob');
  const fid = list.feedback[0].id;
  const publicAgain = await (await fetch(`${base}/s/${token}`)).text();
  assert.doesNotMatch(publicAgain, /Great file, thanks/, 'feedback stays private to the admin');

  // Mark read, then delete.
  const read = await adminFetch(`/api/shares/${share.id}/feedback/${fid}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(read.status, 200);
  assert.equal((await bodyJson(read)).read, true);
  const del = await adminFetch(`/api/shares/${share.id}/feedback/${fid}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await bodyJson(await adminFetch(`/api/shares/${share.id}/feedback`));
  assert.equal(after.feedback.length, 0);
});

test('feature 38 — feedback is refused when the toggle is off', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/public.txt' }),
  });
  const share = (await bodyJson(create)).share;
  assert.equal(share.allowFeedback, false);
  const page = await (await fetch(`${base}/s/${share.token}`)).text();
  assert.doesNotMatch(page, new RegExp(`/s/${share.token}/feedback`), 'no form when disabled');
  const submit = await fetch(`${base}/s/${share.token}/feedback`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: 'sneaky' }).toString(),
  });
  assert.equal(submit.status, 404, 'feedback endpoint refuses when the share opted out');
});

test('features 28+38 — feedback on a gated link is blocked until access is approved', async () => {
  const create = await adminFetch('/api/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/private.txt', requestAccess: true, allowFeedback: true }),
  });
  const share = (await bodyJson(create)).share;
  const token = share.token;
  // Request access (pending) — get the tracking cookie.
  const submit = await fetch(`${base}/s/${token}/request-access`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Eve' }).toString(),
  });
  const reqCookie = cookieFrom(submit, 'dxreq_' + token);
  // Feedback is refused while unapproved (the access gate applies to /feedback too).
  const blocked = await fetch(`${base}/s/${token}/feedback`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: reqCookie },
    body: new URLSearchParams({ body: 'too soon' }).toString(),
  });
  assert.equal(blocked.status, 401, 'feedback blocked until access is approved');
  let fb = await bodyJson(await adminFetch(`/api/shares/${share.id}/feedback`));
  assert.equal(fb.feedback.length, 0, 'nothing stored while gated');
  // Approve, then feedback goes through.
  const rid = (await bodyJson(await adminFetch('/api/access-requests'))).requests.find((r) => r.shareId === share.id).id;
  await adminFetch(`/api/shares/${share.id}/access-requests/${rid}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const ok = await fetch(`${base}/s/${token}/feedback`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: reqCookie },
    body: new URLSearchParams({ body: 'now it works' }).toString(),
  });
  assert.equal(ok.status, 302, 'feedback accepted once approved');
  fb = await bodyJson(await adminFetch(`/api/shares/${share.id}/feedback`));
  assert.equal(fb.feedback.length, 1, 'stored after approval');
  assert.equal(fb.feedback[0].body, 'now it works');
});
