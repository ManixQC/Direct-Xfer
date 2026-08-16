'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const launcher = read('windows-launcher', 'Program.cs');
const host = read('windows-server-host', 'Program.cs');
const workflow = read('.github', 'workflows', 'build-windows-csharp.yml');
const iss = read('installer', 'Direct-Xfer.iss');
function normalizedTextSha256(rel) {
  const text = read(...rel.split('/')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('1.60.3 release metadata is synchronized across Node, PWA, launcher, host and installer', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.60.3');
  assert.equal(lock.version, '1.60.3');
  assert.equal(lock.packages[''].version, '1.60.3');
  assert.match(read('pwa', 'app.js'), /APP_VERSION = '1\.60\.3'/);
  assert.match(read('pwa', 'app.js'), /APP_BUILD = '2026\.08\.15-pwa294'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.15-pwa294'/);
  assert.match(read('pwa', 'index.html'), /v1\.60\.3 · pwa294/);
  assert.match(launcher, /AppVersion = "1\.60\.3"/);
  assert.match(launcher, /RuntimeAppBuild = "1\.60\.3-launcher38-csharp"/);
  assert.match(host, /HostVersion = "1\.60\.3-serverhost11-csharp"/);
  assert.match(workflow, /DX_VERSION: '1\.60\.3'/);
  assert.match(workflow, /DX_RUNTIME_BUILD: '1\.60\.3-launcher38-csharp'/);
  assert.match(workflow, /DX_SERVER_HOST_BUILD: '1\.60\.3-serverhost11-csharp'/);
  assert.match(iss, /#define AppVersion "1\.60\.3"/);
});

test('PWA and admin notification assets are cache-busted consistently while the favicon remains v269', () => {
  assert.match(read('pwa', 'index.html'), /app\.css\?v=272/);
  assert.match(read('pwa', 'index.html'), /app\.js\?v=278/);
  assert.match(read('pwa', 'sw.js'), /app\.css\?v=272/);
  assert.match(read('pwa', 'sw.js'), /app\.js\?v=278/);
  assert.match(read('public', 'index.html'), /style\.css\?v=279/);
  assert.match(read('public', 'index.html'), /app\.js\?v=280/);
  assert.match(read('public', 'index.html'), /favicon\.png\?v=269/);
});

test('all ServerHost critical runtime hashes match actual normalized files', () => {
  for (const rel of ['package.json','package-lock.json','server.js','public/app.js','pwa/app.js','node_modules/express/package.json']) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = host.match(new RegExp('\\{ "' + escaped + '", "([0-9a-f]{64})" \\}'));
    assert.ok(match, 'missing embedded ServerHost hash for ' + rel);
    assert.equal(match[1], normalizedTextSha256(rel), 'hash mismatch for ' + rel);
  }
});

test('launcher has no hidden ServerHost process launch or process supervision primitives', () => {
  assert.doesNotMatch(launcher, /CreateNoWindow|Process\.GetProcessById|\.Kill\(\)|FileName\s*=\s*hostExe|StartOrAttachServerHost|StopServerHost/);
  assert.match(launcher, /SignalServerHostReload/);
});

test('installer owns ServerHost startup and lifecycle during install/update/uninstall', () => {
  assert.match(iss, /\{userstartup\}\\Direct-Xfer Server Host/);
  assert.match(iss, /PrepareToInstall/);
  assert.match(iss, /CurUninstallStepChanged/);
  assert.match(iss, /Local\\DirectXferServerHostStop/);
});
