'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('PWA close/reopen honors the configured auto-lock delay instead of locking immediately', () => {
  const app = read('pwa/app.js');
  const block = app.match(/function closedLaunchNeedsLock\(\) \{[\s\S]*?\n  \}/);
  assert.ok(block, 'closed-launch policy should exist');
  assert.match(block[0], /var minutes = autoLockMinutes\(\)/);
  assert.match(block[0], /elapsed >= minutes \* 60000/);
  assert.doesNotMatch(block[0], /Date\.now\(\) - closedAt < 7 \* 86400000/);
});

test('PWA still records pagehide only when auto-lock is enabled', () => {
  const app = read('pwa/app.js');
  assert.match(app, /if \(!logoutInProgress && !autoLockInProgress && autoLockMinutes\(\) > 0\)[\s\S]*?dx-pwa-pagehide-at/);
});

test('PWA release cache points installed clients at the fixed JavaScript', () => {
  const app = read('pwa/app.js');
  const sw = read('pwa/sw.js');
  const html = read('pwa/index.html');
  assert.match(app, /APP_VERSION = '1\.59\.1'/);
  assert.match(app, /APP_BUILD = '2026\.08\.14-pwa280'/);
  assert.match(sw, /VERSION = '2026\.08\.14-pwa280'/);
  assert.match(sw, /\/app\/app\.js\?v=266/);
  assert.match(html, /\/app\/app\.js\?v=266/);
});
