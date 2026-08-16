'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('shares action strip does not use flex-end on a horizontal scroller', () => {
  const block = css.match(/\.shares-head \.head-actions \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /justify-content:\s*flex-start/);
  assert.doesNotMatch(block, /justify-content:\s*flex-end/);
  assert.match(block, /overflow-x:\s*auto/);
  assert.match(block, /padding-inline:\s*2px/);
});

test('shares action strip keeps right alignment without clipping its leading edge', () => {
  assert.match(css, /\.shares-head \.head-actions::before\s*\{[\s\S]*margin-inline-start:\s*auto/);
});

test('CSV export button stays in the standard shares toolbar', () => {
  assert.match(html, /id="links-export-csv"/);
  assert.match(html, /\/style\.css\?v=277/);
});
