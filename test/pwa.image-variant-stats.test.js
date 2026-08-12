'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('each PWA image card renders Full, Mini and Micro dimensions and audience counters', () => {
  assert.match(js, /class="imgvariant" data-kind="full"/);
  assert.match(js, /class="imgvariant" data-kind="thumb"/);
  assert.match(js, /class="imgvariant" data-kind="micro"/);
  assert.match(js, /variant\.w \+ '×' \+ variant\.h/);
  assert.match(js, /class="iv-size"/);
  assert.match(js, /fmtBytes\(variant\.bytes\)/);
  assert.match(js, /t\('imgViews', \{ n:/);
  assert.match(js, /t\('imgVisitors', \{ n:/);
  assert.match(js, /class="iv-metric iv-views"/);
  assert.match(js, /class="iv-metric iv-visitors"/);
  assert.match(js, /class="img-total-metric it-views"/);
  assert.match(js, /class="img-total-metric it-visitors"/);
  assert.match(css, /\.imglink-total \{[^}]*flex-wrap: wrap;[^}]*font-weight:/);
  assert.match(css, /\.imglink-variants \{ display: grid;/);
  assert.match(css, /\.imgvariant \.iv-size/);
  assert.match(css, /\.imgvariant \.iv-metrics/);
});

test('PWA restores manageable images and refreshes their statistics periodically', () => {
  assert.match(js, /fetch\('\/app\/images\?limit=500&includeInactive=1'/);
  assert.match(js, /refreshImageStats\(true\)/);
  assert.match(js, /setInterval\(function \(\) \{ if \(!document\.hidden\) refreshImageStats\(false\); \}, 3000\)/);
  assert.match(js, /imageRowsByToken = new Map\(\)/);
});

test('server returns dimensions and views\/visitors for all three variants', () => {
  assert.match(server, /function pwaPhotoPayload\(req, share\)/);
  assert.match(server, /app\.get\('\/app\/images'/);
  assert.match(server, /app\.get\('\/app\/image\/:token\/stats'/);
  assert.match(server, /totals: \{ views: totalViews, visitors: uniqueVisitors\.size, bytes:/);
  assert.match(server, /full: \{ \.\.\.full, bytes: fullBytes, ready: true, views:/);
  assert.match(server, /thumb: \{ \.\.\.thumb, bytes: thumbBytes, ready: !!share\.thumb, views:/);
  assert.match(server, /micro: \{ \.\.\.micro, bytes: microBytes, ready: !!share\.micro, views:/);
  assert.match(server, /s\.thumbSize = size/);
  assert.match(server, /s\.thumbW = dims\.w; s\.thumbH = dims\.h/);
  assert.match(server, /s\.microSize = size/);
  assert.match(server, /s\.microW = dims\.w; s\.microH = dims\.h/);
});

test('standard-admin Mini/Micro rewrites refresh the metadata consumed by PWA cards', () => {
  assert.match(server, /adminRouter\.post\('\/photos\/:id\/thumb'[\s\S]*?s\.thumbSize = size;[\s\S]*?s\.thumbW = dims\.w; s\.thumbH = dims\.h;[\s\S]*?s\.thumbMetaMtimeMs = Math\.floor\(fs\.statSync\(dest\)\.mtimeMs \|\| 0\)/);
  assert.match(server, /adminRouter\.post\('\/photos\/:id\/micro'[\s\S]*?s\.microSize = size;[\s\S]*?s\.microW = dims\.w; s\.microH = dims\.h;[\s\S]*?s\.microMetaMtimeMs = Math\.floor\(fs\.statSync\(dest\)\.mtimeMs \|\| 0\)/);
  assert.match(server, /const stale = !w \|\| !h \|\| !knownMtime \|\| \(diskMtime && knownMtime !== diskMtime\) \|\| \(diskBytes && bytes !== diskBytes\)/);
  assert.match(server, /readVariantMeta\('thumb', 'thumbW', 'thumbH', 'thumbSize', 'thumbMetaMtimeMs'/);
  assert.match(server, /readVariantMeta\('micro', 'microW', 'microH', 'microSize', 'microMetaMtimeMs'/);
});
