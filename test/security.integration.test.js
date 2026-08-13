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
let tempRoot;
let logs = '';
let adminAuth;

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

async function json(response) {
  return response.json().catch(() => ({}));
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-security-'));
  for (const name of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, name), { recursive: true });
  // Minimal valid 1×1 PNG used to verify the authenticated source-stream route
  // that feeds browser-side EXIF/GPS cleaning for host-picker images.
  fs.writeFileSync(path.join(tempRoot, 'host', 'sample.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64'));

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      ADMIN_USERNAME: 'security-admin',
      ADMIN_PASSWORD: 'Security-test-password-2026!',
      DATA_DIR: path.join(tempRoot, 'data'),
      HOST_ROOT: path.join(tempRoot, 'host'),
      INBOX_DIR: path.join(tempRoot, 'inbox'),
      IMAGES_DIR: path.join(tempRoot, 'images'),
      UPDATE_CHECK: 'false',
      PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  await waitForServer(`${base}/api/meta`);
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
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('the mobile entry requires the dedicated admin login before serving the PWA shell', async () => {
  const bare = await fetch(`${base}/app`, {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });
  assert.equal(bare.status, 302);
  assert.match(bare.headers.get('location') || '', /^\/app\/login\?next=/);

  const shellWithoutSession = await fetch(`${base}/app/`, {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });
  assert.equal(shellWithoutSession.status, 302);
  assert.equal(shellWithoutSession.headers.get('location'), '/app/login?next=%2Fapp%2F');

  const mobileLogin = await fetch(`${base}/app/login?next=%2Fapp%2F`, {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });
  assert.equal(mobileLogin.status, 200);
  assert.match(mobileLogin.headers.get('content-type') || '', /text\/html/);
  assert.match(await mobileLogin.text(), /<title>Direct-Xfer — Connexion mobile<\/title>/);

  const status = await fetch(`${base}/app/device/status`, {
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  });
  assert.equal(status.status, 401);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security-admin', password: 'Security-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const sessionCookie = cookieFrom(login);

  const authenticatedShell = await fetch(`${base}/app/`, {
    redirect: 'manual',
    headers: { Accept: 'text/html', Cookie: sessionCookie },
  });
  assert.equal(authenticatedShell.status, 200);
  const html = await authenticatedShell.text();
  assert.match(html, /<title>Direct-Xfer — Envoyer<\/title>/);

  const loginAgain = await fetch(`${base}/app/login?next=%2Fapp%2F`, {
    redirect: 'manual',
    headers: { Accept: 'text/html', Cookie: sessionCookie },
  });
  assert.equal(loginAgain.status, 302);
  assert.equal(loginAgain.headers.get('location'), '/app/');
});

test('WebAPK installation assets are direct 200 responses without authentication redirects', async () => {
  const worker = await fetch(`${base}/direct-xfer-pwa-sw.js?v=79`, { redirect: 'manual' });
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('location'), null);
  assert.match(worker.headers.get('content-type') || '', /application\/javascript/);
  assert.equal(worker.headers.get('service-worker-allowed'), '/app/');
  assert.match(await worker.text(), /-pwa\d+/);

  const manifestResponse = await fetch(`${base}/direct-xfer-pwa.webmanifest?v=79`, { redirect: 'manual' });
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifestResponse.headers.get('location'), null);
  assert.match(manifestResponse.headers.get('content-type') || '', /application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, '/app/launch');
  assert.equal(manifest.scope, '/app/');

  const launch = await fetch(`${base}/app/launch`, {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });
  assert.equal(launch.status, 200);
  assert.equal(launch.headers.get('location'), null);
  assert.match(await launch.text(), /http-equiv="refresh" content="0;url=\/app\/"/);
});

test('paired PWA mutations require exact origin and device CSRF', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security-admin', password: 'Security-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const loginData = await json(login);
  const adminCookie = cookieFrom(login);
  assert.ok(loginData.csrf);

  const register = await fetch(`${base}/app/device/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginData.csrf,
      Cookie: adminCookie,
      Origin: base,
    },
    body: JSON.stringify({ name: 'Security test PWA' }),
  });
  assert.equal(register.status, 200, JSON.stringify(await json(register.clone())));
  const deviceCookie = cookieFrom(register);

  const status = await fetch(`${base}/app/device/status`, { headers: { Cookie: deviceCookie } });
  assert.equal(status.status, 200);
  const deviceData = await json(status);
  assert.equal(deviceData.paired, true);
  assert.ok(deviceData.csrf, 'paired device must receive its own CSRF token');

  const noOrigin = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceData.csrf, Cookie: deviceCookie },
    body: JSON.stringify({ name: 'No origin' }),
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await json(noOrigin)).error, 'invalid-origin');

  const foreignOrigin = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceData.csrf, Cookie: deviceCookie, Origin: 'http://evil.example.test' },
    body: JSON.stringify({ name: 'Foreign origin' }),
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await json(foreignOrigin)).error, 'invalid-origin');

  const noCsrf = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ name: 'No CSRF' }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await json(noCsrf)).error, 'invalid-csrf');

  const wrongContentType = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': deviceData.csrf, Cookie: deviceCookie, Origin: base },
    body: '{}',
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal((await json(wrongContentType)).error, 'json-required');

  const created = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceData.csrf, Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ name: 'Owned by device' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  const share = await json(created);
  assert.ok(share.token);

  const revokeWithoutCsrf = await fetch(`${base}/app/device/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ revokeShares: true }),
  });
  assert.equal(revokeWithoutCsrf.status, 403);

  const revoked = await fetch(`${base}/app/device/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': deviceData.csrf, Cookie: deviceCookie, Origin: base },
    body: JSON.stringify({ revokeShares: true }),
  });
  assert.equal(revoked.status, 200, JSON.stringify(await json(revoked.clone())));
  const revokedData = await json(revoked);
  assert.equal(revokedData.revokedShares, 1);

  const staleStatus = await fetch(`${base}/app/device/status`, { headers: { Cookie: deviceCookie } });
  assert.equal(staleStatus.status, 401);

  const removedShare = await fetch(`${base}/u/${encodeURIComponent(share.token)}`);
  assert.equal(removedShare.status, 404);

  // Keep the admin session data for the public-message test.
  adminAuth = { cookie: adminCookie, csrf: loginData.csrf };
});

test('Images page can securely stream a host image for local metadata cleaning', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security-admin', password: 'Security-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const loginData = await json(login);
  const cookie = cookieFrom(login);

  const source = await fetch(`${base}/api/photos/source`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginData.csrf,
      Cookie: cookie,
      Origin: base,
    },
    body: JSON.stringify({ path: '/sample.png' }),
  });
  assert.equal(source.status, 200, JSON.stringify(await json(source.clone())));
  assert.equal(source.headers.get('content-type'), 'image/png');
  assert.equal(decodeURIComponent(source.headers.get('x-direct-xfer-filename') || ''), 'sample.png');
  assert.equal(source.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await source.arrayBuffer());
  assert.ok(bytes.length > 32);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');

  const traversal = await fetch(`${base}/api/photos/source`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginData.csrf,
      Cookie: cookie,
      Origin: base,
    },
    body: JSON.stringify({ path: '/../data/shares.json' }),
  });
  assert.equal(traversal.status, 400);
});

test('public reception messages are deduplicated and rate-limited', async () => {
  const admin = adminAuth;
  assert.ok(admin);
  const created = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': admin.csrf,
      Cookie: admin.cookie,
      Origin: base,
    },
    body: JSON.stringify({ name: 'Message limiter' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  const { token } = await json(created);

  const send = (message) => fetch(`${base}/u/${encodeURIComponent(token)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  const first = await send('message-1');
  assert.equal(first.status, 200);
  assert.equal((await json(first)).duplicate, undefined);

  const duplicate = await send('message-1');
  assert.equal(duplicate.status, 200);
  assert.equal((await json(duplicate)).duplicate, true);

  for (let i = 2; i <= 5; i += 1) {
    const response = await send(`message-${i}`);
    assert.equal(response.status, 200, `message ${i} should pass`);
  }

  const limited = await send('message-6');
  assert.equal(limited.status, 429);
  const limitedData = await json(limited);
  assert.equal(limitedData.error, 'rate-limited');
  assert.ok(limitedData.retryAfter >= 1);
});

test('PWA source keeps revocation status separate from success and protects stored keys', () => {
  const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'pwa', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'pwa', 'index.html'), 'utf8');
  assert.equal((appSource.match(/revokeSuccess:/g) || []).length, 3);
  assert.ok((appSource.match(/\brevoked:/g) || []).length >= 3);
  assert.match(appSource, /if \(copy\.remembered !== true \|\| copy\.rememberKey !== true\) copy\.key = '';/);
  assert.match(html, /id="dest-remember-key"/);
  assert.match(html, /<a id="admin-home-link"[^>]+href="\/"[^>]*>/);
  assert.equal((appSource.match(/openAdmin:/g) || []).length, 3);
});

test('PWA image API reports dimensions, byte sizes, views and unique visitors for all three formats', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security-admin', password: 'Security-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const loginData = await json(login);
  const cookie = cookieFrom(login);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64'
  );

  const created = await fetch(`${base}/app/image?name=stats.png&w=1&h=1&dlpOverride=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-CSRF-Token': loginData.csrf,
      Cookie: cookie,
      Origin: base,
    },
    body: png,
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  const photo = await json(created);
  assert.ok(photo.token);

  for (const kind of ['thumb', 'micro']) {
    const uploaded = await fetch(`${base}/app/image/${encodeURIComponent(photo.token)}/${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-CSRF-Token': loginData.csrf,
        Cookie: cookie,
        Origin: base,
      },
      body: png,
    });
    assert.equal(uploaded.status, 200, `${kind}: ${JSON.stringify(await json(uploaded.clone()))}`);
  }

  for (const url of [photo.imgUrl, photo.thumbUrl, photo.microUrl]) {
    const viewed = await fetch(url, { cache: 'no-store' });
    assert.equal(viewed.status, 200, url);
    await viewed.arrayBuffer();
  }

  const listResponse = await fetch(`${base}/app/images?limit=100`, { headers: { Cookie: cookie } });
  assert.equal(listResponse.status, 200, JSON.stringify(await json(listResponse.clone())));
  const list = await json(listResponse);
  const item = list.images.find((entry) => entry.token === photo.token);
  assert.ok(item, 'created image should be restored in the PWA image list');
  for (const kind of ['full', 'thumb', 'micro']) {
    assert.equal(item.variants[kind].w, 1, kind);
    assert.equal(item.variants[kind].h, 1, kind);
    assert.equal(item.variants[kind].bytes, png.length, kind + ' bytes');
    assert.equal(item.variants[kind].views, 1, kind);
    assert.equal(item.variants[kind].visitors, 1, kind);
  }
  assert.equal(item.totals.views, 3);
  assert.equal(item.totals.visitors, 1);

  const statsResponse = await fetch(`${base}/app/image/${encodeURIComponent(photo.token)}/stats`, { headers: { Cookie: cookie } });
  assert.equal(statsResponse.status, 200);
  const stats = await json(statsResponse);
  assert.equal(stats.variants.full.bytes, png.length);
  assert.equal(stats.variants.thumb.bytes, png.length);
  assert.equal(stats.variants.micro.bytes, png.length);
  assert.equal(stats.variants.full.views, 1);
  assert.equal(stats.variants.thumb.views, 1);
  assert.equal(stats.variants.micro.views, 1);
});

test('PWA image management enforces duplicate, metadata, password, view-limit and album settings', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security-admin', password: 'Security-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const loginData = await json(login);
  const cookie = cookieFrom(login);
  const headers = {
    'X-CSRF-Token': loginData.csrf,
    Cookie: cookie,
    Origin: base,
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64'
  );
  const hash = 'a'.repeat(64);

  const created = await fetch(`${base}/app/image?name=managed.png&w=1&h=1&clientHash=${hash}&dlpOverride=1&duplicateOverride=1`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  const photo = await json(created);

  const duplicate = await fetch(`${base}/app/image/duplicate?hash=${hash}`, { headers: { Cookie: cookie } });
  assert.equal(duplicate.status, 200);
  const duplicateData = await json(duplicate);
  assert.equal(duplicateData.duplicate, true);
  assert.equal(duplicateData.image.token, photo.token);

  const settings = await fetch(`${base}/app/image/${encodeURIComponent(photo.token)}/settings`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'managed-renamed.png', tags: ['forum', 'private'], note: 'private note',
      favorite: true, maxViews: 2, expiresInSeconds: 3600, password: 'Photo-pass-2026!',
    }),
  });
  assert.equal(settings.status, 200, JSON.stringify(await json(settings.clone())));
  const managed = (await json(settings)).image;
  assert.equal(managed.name, 'managed-renamed.png');
  assert.deepEqual(managed.tags, ['forum', 'private']);
  assert.equal(managed.note, 'private note');
  assert.equal(managed.favorite, true);
  assert.equal(managed.maxViews, 2);
  assert.equal(managed.hasPassword, true);
  assert.ok(managed.expiresAt > Date.now());

  const locked = await fetch(photo.imgUrl, { redirect: 'manual' });
  assert.equal(locked.status, 401);
  assert.match(locked.headers.get('cache-control') || '', /no-store/);
  assert.match(await locked.text(), /type="password"/);

  const unlock = await fetch(`${base}/i/${encodeURIComponent(photo.token)}/unlock`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'Photo-pass-2026!' }),
  });
  assert.equal(unlock.status, 302);
  const unlockCookie = cookieFrom(unlock);

  for (let i = 0; i < 2; i += 1) {
    const viewed = await fetch(photo.imgUrl, { headers: { Cookie: unlockCookie }, cache: 'no-store' });
    assert.equal(viewed.status, 200, `view ${i + 1}`);
    assert.match(viewed.headers.get('cache-control') || '', /no-store/);
    await viewed.arrayBuffer();
  }
  const limited = await fetch(photo.imgUrl, { headers: { Cookie: unlockCookie }, cache: 'no-store' });
  assert.equal(limited.status, 404);

  const albumImageResponse = await fetch(`${base}/app/image?name=album.png&w=1&h=1&dlpOverride=1&duplicateOverride=1`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(albumImageResponse.status, 201);
  const albumImage = await json(albumImageResponse);

  const albumResponse = await fetch(`${base}/app/albums`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens: [albumImage.token], name: 'Protected album', password: 'Album-pass-2026!', tags: ['album'], note: 'private album note' }),
  });
  assert.equal(albumResponse.status, 201, JSON.stringify(await json(albumResponse.clone())));
  const album = (await json(albumResponse)).album;
  assert.equal(album.count, 1);
  assert.equal(album.hasPassword, true);

  const albumLocked = await fetch(album.url, { redirect: 'manual' });
  assert.equal(albumLocked.status, 401);
  const albumUnlock = await fetch(`${base}/g/${encodeURIComponent(album.token)}/unlock`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'Album-pass-2026!' }),
  });
  assert.equal(albumUnlock.status, 302);
  const albumCookie = cookieFrom(albumUnlock);
  const albumPage = await fetch(album.url, { headers: { Cookie: albumCookie } });
  assert.equal(albumPage.status, 200);
  assert.match(albumPage.headers.get('cache-control') || '', /no-store/);
  assert.match(await albumPage.text(), /Protected album/);

  const dashboard = await fetch(`${base}/app/images/dashboard?days=7`, { headers: { Cookie: cookie } });
  assert.equal(dashboard.status, 200);
  const dashboardData = await json(dashboard);
  assert.ok(dashboardData.totals.images >= 2);
  assert.equal(dashboardData.series.length, 7);
});

test('PWA advanced image protection enforces hotlink policy, first-view alerts and retention', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'security-admin', password: 'Security-test-password-2026!' }),
  });
  assert.equal(login.status, 200, JSON.stringify(await json(login.clone())));
  const auth = await json(login);
  const cookie = cookieFrom(login);
  const mutationHeaders = {
    'X-CSRF-Token': auth.csrf,
    Cookie: cookie,
    Origin: base,
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64'
  );

  const created = await fetch(`${base}/app/image?name=protected-hotlink.png&w=1&h=1&dlpOverride=1&duplicateOverride=1`, {
    method: 'POST',
    headers: { ...mutationHeaders, 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())));
  let photo = await json(created);

  const settings = await fetch(`${base}/app/image/${encodeURIComponent(photo.token)}/settings`, {
    method: 'POST',
    headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hotlinkHosts: ['allowed.example'], notifyFirstView: true }),
  });
  assert.equal(settings.status, 200, JSON.stringify(await json(settings.clone())));
  photo = (await json(settings)).image;
  assert.deepEqual(photo.hotlinkHosts, ['allowed.example']);
  assert.equal(photo.notifyFirstView, true);
  assert.equal(photo.firstViewNotifiedAt, null);

  const blocked = await fetch(photo.imgUrl, {
    redirect: 'manual',
    headers: { Referer: 'https://evil.example/topic/1' },
    cache: 'no-store',
  });
  assert.equal(blocked.status, 403);

  const afterBlocked = await fetch(`${base}/app/image/${encodeURIComponent(photo.token)}/stats`, { headers: { Cookie: cookie } });
  assert.equal(afterBlocked.status, 200);
  assert.equal((await json(afterBlocked)).firstViewNotifiedAt, null, 'blocked hotlinks must not trigger the first-view alert');

  const allowed = await fetch(photo.imgUrl, {
    headers: { Referer: 'https://sub.allowed.example/post/42' },
    cache: 'no-store',
  });
  assert.equal(allowed.status, 200);
  await allowed.arrayBuffer();

  let notified = null;
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${base}/app/image/${encodeURIComponent(photo.token)}/stats`, { headers: { Cookie: cookie }, cache: 'no-store' });
    assert.equal(response.status, 200);
    notified = await json(response);
    if (notified.firstViewNotifiedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(notified.firstViewNotifiedAt, 'first successful public image view should be stamped');
  assert.equal(notified.variants.full.views, 1);

  const retention = await fetch(`${base}/app/images/retention`, {
    method: 'POST',
    headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, maxViews: 1, maxAgeDays: 0, inactiveDays: 0, maxStorageMB: 0, runNow: true }),
  });
  assert.equal(retention.status, 200, JSON.stringify(await json(retention.clone())));
  const retentionData = await json(retention);
  assert.equal(retentionData.rules.enabled, true);
  assert.equal(retentionData.rules.maxViews, 1);
  assert.ok(retentionData.result.revoked >= 1);
  assert.ok(retentionData.result.reasons.views >= 1);

  const gone = await fetch(photo.imgUrl, { redirect: 'manual', cache: 'no-store' });
  assert.equal(gone.status, 404);

  // Leave the destructive policy disabled for subsequent manual runs of this suite.
  const disabled = await fetch(`${base}/app/images/retention`, {
    method: 'POST',
    headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, maxViews: 0, maxAgeDays: 0, inactiveDays: 0, maxStorageMB: 0 }),
  });
  assert.equal(disabled.status, 200);
});

test('global upload dedupe requires byte-range possession proof before cross-share copy', async () => {
  const crypto = require('node:crypto');
  const admin = adminAuth;
  assert.ok(admin);
  const createInbox = async (name) => {
    const r = await fetch(`${base}/app/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': admin.csrf, Cookie: admin.cookie, Origin: base },
      body: JSON.stringify({ name }),
    });
    assert.equal(r.status, 201, JSON.stringify(await json(r.clone())));
    return json(r);
  };
  const sourceShare = await createInbox('Dedupe source');
  const targetShare = await createInbox('Dedupe target');
  const content = Buffer.from('Direct-Xfer proof-of-possession integration payload '.repeat(180));
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const uploadId = 'dedupesource2026';
  const upload = await fetch(`${base}/u/${encodeURIComponent(sourceShare.token)}/upload?path=source.bin&id=${uploadId}&size=${content.length}&offset=0&sha256=${sha}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
  });
  assert.equal(upload.status, 200, JSON.stringify(await json(upload.clone())));
  assert.equal((await json(upload)).complete, true);

  const postProbe = (body) => fetch(`${base}/u/${encodeURIComponent(targetShare.token)}/dedupe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const baseBody = { path: 'target.bin', size: content.length, sha256: sha, id: 'dedupetarget2026' };
  const probe = await postProbe(baseBody);
  assert.equal(probe.status, 200, JSON.stringify(await json(probe.clone())));
  const challenge = await json(probe);
  assert.equal(challenge.deduped, false);
  assert.match(challenge.challenge || '', /^[a-f0-9]{48}$/);
  assert.ok(Array.isArray(challenge.ranges) && challenge.ranges.length >= 1);

  // Knowing only the digest is insufficient: a fake proof is rejected and the
  // challenge is one-use, preventing replay or a known-hash cross-share oracle.
  const fake = await postProbe({ ...baseBody, challenge: challenge.challenge, proof: challenge.ranges.map((r) => Buffer.alloc(r.length).toString('base64')) });
  assert.equal(fake.status, 403);
  assert.equal((await json(fake)).error, 'dedupe-proof-failed');

  const probe2 = await postProbe(baseBody);
  assert.equal(probe2.status, 200);
  const challenge2 = await json(probe2);
  const proof = challenge2.ranges.map((r) => content.subarray(r.offset, r.offset + r.length).toString('base64'));
  const hit = await postProbe({ ...baseBody, challenge: challenge2.challenge, proof });
  assert.equal(hit.status, 200, JSON.stringify(await json(hit.clone())));
  const hitData = await json(hit);
  assert.equal(hitData.deduped, true);
  assert.equal(hitData.complete, true);

  function findNamed(dir, name) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { const got = findNamed(abs, name); if (got) return got; }
      else if (ent.isFile() && ent.name === name) return abs;
    }
    return null;
  }
  const target = findNamed(path.join(tempRoot, 'inbox'), 'target.bin');
  assert.ok(target, 'deduped file should be materialized inside the writable inbox');
  assert.deepEqual(fs.readFileSync(target), content);
});

test('global upload dedupe still enforces per-sender caps and duplicate rejection', async () => {
  const crypto = require('node:crypto');
  const admin = adminAuth;
  assert.ok(admin);
  const makeInbox = async (name, extra) => {
    const r = await fetch(`${base}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': admin.csrf, Cookie: admin.cookie, Origin: base },
      body: JSON.stringify({ name, ...(extra || {}) }),
    });
    assert.equal(r.status, 201, JSON.stringify(await json(r.clone())));
    return (await json(r)).share;
  };
  const seedUpload = (token, name, content, sender) => {
    const q = `name=${encodeURIComponent(name)}` + (sender ? `&sender=${encodeURIComponent(sender)}` : '');
    return fetch(`${base}/u/${encodeURIComponent(token)}/upload?${q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
    });
  };
  // Runs the full two-leg dedupe (probe → possession proof) and returns the final
  // response, or the probe response when the server rejects/misses before a challenge.
  const dedupe = async (token, relPath, content, sender) => {
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const body = { path: relPath, size: content.length, sha256: sha, id: 'dd' + crypto.randomBytes(6).toString('hex') };
    const url = `${base}/u/${encodeURIComponent(token)}/dedupe` + (sender ? `?sender=${encodeURIComponent(sender)}` : '');
    const post = (b) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const probe = await post(body);
    const first = await json(probe.clone());
    if (probe.status !== 200 || first.deduped || !first.challenge) return probe;
    const proof = first.ranges.map((rg) => content.subarray(rg.offset, rg.offset + rg.length).toString('base64'));
    return post({ ...body, challenge: first.challenge, proof });
  };
  const payload = (tag) => Buffer.from(`dedupe-gate ${tag} `.repeat(200)); // > 192 B → real 3-range challenge

  // A source link (no caps) seeds identical bytes so the target link finds a match.
  const source = await makeInbox('Gate seed source');
  const payloadA = payload('alpha'), payloadB = payload('bravo');
  assert.equal((await seedUpload(source.token, 'a.bin', payloadA)).status, 200);
  assert.equal((await seedUpload(source.token, 'b.bin', payloadB)).status, 200);

  // Per-sender cap: Mallory's first dedupe fills her single-file quota; the second
  // must be refused with the same sender-file-limit the streaming path returns.
  const capped = await makeInbox('Gate per-sender', { maxFilesPerSender: 1 });
  const firstHit = await dedupe(capped.token, 'a.bin', payloadA, 'Mallory');
  assert.equal(firstHit.status, 200, JSON.stringify(await json(firstHit.clone())));
  assert.equal((await json(firstHit)).deduped, true);
  const secondHit = await dedupe(capped.token, 'b.bin', payloadB, 'Mallory');
  assert.equal(secondHit.status, 409, JSON.stringify(await json(secondHit.clone())));
  assert.equal((await json(secondHit)).error, 'sender-file-limit');

  // rejectDuplicates must also cover the dedupe path: bytes already received on the
  // link cannot be smuggled back in as a "free" server-side copy.
  const dedup = await makeInbox('Gate no-dupes', { rejectDuplicates: true });
  const payloadC = payload('charlie');
  assert.equal((await seedUpload(dedup.token, 'c.bin', payloadC)).status, 200);
  const dupAttempt = await dedupe(dedup.token, 'c-again.bin', payloadC);
  assert.equal(dupAttempt.status, 409, JSON.stringify(await json(dupAttempt.clone())));
  assert.equal((await json(dupAttempt)).error, 'duplicate');

  // The refused dedupe left nothing behind: payloadC exists exactly once on disk.
  function countMatching(dir, buf) {
    let n = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) n += countMatching(abs, buf);
      else if (ent.isFile() && fs.statSync(abs).size === buf.length && fs.readFileSync(abs).equals(buf)) n += 1;
    }
    return n;
  }
  assert.equal(countMatching(path.join(tempRoot, 'inbox'), payloadC), 1, 'duplicate dedupe must not leave a second copy');
});
