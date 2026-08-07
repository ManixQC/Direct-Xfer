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

async function waitForServer(url) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited (${child.exitCode})\n${logs}`);
    try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}

async function body(res) { return res.json().catch(() => ({})); }

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-android-'));
  for (const name of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, name), { recursive: true });
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      ADMIN_USERNAME: 'android-admin', ADMIN_PASSWORD: 'Android-test-password-2026!',
      DATA_DIR: path.join(tempRoot, 'data'), HOST_ROOT: path.join(tempRoot, 'host'),
      INBOX_DIR: path.join(tempRoot, 'inbox'), IMAGES_DIR: path.join(tempRoot, 'images'),
      UPDATE_CHECK: 'false', PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('Android companion login issues a revocable PWA-scoped bearer capability', async () => {
  const login = await fetch(`${base}/app/companion/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'android-admin',
      password: 'Android-test-password-2026!',
      deviceName: 'Pixel test companion',
    }),
  });
  assert.equal(login.status, 200, JSON.stringify(await body(login.clone())));
  const data = await body(login);
  assert.match(data.deviceToken, /^dxpwa_[a-f0-9]{24}\.[A-Za-z0-9_-]{32,128}$/);
  assert.match(data.csrf, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(data.device.name, 'Pixel test companion');
  // The temporary browser session created while verifying credentials is cleared.
  assert.match(login.headers.get('set-cookie') || '', /^sid=;/);

  const auth = { Authorization: `Bearer ${data.deviceToken}` };
  const status = await fetch(`${base}/app/device/status`, { headers: auth });
  assert.equal(status.status, 200);
  const statusData = await body(status);
  assert.equal(statusData.paired, true);
  assert.equal(statusData.device.name, 'Pixel test companion');
  assert.equal(statusData.csrf, data.csrf);

  // Native bearer mutations intentionally have no browser Origin header, but still
  // require the per-device CSRF secret.
  const noCsrf = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Native inbox' }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await body(noCsrf)).error, 'invalid-csrf');

  const created = await fetch(`${base}/app/inbox`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrf },
    body: JSON.stringify({ name: 'Native inbox' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await body(created.clone())));
  assert.ok((await body(created)).token);

  // The native bearer capability can also execute the image-link upload flow
  // without a browser cookie or Origin header.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64'
  );
  const nativeUploadId = 'androidcompanionupload000000000001';
  const imageCreate = await fetch(`${base}/app/image?name=native.png&w=1&h=1&uploadId=${nativeUploadId}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/png', 'X-CSRF-Token': data.csrf },
    body: png,
  });
  assert.equal(imageCreate.status, 201, JSON.stringify(await body(imageCreate.clone())));
  const image = await body(imageCreate);

  const recoveredImage = await fetch(`${base}/app/image/upload/${nativeUploadId}`, { headers: auth });
  assert.equal(recoveredImage.status, 200, JSON.stringify(await body(recoveredImage.clone())));
  assert.equal((await body(recoveredImage)).token, image.token);

  // Replaying the same native upload id must return the original share rather
  // than creating a duplicate after a process death between server commit and
  // local checkpoint persistence.
  const duplicateCreate = await fetch(`${base}/app/image?name=native.png&w=1&h=1&uploadId=${nativeUploadId}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/png', 'X-CSRF-Token': data.csrf },
    body: png,
  });
  assert.equal(duplicateCreate.status, 200, JSON.stringify(await body(duplicateCreate.clone())));
  assert.equal((await body(duplicateCreate)).token, image.token);

  for (const variant of ['thumb', 'micro']) {
    const variantUpload = await fetch(`${base}/app/image/${encodeURIComponent(image.token)}/${variant}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'image/jpeg', 'X-CSRF-Token': data.csrf },
      body: png,
    });
    assert.equal(variantUpload.status, 200, `${variant}: ${JSON.stringify(await body(variantUpload.clone()))}`);
  }

  const revoke = await fetch(`${base}/app/device/revoke`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrf },
    body: JSON.stringify({ revokeShares: true }),
  });
  assert.equal(revoke.status, 200, JSON.stringify(await body(revoke.clone())));

  const afterRevoke = await fetch(`${base}/app/device/status`, { headers: auth });
  assert.equal(afterRevoke.status, 401);
});

test('companion source declares native Android share, persistent uploads and biometric lock', () => {
  const root = path.resolve(__dirname, '..', 'android-companion');
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/work/UploadWorker.kt'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/ui/MainActivity.kt'), 'utf8');
  const secure = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/security/SecureStore.kt'), 'utf8');
  const scheduler = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/work/TransferScheduler.kt'), 'utf8');
  const recoveryWorker = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/work/RecoveryWorker.kt'), 'utf8');
  const recoveryReceiver = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/work/RecoveryReceiver.kt'), 'utf8');
  const database = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/data/CompanionDatabase.kt'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/net/DirectXferApi.kt'), 'utf8');
  const cancelReceiver = fs.readFileSync(path.join(root, 'app/src/main/java/ca/manix123/directxfer/work/CancelTransferReceiver.kt'), 'utf8');
  const wrapper = fs.readFileSync(path.join(root, 'gradle/wrapper/gradle-wrapper.properties'), 'utf8');
  assert.match(manifest, /android\.intent\.action\.SEND_MULTIPLE/);
  assert.match(manifest, /FOREGROUND_SERVICE_DATA_SYNC/);
  assert.match(manifest, /RECEIVE_BOOT_COMPLETED/);
  assert.match(manifest, /RecoveryReceiver/);
  assert.match(manifest, /CancelTransferReceiver/);
  assert.match(worker, /CoroutineWorker/);
  assert.match(worker, /setForeground/);
  assert.match(worker, /onStopped/);
  assert.match(worker, /findImageByUploadId/);
  assert.match(worker, /checkpointImage/);
  assert.match(worker, /MAX_WORK_RETRIES = 10/);
  assert.match(worker, /ic_notification/);
  assert.match(scheduler, /enqueueUniqueWork/);
  assert.match(scheduler, /enqueueUniquePeriodicWork/);
  assert.match(scheduler, /ExistingWorkPolicy\.KEEP/);
  assert.match(scheduler, /BackoffPolicy\.EXPONENTIAL/);
  assert.match(recoveryWorker, /listRecoverableTransfers/);
  assert.match(recoveryWorker, /STALE_AFTER_MS/);
  assert.match(recoveryReceiver, /ACTION_BOOT_COMPLETED/);
  assert.match(recoveryReceiver, /ACTION_MY_PACKAGE_REPLACED/);
  assert.match(database, /remote_token TEXT/);
  assert.match(database, /upload_stage TEXT/);
  assert.match(database, /last_heartbeat INTEGER/);
  assert.match(api, /\/app\/image\/upload\//);
  assert.match(cancelReceiver, /TransferState\.CANCELLED/);
  assert.match(activity, /BiometricPrompt/);
  assert.match(secure, /AndroidKeyStore/);
  assert.match(wrapper, /distributionSha256Sum=20f1b117/);
});


test('the Android companion ships a well-formed version and durable recovery metadata', () => {
  const project = path.resolve(__dirname, '..');
  const gradle = fs.readFileSync(path.join(project, 'android-companion/app/build.gradle.kts'), 'utf8');
  const models = fs.readFileSync(path.join(project, 'android-companion/app/src/main/java/ca/manix123/directxfer/data/Models.kt'), 'utf8');
  // Assert the version identifiers are present and well-formed rather than frozen values.
  assert.match(gradle, /versionCode = \d+/);
  assert.match(gradle, /versionName = "\d+\.\d+\.\d+"/);
  assert.match(models, /enum class UploadStage \{ FULL, THUMB, MICRO, COMPLETE \}/);
  assert.match(models, /remoteToken: String\?/);
  assert.match(models, /lastHeartbeat: Long/);
});
