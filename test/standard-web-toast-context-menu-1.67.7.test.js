'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const app = read('public/app.js');
const css = read('public/style.css');

test('1.67.7 web-link creation diagnostics stay visible for ten seconds', () => {
  assert.match(app, /const WEB_STORAGE_NOTICE_MS = 10000;/);
  assert.match(app, /function webStorageToast\(message, kind='err'\)[\s\S]*toast\(message, kind, WEB_STORAGE_NOTICE_MS\)/);
  assert.match(app, /if\(!configured\) \{ webStorageToast\(t\('webStorage\.none'\),'warn'\); return; \}/);
  assert.match(app, /if\(!available\) \{ webStorageToast\(t\('webStorage\.rcloneMissing'\),'err'\); return; \}/);
  assert.match(app, /function toast\(msg, kind, durationMs\)/);
  assert.match(app, /Math\.min\(requested, 60000\) : 2600/);
});

test('1.67.7 share context menu has an opaque theme-aware surface', () => {
  const rule = css.match(/\.share-context-menu\{[^}]+\}/)?.[0] || '';
  assert.match(rule, /background:var\(--card\)/);
  assert.match(rule, /color:var\(--text\)/);
  assert.match(rule, /opacity:1/);
  assert.match(rule, /backdrop-filter:none/);
  assert.doesNotMatch(rule, /background:var\(--panel\)/);
  assert.match(css, /\.share-context-item:hover,.share-context-item:focus-visible\{background:var\(--card-2\);outline:none\}/);
});
