'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('system health section headings do not use the dashboard negative margin', () => {
  const css = read('public/server-health-dashboard.css');
  assert.match(css, /\.server-health-panel\s*>\s*\.dash-section\s*\{[^}]*margin:\s*22px\s+0\s+10px/s);
  assert.doesNotMatch(css, /\.server-health-panel\s*>\s*\.dash-section\s*\{[^}]*margin:[^;}]*-6px/s);
});

test('system health card titles keep their own vertical space and remain visible', () => {
  const css = read('public/server-health-dashboard.css');
  assert.match(css, /\.server-health-panel\s+\.chart-title\s*\{[^}]*min-height:\s*1\.35em/s);
  assert.match(css, /\.server-health-panel\s+\.chart-title\s*\{[^}]*line-height:\s*1\.35/s);
  assert.match(css, /\.server-health-panel\s+\.chart-title\s*\{[^}]*overflow:\s*visible/s);
});

test('system health stylesheet cache key is bumped', () => {
  const html = read('public/index.html');
  assert.match(html, /\/server-health-dashboard\.css\?v=3/);
});
