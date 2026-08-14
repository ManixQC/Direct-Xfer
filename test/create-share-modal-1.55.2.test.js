'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('create-share modal has a dedicated scrollable body and persistent footer', () => {
  const html = read('public/index.html');
  const css = read('public/style.css');
  assert.match(html, /class="modal picker-modal"[^>]*aria-labelledby="picker-title"/);
  assert.match(html, /<div class="picker-body">[\s\S]*<div class="picker-browser"/);
  assert.match(html, /<div class="picker-browser"[\s\S]*id="browser-list"[\s\S]*id="share-options"/);
  assert.match(css, /\.picker-modal\s*\{[\s\S]*height:\s*var\(--dx-picker-modal-height[\s\S]*overflow:\s*hidden[\s\S]*display:\s*grid/);
  assert.match(css, /\.picker-body\s*\{[\s\S]*min-height:\s*0[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.picker-modal\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
});

test('file-selection browser is deliberately larger in create-share modal', () => {
  const css = read('public/style.css');
  assert.match(css, /\.picker-modal \.browser-list\s*\{[\s\S]*height:\s*var\(--dx-picker-browser-height[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /@media \(max-height: 700px\)[\s\S]*\.picker-modal \.browser-list,[\s\S]*min-height:\s*280px/);
});

test('1.55.3 release metadata is synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.0');
  assert.equal(lock.version, '1.59.0');
  assert.equal(lock.packages[''].version, '1.59.0');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.59\.0'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa279'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa279'/);
  assert.match(read('pwa/index.html'), /v1\.59\.0 · pwa279/);
});
