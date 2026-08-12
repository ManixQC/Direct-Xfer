'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('PWA image links expose a dedicated EXIF/GPS removal option', () => {
  assert.match(html, /id=\"imglink-strip-exif\"[^>]*checked/);
  assert.match(html, /data-i18n=\"imgStripExif\"/);
});

test('image-link metadata removal re-encodes locally before upload', () => {
  assert.match(js, /var stripMetadata = !!\(\$\('imglink-strip-exif'\)/);
  assert.match(js, /prepareImageForLink\(file, stripMetadata\)/);
  assert.match(js, /ctx\.drawImage\(image/);
  assert.match(js, /metadataStripped: true/);
  const prepareIndex = js.indexOf('var prepared = await prepareImageForLink(workingFile, stripMetadata)');
  const uploadIndex = js.indexOf('var r = await imageDlpMutate(uploadUrl');
  assert.ok(prepareIndex >= 0 && uploadIndex > prepareIndex, 'cleaning must happen before upload');
});

test('image-link EXIF/GPS preference is remembered with a privacy-safe default', () => {
  assert.match(js, /dx-pwa-imglink-stripexif/);
  assert.match(js, /localStorage\.getItem\('dx-pwa-imglink-stripexif'\) !== '0'/);
});
