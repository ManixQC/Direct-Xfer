'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('1.51.2 notification settings use a bounded tablet grid', () => {
  const css = read('pwa/app.css');
  const html = read('pwa/index.html');
  assert.match(css, /\.notification-center-settings-row\{display:grid;grid-template-columns:minmax\(0,\.72fr\) minmax\(0,1\.28fr\);[^}]*min-width:0;width:100%;max-width:100%;\}/);
  assert.match(css, /\.notification-rule-builder\{grid-column:1 \/ -1;min-width:0;width:100%;max-width:100%;box-sizing:border-box;/);
  assert.match(css, /\.notification-settings-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*min-width:0;width:100%;max-width:100%;\}/);
  assert.match(css, /@media \(max-width:620px\)\{\.notification-center-settings-row\{grid-template-columns:minmax\(0,1fr\);/);
  assert.match(css, /\.notification-rule-fields \.field,\.notification-rule-fields input,\.notification-rule-fields select\{min-width:0;width:100%;max-width:100%;box-sizing:border-box;\}/);
  assert.match(html, /id="settings-notification-prefs" class="notification-settings-grid"/);
});


test('1.51.2 system notification descriptions span the full tablet preference card', () => {
  const css = read('pwa/app.css');
  assert.match(css, /\.notification-settings-grid \.notification-pref-row\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto;grid-template-rows:auto auto;/);
  assert.match(css, /\.notification-settings-grid \.notification-pref-copy\{display:contents;\}/);
  assert.match(css, /\.notification-settings-grid \.notification-pref-description\{grid-column:1 \/ -1;grid-row:2;display:block;min-width:0;width:100%;max-width:100%;/);
  assert.match(css, /\.notification-settings-grid \.notification-pref-required-label\{grid-column:3;grid-row:1;/);
});

test('1.51.2 release and PWA shell identifiers are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.60.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.60\.0'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa/index.html'), /app\.css\?v=272/);
  assert.match(read('pwa/index.html'), /v1\.60\.0 · pwa289/);
});
