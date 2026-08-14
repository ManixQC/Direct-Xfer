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

test('1.59.2 release metadata is synchronized across Node, PWA, launcher, host and installer', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.2');
  assert.equal(lock.version, '1.59.2');
  assert.equal(lock.packages[''].version, '1.59.2');
  assert.match(read('pwa', 'app.js'), /APP_VERSION = '1\.59\.2'/);
  assert.match(read('pwa', 'app.js'), /APP_BUILD = '2026\.08\.14-pwa281'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.14-pwa281'/);
  assert.match(read('pwa', 'index.html'), /v1\.59\.2 · pwa281/);
  assert.match(launcher, /AppVersion = "1\.59\.2"/);
  assert.match(launcher, /RuntimeAppBuild = "1\.59\.2-launcher28-csharp"/);
  assert.match(host, /AppVersion = "1\.59\.2"/);
  assert.match(host, /HostVersion = "1\.59\.2-serverhost1-csharp"/);
  assert.match(workflow, /DX_VERSION: '1\.59\.2'/);
  assert.match(workflow, /DX_RUNTIME_BUILD: '1\.59\.2-launcher28-csharp'/);
  assert.match(iss, /#define AppVersion "1\.59\.2"/);
});

test('PWA resources are advanced to pwa281/v267', () => {
  assert.match(read('pwa', 'index.html'), /v=267/);
  assert.match(read('pwa', 'app.js'), /v=267/);
  assert.match(read('pwa', 'sw.js'), /v=267/);
  assert.doesNotMatch(read('pwa', 'index.html'), /pwa280|v=266/);
});

test('all ServerHost critical runtime hashes match actual normalized files', () => {
  for (const rel of ['package.json','package-lock.json','server.js','public/app.js','pwa/app.js','node_modules/express/package.json']) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = host.match(new RegExp('\\{ "' + escaped + '", "([0-9a-f]{64})" \\}'));
    assert.ok(match, 'missing embedded ServerHost hash for ' + rel);
    assert.equal(match[1], normalizedTextSha256(rel), 'hash mismatch for ' + rel);
  }
});

test('server supervision moved out of the tray launcher', () => {
  assert.doesNotMatch(launcher, /node\.exe|server\.js|RedirectStandardOutput|RedirectStandardError|\.Kill\(\)/);
  assert.match(host, /FileName = node, Arguments = "server\.js"/);
  assert.match(host, /RedirectStandardOutput = true/);
  assert.match(host, /StopNode\(\)/);
});

test('installer protects both active Windows components during upgrade', () => {
  assert.match(iss, /AppMutex=Local\\DirectXferLauncherInstance,Local\\DirectXferServerHostInstance/);
  assert.match(iss, /\[InstallDelete\]/);
  assert.match(iss, /\{app\}\\runtime\\app/);
  assert.match(iss, /\{app\}\\runtime\\node/);
});

test('release workflow builds and packages both C# executables', () => {
  assert.match(workflow, /Build C# server host/);
  assert.match(workflow, /Build C# launcher/);
  assert.match(workflow, /Direct-Xfer\.ServerHost\.exe/);
  assert.match(workflow, /Copy-Item 'windows-server-host\\bin\\Release\\Direct-Xfer\.ServerHost\.exe'/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
});
