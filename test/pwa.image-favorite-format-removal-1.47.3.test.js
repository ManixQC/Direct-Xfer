'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('pwa/index.html');
const app = read('pwa/app.js');
const css = read('pwa/app.css');
const sw = read('pwa/sw.js');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('the favorite image format control and its obsolete UI code are removed', () => {
  assert.doesNotMatch(html, /img-default-variant|imgDefaultVariantLabel|Format d’image favori/);
  assert.doesNotMatch(app, /imgDefaultVariantLabel|function imageDefaultVariant\(\)/);
  assert.doesNotMatch(css, /image-default-field|favourite-format|favorite-format/);
  assert.match(app, /localStorage\.removeItem\('dx-pwa-img-default-variant'\)/);
});

test('automatic image links are used consistently without a user preference', () => {
  assert.match(app, /var IMAGE_PRIMARY_VARIANT = 'auto';/);
  assert.match(app, /imageVariantUrl\(photo, IMAGE_PRIMARY_VARIANT\)/);
  assert.match(app, /var kind = IMAGE_PRIMARY_VARIANT;/);
  assert.doesNotMatch(app, /localStorage\.setItem\('dx-pwa-img-default-variant'/);
});

test('1.51.2 release and PWA cache identifiers stay synchronized', () => {
  assert.equal(pkg.version, '1.60.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(app, /APP_VERSION = '1\.60\.0'/);
  assert.match(app, /APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(sw, /VERSION = '2026\.08\.15-pwa289'/);
  assert.match(html, /v1\.60\.0 · pwa289/);
  assert.match(html, /app\.css\?v=272/);
  assert.match(html, /app\.js\?v=273/);
});
