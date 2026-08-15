'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('1.59.8 create-share dialog has a bounded Firefox-safe scroll body', () => {
  const css = read('public/style.css');
  assert.match(css, /\.picker-modal\s*\{[\s\S]*height:\s*var\(--dx-picker-modal-height[\s\S]*overflow:\s*hidden[\s\S]*display:\s*grid/);
  assert.match(css, /\.picker-body\s*\{[\s\S]*overflow-y:\s*auto[\s\S]*scrollbar-width:\s*auto/);
  assert.match(css, /\.picker-modal\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /\.picker-modal\s*>\s*\.modal-foot\s*\{[\s\S]*position:\s*relative/);
});

test('picker uses visualViewport height so zoom and virtual keyboards cannot trap the dialog', () => {
  const js = read('public/app.js');
  assert.match(js, /function syncPickerViewport\(\)/);
  assert.match(js, /window\.visualViewport/);
  assert.match(js, /--dx-picker-modal-height/);
  assert.match(js, /--dx-picker-browser-height/);
  assert.match(js, /function showPickerOverlay\(\)/);
  assert.match(js, /body\.scrollTop = 0/);
  assert.match(js, /list\.scrollTop = 0/);
  assert.match(js, /visualViewport\.addEventListener\('resize'/);
});

test('1.59.8 release identifiers are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.8');
  assert.equal(lock.version, '1.59.8');
  assert.equal(lock.packages[''].version, '1.59.8');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.59\.8'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa287'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa287'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=270/);
  assert.match(read('windows-launcher/Program.cs'), /RuntimeAppBuild\s*= "1\.59\.8-launcher34-csharp"/);
});
