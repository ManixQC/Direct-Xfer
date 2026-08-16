'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const html = read('public', 'index.html');
const app = read('public', 'app.js');
const css = read('public', 'style.css');

test('grouped share menus keep each original action exactly once', () => {
  for (const id of ['new-collab-btn','new-inbox-btn','new-secret-btn','new-enc-btn','search-toggle-btn','trash-btn','links-export-csv','links-export-json']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must exist exactly once`);
  }
  assert.match(html, /id="share-create-menu-panel"[\s\S]*id="new-collab-btn"[\s\S]*id="new-enc-btn"/);
  assert.match(html, /id="share-config-menu-panel"[\s\S]*id="search-toggle-btn"[\s\S]*id="links-export-json"/);
});

test('keyboard menu navigation uses roving focus without the focusout microtask race', () => {
  assert.match(app, /event\.key === 'ArrowDown'/);
  assert.match(app, /event\.key === 'ArrowUp'/);
  assert.match(app, /event\.key === 'Home'/);
  assert.match(app, /event\.key === 'End'/);
  assert.match(app, /setActiveItem\(panel, next, true\)/);
  assert.match(app, /menu\.addEventListener\('focusout'[\s\S]*setTimeout\(\(\) =>/);
  const menuFn = app.slice(app.indexOf('function initShareActionMenus()'), app.indexOf('initShareActionMenus();') + 'initShareActionMenus();'.length);
  assert.doesNotMatch(menuFn, /queueMicrotask/);
});

test('closed menus never retain focus after an action and Escape returns focus to the trigger', () => {
  assert.match(app, /closeMenu\(menu, \{ returnFocus: true \}\)/);
  assert.match(app, /active === action \|\| menu\.contains\(active\) \|\| active === document\.body/);
  assert.match(app, /trigger\.focus\(\{ preventScroll: true \}\)/);
});

test('menus stay inside short viewports and can open upward with internal scrolling', () => {
  assert.match(css, /max-height:\s*min\(360px, calc\(100dvh - 24px\), var\(--share-action-menu-max-height, 360px\)\)/);
  assert.match(css, /overflow-y:\s*auto/);
  assert.match(css, /\.share-action-menu-panel\.open-upward\s*\{[\s\S]*bottom:\s*calc\(100% \+ 8px\)/);
  assert.match(app, /roomAbove/);
  assert.match(app, /roomBelow/);
  assert.match(app, /--share-action-menu-max-height/);
});

test('share list exports opened from Config cannot control the admin window', () => {
  assert.match(app, /list-export\?format=csv', '_blank', 'noopener'/);
  assert.match(app, /list-export\?format=json', '_blank', 'noopener'/);
});

test('role changes close grouped menus before role-gated actions are hidden', () => {
  assert.match(app, /window\.dxCloseShareActionMenus = \(\) => closeAll\(null\)/);
  assert.match(app, /previousRole && previousRole !== role[\s\S]*window\.dxCloseShareActionMenus\(\)/);
});

test('standard assets are cache-busted for the audit fixes', () => {
  assert.match(html, /style\.css\?v=286/);
  assert.match(html, /app\.js\?v=297/);
});
