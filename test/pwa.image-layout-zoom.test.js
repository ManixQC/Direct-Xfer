'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const themeInit = fs.readFileSync(path.join(root, 'pwa', 'theme-init.js'), 'utf8');

test('mobile image audience counters use independent non-overlapping rows', () => {
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?grid-template-areas:\s*"name dims action"\s*"name size action"\s*"metrics metrics metrics"/s);
  assert.match(css, /\.imgvariant \.iv-size \{ grid-area: size; \}/);
  assert.match(css, /\.imgvariant \.iv-metrics \{[\s\S]*?grid-area: metrics;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?border-top:/);
  assert.match(css, /\.imgvariant \.iv-metric \{[^}]*grid-template-columns: 1\.35rem minmax\(0, 1fr\);/);
  assert.match(css, /\.imgvariant \.iv-metric-text \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.imglink-total \{[^}]*flex-wrap: wrap;/);
});

test('fixed PWA viewport ignores visual viewport resize while pinch zoom is active', () => {
  assert.match(themeInit, /Number\(viewport\.scale \|\| 1\) > 1\.01/);
  assert.match(themeInit, /if \(pinching\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(themeInit, /document\.documentElement\.classList\.remove\('dx-pinching'\)/);
  assert.match(themeInit, /var height = viewport && viewport\.height \? viewport\.height : window\.innerHeight/);
});
