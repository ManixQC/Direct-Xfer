'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const css = read('public','style.css');
const app = read('public','app.js');

test('1.59.1 create-share modal is a three-zone bounded grid', () => {
  assert.match(css, /Create-share picker layout \(1\.58\.3\)/);
  assert.match(css, /\.picker-modal\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /\.picker-body\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto/);
});

test('1.59.1 file picker targets ten visible rows plus parent row', () => {
  assert.match(css, /--dx-picker-row-height:\s*44px/);
  assert.match(css, /--dx-picker-browser-height:\s*442px/);
  assert.match(css, /\.browser-list\.has-parent\s*\{[\s\S]*calc\(var\(--dx-picker-browser-height[^\n]*\+ var\(--dx-picker-row-height\)\)/);
  assert.match(css, /\.browser-list > \.row \.name\s*\{[\s\S]*white-space:\s*nowrap;[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(app, /const tenRowHeight = 442/);
  assert.match(app, /const browserHeight = browserFloor/);
  assert.match(app, /list\.classList\.toggle\('has-parent'/);
});

test('1.59.1 release identifiers are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.1');
  assert.equal(lock.version, '1.59.1');
  assert.equal(lock.packages[''].version, '1.59.1');
  assert.match(read('pwa','app.js'), /APP_VERSION = '1\.59\.1'/);
  assert.match(read('pwa','app.js'), /APP_BUILD = '2026\.08\.14-pwa280'/);
  assert.match(read('pwa','sw.js'), /VERSION = '2026\.08\.14-pwa280'/);
  assert.match(read('pwa','index.html'), /v1\.59\.1 · pwa280/);
  assert.match(read('windows-launcher','Program.cs'), /RuntimeAppBuild\s*=\s*"1\.59\.1-launcher27-csharp"/);
});
