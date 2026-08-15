'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const expected = "['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','network','restarts','updates','maintenance','security','system_health']";

test('Maintenance is immediately above Security in standard notification settings', () => {
  const app = read('public/app.js');
  assert.ok(app.includes(`NOTIFICATION_SETTINGS_CATEGORIES = ${expected}`));
  assert.ok(app.includes("NOTIFICATION_REQUIRED_CATEGORIES = ['security','maintenance','system_health']"));
});

test('Maintenance is immediately above Security in PWA notification settings', () => {
  const app = read('pwa/app.js');
  assert.ok(app.includes(`NOTIFICATION_SETTINGS_CATEGORIES = ${expected}`));
  assert.ok(app.includes("NOTIFICATION_REQUIRED_CATEGORIES = ['security','maintenance','system_health']"));
});

test('PWA shell cache is advanced without changing app version', () => {
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.59\.8'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa287'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa287'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=270/);
});
