'use strict';

// Guards against the mobile horizontal-overflow regressions fixed in the admin UI:
// on narrow screens the per-card action buttons and the page top bars must wrap
// instead of stretching the layout past the viewport.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

function ruleBlock(selector) {
  // Grab the first `<selector> { ... }` block (selector at the start of a rule).
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*\\}');
  const m = css.match(re);
  return m ? m[0] : null;
}

test('per-card share actions wrap on narrow screens', () => {
  const block = ruleBlock('.share-actions');
  assert.ok(block, '.share-actions rule must exist');
  assert.match(block, /display:\s*flex/);
  assert.match(block, /flex-wrap:\s*wrap/);
});

test('the page top bar wraps so the brand + menu cluster never overflow mobile', () => {
  const block = ruleBlock('.topbar');
  assert.ok(block, '.topbar rule must exist');
  assert.match(block, /display:\s*flex/);
  assert.match(block, /flex-wrap:\s*wrap/);
});

test('per-card share actions become a tidy, aligned grid on phones', () => {
  // A ragged wrapped row of unevenly sized buttons is replaced by an equal-column
  // grid: 3 columns on large phones/small tablets, 2 on phones.
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /\.share-actions\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*460px\)[\s\S]*?\.share-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  // The destructive Revoke action spans the full width, set apart at the bottom.
  assert.match(css, /\.share-actions\s*>\s*\.btn\.danger\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test('the share card name breaks at sensible points, not mid-word', () => {
  const block = ruleBlock('.share-top .name');
  assert.ok(block, '.share-top .name rule must exist');
  assert.doesNotMatch(block, /word-break:\s*break-all/);
  assert.match(block, /overflow-wrap:\s*anywhere/);
});

test('tablet admin topbar keeps the brand and right-side controls on the same centered row', () => {
  assert.match(css, /@media\s*\(min-width:\s*641px\)\s*and\s*\(max-width:\s*900px\)/);
  assert.match(css, /#app-view\s+\.topbar\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+repeat\(5,\s*max-content\)[^}]*align-items:\s*center/);
  assert.match(css, /#app-view\s+\.admin-brand\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*1[^}]*align-self:\s*center/);
  assert.match(css, /#app-view\s+\.topbar-menus\s*\{[^}]*display:\s*contents/);
  assert.match(css, /#app-view\s+\.dash-menu\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;\s*\}/);
  assert.match(css, /#app-view\s+\.images-menu\s*\{\s*grid-column:\s*3;\s*grid-row:\s*1;\s*\}/);
  assert.match(css, /#app-view\s+\.config-menu\s*\{\s*grid-column:\s*4;\s*grid-row:\s*1;\s*\}/);
  assert.match(css, /#app-view\s+\.notifications-menu\s*\{\s*grid-column:\s*5;\s*grid-row:\s*1;\s*\}/);
  assert.match(css, /#app-view\s+\.user-menu\s*\{\s*grid-column:\s*6;\s*grid-row:\s*1;\s*\}/);
  assert.match(css, /#app-view\s+\.topbar-menus\s+\.pwa-cta\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/);
});
