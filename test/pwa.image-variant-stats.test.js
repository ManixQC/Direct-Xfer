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
  assert.match(server, /s\[kind \+ 'Size'\] = size/);
  assert.match(server, /s\[kind \+ 'W'\] = dims\.w; s\[kind \+ 'H'\] = dims\.h/);
  assert.match(server, /handleAdminPhotoVariantUpload\(req,res,s,'thumb'/);
  assert.match(server, /handleAdminPhotoVariantUpload\(req,res,s,'micro'/);
});

test('standard-admin Mini/Micro rewrites refresh the metadata consumed by PWA cards', () => {
  assert.match(server, /function handleAdminPhotoVariantUpload[\s\S]*?s\[kind \+ 'Size'\] = size;[\s\S]*?s\[kind \+ 'W'\] = dims\.w; s\[kind \+ 'H'\] = dims\.h;[\s\S]*?s\[kind \+ 'MetaMtimeMs'\] = Math\.floor\(fs\.statSync\(dest\)\.mtimeMs \|\| 0\)/);
  assert.match(server, /adminRouter\.post\('\/photos\/:id\/thumb'[\s\S]*?handleAdminPhotoVariantUpload\(req,res,s,'thumb'/);
  assert.match(server, /adminRouter\.post\('\/photos\/:id\/micro'[\s\S]*?handleAdminPhotoVariantUpload\(req,res,s,'micro'/);
  assert.match(server, /const stale = !w \|\| !h \|\| !knownMtime \|\| \(diskMtime && knownMtime !== diskMtime\) \|\| \(diskBytes && bytes !== diskBytes\)/);
  assert.match(server, /readVariantMeta\('thumb', 'thumbW', 'thumbH', 'thumbSize', 'thumbMetaMtimeMs'/);
  assert.match(server, /readVariantMeta\('micro', 'microW', 'microH', 'microSize', 'microMetaMtimeMs'/);
});
