'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('high-download-volume warning starts at 100 GB in the existing 15-minute window', () => {
  const server = read('server.js');
  assert.match(server, /CENTER_HIGH_DOWNLOAD_VOLUME_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/);
  const fn = server.slice(server.indexOf('function noteCenterHighVolume'), server.indexOf('function noteCenterViral'));
  assert.match(fn, /total\s*>=\s*CENTER_HIGH_DOWNLOAD_VOLUME_BYTES/);
  assert.doesNotMatch(fn, /50\s*\*\s*1024\s*\*\s*1024/);
  assert.doesNotMatch(fn, /Number\(s\.size\).*\*\s*5/);
  assert.match(fn, /15\s*min/);
});

test('installed PWA uses CloseWatcher for intentional double-back exit without history stacking', () => {
  const app = read('pwa', 'app.js');
  assert.match(app, /PWA_BACK_EXIT_WINDOW_MS\s*=\s*2000/);
  assert.match(app, /new window\.CloseWatcher\(\)/);
  assert.match(app, /window\.close\(\)/);
  assert.doesNotMatch(app, /history\.pushState\(\{\s*dxBack/);
  assert.match(app, /function hasActiveTransferRisk\(\)[\s\S]{0,500}beforeunload/);
});

test('PWA cache identifiers are advanced for the navigation fix', () => {
  assert.match(read('pwa','app.js'), /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa','sw.js'), /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa','index.html'), /app\.js\?v=297/);
  assert.match(read('pwa','sw.js'), /app\.js\?v=297/);
  assert.match(read('pwa','login.html'), /login\.js\?v=275/);
  assert.match(read('pwa','login.js'), /direct-xfer-pwa-sw\.js\?v=275/);
});
