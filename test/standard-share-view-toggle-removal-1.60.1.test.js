'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('public', 'index.html');
const app = read('public', 'app.js');
const css = read('public', 'style.css');

test('standard Partages no longer exposes list/grid display controls', () => {
  assert.doesNotMatch(html, /id="shares-view-list"/);
  assert.doesNotMatch(html, /id="shares-view-grid"/);
  assert.doesNotMatch(html, /<div class="ui-view-toggle"[^>]*>[\s\S]*?shares-view-/);
  assert.match(html, /id="shares-list" class="shares-list"/);
});

test('obsolete share view preference and event wiring are removed', () => {
  assert.doesNotMatch(app, /shareView:/);
  assert.doesNotMatch(app, /function setShareView\(/);
  assert.doesNotMatch(app, /shares-view-list|shares-view-grid/);
  assert.doesNotMatch(app, /updateUiPrefs\(\{ shareView:/);
});

test('Partages keeps the permanent stacked layout while Images retains its independent view switcher', () => {
  assert.match(css, /\.shares-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.doesNotMatch(css, /\.shares-list\.view-grid|\.shares-list\.view-list/);
  assert.match(html, /id="photos-view-grid"/);
  assert.match(html, /id="photos-view-list"/);
  assert.match(app, /function setPhotoView\(/);
});
