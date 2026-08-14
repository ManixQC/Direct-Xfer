'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('PWA image cards no longer render the redundant Copy a format action group', () => {
  assert.doesNotMatch(js, /imglink-copy-group|imglink-copy-label|imgCopyActions/);
  assert.doesNotMatch(js, /class=\"btn ghost sm il-(?:auto|full|thumb|micro)\"/);
  assert.doesNotMatch(js, /querySelector\('\.il-(?:auto|full|thumb|micro)'\)/);
});

test('Full, Mini and Micro keep their dedicated per-format copy buttons', () => {
  const copyButtons = (js.match(/<button class=\"iv-copy\" type=\"button\">/g) || []).length;
  assert.equal(copyButtons, 3);
  assert.match(js, /copyVariant\.addEventListener\('click', copyOne\(kind\)\)/);
});

test('favorite image actions no longer offer the removed duplicate Copy action', () => {
  assert.doesNotMatch(html, /id=\"img-action-[123]\"[\s\S]*?<option value=\"full\"/);
  assert.match(js, /var mapping = \{ open: '\.il-open', qr: '\.il-qr', edit: '\.il-edit'/);
  assert.match(css, /\.imglink-actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
});
