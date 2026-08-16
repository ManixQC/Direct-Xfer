'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('1.62.2 groups secondary share creation actions under one plus menu', () => {
  const html = read('public','index.html');
  assert.match(html, /id="share-create-menu-btn"[^>]*>\+<\/button>/);
  for (const id of ['new-collab-btn','new-inbox-btn','new-secret-btn','new-enc-btn']) {
    assert.match(html, new RegExp(`share-create-menu-panel[\\s\\S]*id="${id}"`));
  }
  assert.match(read('public','app.js'), /initShareActionMenus\(\)/);
});

test('1.62.2 groups search trash and link exports under Config', () => {
  const html = read('public','index.html');
  assert.match(html, /id="share-config-menu-btn"[^>]*data-i18n-aria="sh.actionConfig"[^>]*data-i18n-title="sh.actionConfig"[^>]*><span aria-hidden="true">⚙<\/span><\/button>/);
  assert.doesNotMatch(html, /id="share-config-menu-btn"[^>]*>[\s\S]{0,160}>Config<\/span>/);
  for (const id of ['search-toggle-btn','trash-btn','links-export-csv','links-export-json']) {
    assert.match(html, new RegExp(`share-config-menu-panel[\\s\\S]*id="${id}"`));
  }
});

test('share action menus are accessible and do not reintroduce horizontal scrolling', () => {
  const html = read('public','index.html');
  const css = read('public','style.css');
  const app = read('public','app.js');
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(css, /\.share-action-menu-panel\s*\{/);
  assert.match(css, /\.shares-head \.head-actions\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(app, /event\.key !== 'Escape'/);
  assert.match(app, /event\.target\.closest\(menuItemSelector\)/);
});

test('New share stays directly visible and 35 percent larger', () => {
  const html = read('public','index.html');
  const css = read('public','style.css');
  assert.match(html, /<div class="head-actions">\s*<button id="new-share-btn"/);
  assert.match(css, /#new-share-btn\.btn\.sm\s*\{[\s\S]*font-size:\s*1\.08rem/);
});

test('1.62.2 release identifiers and caches are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.62.2');
  assert.equal(lock.version, '1.62.2');
  assert.equal(lock.packages[''].version, '1.62.2');
  assert.match(read('pwa','app.js'), /APP_VERSION = '1\.62\.2'/);
  assert.match(read('pwa','app.js'), /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa','sw.js'), /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(read('public','index.html'), /style\.css\?v=286/);
  assert.match(read('public','index.html'), /app\.js\?v=292/);
  assert.match(read('pwa','index.html'), /app\.js\?v=290/);
});
