'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root,p),'utf8');

test('paired-only PWA receives every paired device from the same account', () => {
  const server = read('server.js');
  assert.match(server, /const deviceAccount = device \? \(pwaDeviceCreatorAccount\(device\) \|\| pwaDeviceOwnerAccount\(device\.id\)\) : null/);
  assert.match(server, /const visibleAccount = sessionAccount \|\| deviceAccount/);
  assert.match(server, /pwaDevices\(\)\.filter\(\(d\) => \{/);
  assert.match(server, /String\(owner\.id\) === String\(visibleAccount\.id\)/);
  assert.doesNotMatch(server, /const devices = session \? pwaDevices\(\)\.map/);
});

test('PWA renders the shared device list without requiring an admin session', () => {
  const app = read('pwa/app.js');
  assert.match(app, /device-list-wrap'\)\.classList\.toggle\('hidden', !devices\.length\)/);
  assert.doesNotMatch(app, /if \(d\.current \|\| deviceInfo\.adminSession\)/);
  assert.match(app, /if \(!d\.current && deviceInfo\.adminSession\)/);
  assert.match(app, /renameDevice\(d\.id, d\.name, false\)/);
  assert.doesNotMatch(app, /renameDevice\(d\.id, d\.name, !!d\.current\)/);
  assert.match(app, /rename-device-btn/);
  assert.match(app, /renameDevice\(null, deviceInfo && deviceInfo\.device && deviceInfo\.device\.name, true\)/);
});

test('1.51.2 advances the PWA shell', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.63.4');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.63\.4'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=297/);
});
