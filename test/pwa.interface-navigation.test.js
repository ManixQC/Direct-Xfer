'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('PWA separates the long interface into four stable workspaces', () => {
  for (const panel of ['send', 'images', 'activity', 'settings']) {
    assert.match(html, new RegExp(`data-pwa-nav="${panel}"`));
    assert.match(html, new RegExp(`data-pwa-panel="${panel}"`));
  }
  assert.match(html, /id="pwa-bottom-nav"/);
  assert.match(html, /id="pwa-panel-heading"/);
  assert.match(css, /\.pwa-panel-hidden\s*\{\s*display:\s*none !important/);
  assert.match(css, /\.pwa-bottom-nav\s*\{/);
  assert.match(js, /function activatePwaPanel\(panel, options\)/);
  assert.match(js, /function initPwaNavigation\(\)/);
});

test('mobile destination actions use an orderly grid and navigation remains outside the scroller', () => {
  assert.match(html, /class="row destination-toolbar"/);
  assert.match(css, /\.destination-toolbar\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,/);
  assert.match(css, /\.pwa-bottom-nav\s*\{[\s\S]*flex:\s*0 0 auto/);
});

test('navigation labels are translated in all supported languages', () => {
  assert.match(js, /navMain: 'Navigation principale'/);
  assert.match(js, /navMain: 'Main navigation'/);
  assert.match(js, /navMain: 'Navegación principal'/);
  assert.match(js, /navImagesHint:/);
  assert.match(js, /navActivityHint:/);
  assert.match(js, /navSettingsHint:/);
});
