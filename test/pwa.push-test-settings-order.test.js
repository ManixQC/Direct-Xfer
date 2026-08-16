'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

test('PWA push test is immediately before notification center settings', () => {
  const pushIdx = html.indexOf('id="push-test-btn"');
  const centerIdx = html.indexOf('id="settings-notification-prefs"');
  assert.ok(pushIdx >= 0, 'push test button must exist');
  assert.ok(centerIdx >= 0, 'notification center preferences must exist');
  assert.ok(pushIdx < centerIdx, 'push test must appear before notification center');

  const between = html.slice(pushIdx, centerIdx);
  assert.doesNotMatch(between, /<div class="setting-row">[\s\S]*?<strong data-i18n="sessionStats"/, 'no unrelated settings row should be inserted between both sections');
});

test('PWA cache/build is bumped for reordered settings', () => {
  assert.match(html, /v1\.62\.3 · pwa307/);
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa307'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa307'/);
  assert.match(html, /app\.js\?v=290/);
  assert.match(sw, /app\.js\?v=290/);
});
