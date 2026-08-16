'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Active shares header uses grouped actions without horizontal scrolling', () => {
  const block = css.match(/\.shares-head \.head-actions \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /display:\s*flex/);
  assert.match(block, /justify-content:\s*flex-end/);
  assert.match(block, /overflow:\s*visible/);
  assert.doesNotMatch(block, /overflow-x:\s*auto/);
  assert.match(html, /id="share-create-menu-btn"/);
  assert.match(html, /id="share-config-menu-btn"/);
});

test('Active shares grouped toolbar keeps a no-scroll responsive fallback', () => {
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*\.shares-head \.head-actions[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /#share-config-menu \.share-action-menu-panel[\s\S]*right:\s*0/);
});

test('standard page invalidates the stylesheet cache for the layout change', () => {
  assert.match(html, /\/style\.css\?v=286/);
});
