'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const html = read('pwa', 'index.html');
const css = read('pwa', 'app.css');
const sw = read('pwa', 'sw.js');

test('PWA checkbox labels use a stable two-column layout aligned to the first text line', () => {
  assert.match(css, /\.checkline \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 18px minmax\(0, 1fr\);[\s\S]*?align-items: start;[\s\S]*?line-height: 1\.4;/);
  assert.match(css, /\.checkline input\[type="checkbox"\] \{[\s\S]*?width: 18px;[\s\S]*?height: 18px;[\s\S]*?margin: 1px 0 0;[\s\S]*?align-self: start;/);
  assert.match(css, /\.checkline > span \{[^}]*min-width: 0;[^}]*line-height: 1\.4;[^}]*overflow-wrap: anywhere;/);
  assert.doesNotMatch(css, /\.checkline input[^}]*\blh\b/);
});

test('Activity filter checkboxes use the same deterministic alignment model', () => {
  assert.match(css, /\.activity-filter-check\{[^}]*display:grid[^}]*grid-template-columns:18px minmax\(0,1fr\)[^}]*align-items:start[^}]*line-height:1\.4/);
  assert.match(css, /\.activity-filter-check input\[type="checkbox"\]\{[^}]*width:18px[^}]*height:18px[^}]*margin:0[^}]*align-self:start/);
  assert.match(css, /\.activity-filter-check span\{[^}]*line-height:1\.4[^}]*overflow-wrap:anywhere/);
});

test('standalone share-browser checkboxes have native margins reset', () => {
  assert.match(css, /\.share-check \{[^}]*margin: 0 0 0 12px;[^}]*align-self: center;/);
  assert.match(css, /\.share-entry input\[type="checkbox"\] \{[^}]*margin: 0;[^}]*align-self: center;/);
});

test('all static PWA checkbox rows keep checkbox first and text second', () => {
  const labels = html.match(/<label\b[^>]*class="[^"]*(?:checkline|activity-filter-check)[^"]*"[^>]*>[\s\S]*?<\/label>/g) || [];
  assert.ok(labels.length >= 20, 'expected the PWA to expose its checkbox rows');
  for (const label of labels) {
    assert.match(label, /<input\b[^>]*type="checkbox"[^>]*>[\s\S]*?<span\b/, 'checkbox label must keep input before its text span');
  }
});

test('the corrected stylesheet is cache-busted without changing the 1.63.4 application build', () => {
  assert.match(html, /\/app\/app\.css\?v=280/);
  assert.match(sw, /'\/app\/app\.css\?v=280'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa317'/);
});
