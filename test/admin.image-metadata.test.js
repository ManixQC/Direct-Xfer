'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Images page exposes a privacy-safe EXIF/GPS cleaning option', () => {
  assert.match(html, /id="photos-strip-exif"[^>]*checked/);
  assert.match(html, /data-i18n="photo\.stripExif"/);
  assert.match(js, /photoStripExif: true/);
  assert.match(js, /photoStripExif: uiPrefs\.photoStripExif !== false/);
});

test('all Images-page add paths snapshot and apply metadata cleaning before upload', () => {
  assert.match(js, /const stripMetadata = !!state\.photoStripExif/);
  assert.match(js, /uploadHostImagePaths\(paths, stripMetadata\)/);
  assert.match(js, /preparePhotoUpload\(file, stripMetadata\)/);
  assert.match(js, /context\.drawImage\(image/);
  const cleanIndex = js.indexOf('const prepared = await preparePhotoUpload(file, stripMetadata)');
  const uploadIndex = js.indexOf("'/api/photos/upload?name='");
  assert.ok(cleanIndex >= 0 && uploadIndex > cleanIndex, 'metadata cleaning must finish before public upload');
});

test('host picker source route is authenticated, bounded and non-public', () => {
  assert.match(server, /adminRouter\.post\('\/photos\/source'/);
  assert.match(server, /item\.size > IMAGE_MAX_BYTES/);
  assert.match(server, /await assertRealWithin\(HOST_ROOT, source\)/);
  assert.match(server, /Cache-Control', 'no-store'/);
});
