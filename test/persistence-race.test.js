'use strict';

// Regression: an older async persist must never overwrite a newer persistNow().
// The preload deliberately delays the first async shares.json temp write so the
// following synchronous edit can complete first. The durable store must retain
// the newer edit after the delayed writer wakes up.

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
let dataDir;
let logs = '';

const ADMIN_USER = 'persist-race-admin';
const ADMIN_PASS = 'Persist-race-test-2026!';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
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

async function readJson(response) {
  return response.json().catch(() => ({}));
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-persist-race-'));
  dataDir = path.join(tempRoot, 'data');
  for (const name of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, name), { recursive: true });

  const preload = path.join(tempRoot, 'delay-store-write.cjs');
  fs.writeFileSync(preload, `
'use strict';
const fs = require('node:fs');
const original = fs.writeFile;
let delayed = false;
fs.writeFile = function patchedWriteFile(file, ...args) {
  const name = String(file || '');
  if (!delayed && name.includes('shares.json.tmp')) {
    delayed = true;
    const self = this;
    setTimeout(() => original.call(self, file, ...args), 450);
    return;
  }
  return original.call(this, file, ...args);
};
`);

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      PORT: String(port),
      BIND: '127.0.0.1',
      ADMIN_USERNAME: ADMIN_USER,
      ADMIN_PASSWORD: ADMIN_PASS,
      DATA_DIR: dataDir,
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

test('persistNow wins over an older async persist already in flight', async () => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(login.status, 200, JSON.stringify(await readJson(login.clone())));
  const loginData = await readJson(login);
  const cookie = cookieFrom(login);
  assert.ok(loginData.csrf);

  const headers = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': loginData.csrf,
    Cookie: cookie,
    Origin: base,
  };

  // addShare() starts the delayed async persist with the original name.
  const created = await fetch(`${base}/api/inbox`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Before durable edit' }),
  });
  assert.equal(created.status, 201, JSON.stringify(await readJson(created.clone())));
  const share = (await readJson(created)).share;
  assert.ok(share && share.id);

  // The edit uses persistNow(). It must supersede the delayed older snapshot.
  const edited = await fetch(`${base}/api/shares/${encodeURIComponent(share.id)}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ name: 'After durable edit' }),
  });
  assert.equal(edited.status, 200, JSON.stringify(await readJson(edited.clone())));

  await new Promise((resolve) => setTimeout(resolve, 750));
  const raw = fs.readFileSync(path.join(dataDir, 'shares.json'), 'utf8');
  const stored = JSON.parse(raw);
  const saved = (stored.shares || []).find((s) => s.id === share.id);
  assert.ok(saved, 'created share must remain persisted');
  assert.equal(saved.name, 'After durable edit', 'older async snapshot must not overwrite persistNow state');
});


test('async persistence commits synchronously after its generation guard', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function persist()');
  const end = source.indexOf('function persistNow()', start);
  assert.ok(start >= 0 && end > start);
  const persistSource = source.slice(start, end);
  assert.match(persistSource, /generation !== persistGeneration/);
  assert.match(persistSource, /fs\.renameSync\(tempFile, STORE_FILE\)/);
  assert.doesNotMatch(persistSource, /fs\.rename\(tempFile, STORE_FILE/);
});
