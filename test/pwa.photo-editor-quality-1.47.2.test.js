'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('photo editor defaults to 99 percent quality in every export path', () => {
  assert.match(html, /id="ann-output-quality"[^>]*value="99"/);
  assert.match(app, /\$\('ann-output-quality'\)\.value = '99'/);
  assert.match(app, /Number\(\$\('ann-output-quality'\)[\s\S]*?\|\| 99\) \/ 100/);
  assert.doesNotMatch(html, /id="ann-output-quality"[^>]*value="92"/);
});

test('1.51.2 PWA build and resource identifiers stay synchronized', () => {
  assert.equal(pkg.version, '1.59.1');
  assert.match(app, /APP_VERSION = '1\.59\.1'/);
  assert.match(app, /APP_BUILD = '2026\.08\.14-pwa280'/);
  assert.match(sw, /VERSION = '2026\.08\.14-pwa280'/);
  assert.match(html, /v1\.59\.1 · pwa280/);
  assert.match(html, /\/app\/app\.js\?v=266/);
  assert.match(sw, /\/app\/app\.js\?v=266/);
});
