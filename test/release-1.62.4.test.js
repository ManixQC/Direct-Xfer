'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('1.62.4 release identifiers are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.62.4');
  assert.equal(lock.version, '1.62.4');
  assert.equal(lock.packages[''].version, '1.62.4');
  assert.match(read('pwa','app.js'), /APP_VERSION = '1\.62\.4'/);
  assert.match(read('pwa','app.js'), /APP_BUILD = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa','sw.js'), /VERSION = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa','index.html'), /v1\.62\.4 · pwa308/);
  assert.match(read('windows-launcher','Program.cs'), /RuntimeAppBuild = "1\.62\.4-launcher45-csharp"/);
  assert.match(read('windows-launcher','Program.cs'), /ServerHostBuild = "1\.62\.4-serverhost18-csharp"/);
  assert.match(read('windows-server-host','Program.cs'), /HostVersion = "1\.62\.4-serverhost18-csharp"/);
  assert.match(read('.github','workflows','build-windows-csharp.yml'), /DX_VERSION: '1\.62\.4'/);
  assert.match(read('installer','Direct-Xfer.iss'), /#define AppVersion "1\.62\.4"/);
});
