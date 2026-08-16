'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('New share button remains the primary action in Active shares', () => {
  assert.match(html, /id="new-share-btn"[^>]*class="btn sm"/);
});

test('New share button is 35 percent larger than the compact share actions', () => {
  assert.match(css, /\.shares-head \.head-actions #new-share-btn\.btn\.sm\s*\{[\s\S]*?padding-block:\s*10\.8px;[\s\S]*?padding-inline:\s*13\.5px;[\s\S]*?font-size:\s*1\.08rem;/);
});

test('share action layout keeps a compact non-scrolling grouped toolbar', () => {
  assert.match(css, /\.shares-head \.head-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*flex-end;[\s\S]*?overflow:\s*visible;/);
  assert.match(css, /\.share-action-menu-panel\s*\{/);
});

test('standard stylesheet cache revision is advanced', () => {
  assert.match(html, /href="\/style\.css\?v=286"/);
});
