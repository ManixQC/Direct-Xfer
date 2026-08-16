'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-pwa-install-detect-'));
let child;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
async function waitReady(base, logs) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error('server exited early\n' + logs());
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('server readiness timeout\n' + logs());
}

test('runtime serves the PWA relationship manifest and Digital Asset Link for the current origin', { timeout: 20000 }, async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1', UPDATE_CHECK: 'false', NO_COLOR: '1',
      DATA_DIR: path.join(tmp, 'data'), HOST_ROOT: path.join(tmp, 'host'),
      INBOX_DIR: path.join(tmp, 'inbox'), IMAGES_DIR: path.join(tmp, 'images'),
      ADMIN_PASSWORD: 'Install-detect-test-2026!', PUBLIC_URL: base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => { output += b.toString(); });
  child.stderr.on('data', (b) => { output += b.toString(); });
  try {
    await waitReady(base, () => output);
    const manifestResp = await fetch(base + '/admin-pwa-detect.webmanifest');
    assert.equal(manifestResp.status, 200);
    assert.match(manifestResp.headers.get('content-type') || '', /application\/manifest\+json/);
    const manifest = await manifestResp.json();
    assert.deepEqual(manifest.related_applications, [
      { platform:'webapp', url: base + '/direct-xfer-pwa.webmanifest' },
      { platform:'webapp', url: base + '/direct-xfer-pwa-en.webmanifest' },
      { platform:'webapp', url: base + '/direct-xfer-pwa-es.webmanifest' },
    ]);

    const linksResp = await fetch(base + '/.well-known/assetlinks.json');
    assert.equal(linksResp.status, 200);
    const links = await linksResp.json();
    assert.equal(links[0].relation[0], 'delegate_permission/common.query_webapk');
    assert.equal(links[0].target.namespace, 'web');
    assert.equal(links[0].target.site, base + '/admin-pwa-detect.webmanifest');

    const rootResp = await fetch(base + '/');
    assert.equal(rootResp.status, 200);
    assert.match(await rootResp.text(), /rel="manifest" href="\/admin-pwa-detect\.webmanifest"/);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
});
