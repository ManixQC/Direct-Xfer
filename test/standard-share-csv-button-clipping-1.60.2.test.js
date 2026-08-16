'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('shares action strip uses grouped menus instead of a horizontal scroller', () => {
  const block = css.match(/\.shares-head \.head-actions \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /display:\s*flex/);
  assert.doesNotMatch(block, /overflow-x:\s*auto/);
  assert.match(block, /overflow:\s*visible/);
  assert.match(css, /\.share-action-menu-panel\s*\{/);
});

test('shares action strip no longer needs the old spacer pseudo-element', () => {
  assert.doesNotMatch(css, /\.shares-head \.head-actions::before\s*\{/);
});

test('CSV export button stays available in the standard shares Config menu', () => {
  assert.match(html, /id="share-config-menu-panel"[\s\S]*id="links-export-csv"/);
  assert.match(html, /\/style\.css\?v=286/);
});
