'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('PWA image copy format includes BBCode for every image variant and bulk copy', () => {
  assert.match(html, /<option value="bb">BBCode<\/option>/);
  assert.match(js, /if \(fmt === 'bb'\) return imageVariantBBCode\(photo, kind, url\);/);
  assert.match(js, /if \(\(kind === 'thumb' \|\| kind === 'micro'\) && fullUrl && variantUrl\)/);
  assert.match(js, /return '\[url=' \+ fullUrl \+ '\]\[img\]' \+ variantUrl \+ '\[\/img\]\[\/url\]';/);
  assert.match(js, /return '\[img\]' \+ variantUrl \+ '\[\/img\]';/);
  assert.match(js, /row\.querySelectorAll\('\.imgvariant'\)\.forEach/);
  assert.match(js, /copyVariant\.addEventListener\('click', copyOne\(kind\)\)/);
  assert.match(js, /var kind = IMAGE_PRIMARY_VARIANT;/);
  assert.match(js, /return formatLink\(imageVariantUrl\(photo, kind\), photo\.name/);
});

test('release metadata is internally consistent across package, lock and app build', () => {
  // Assert internal consistency rather than a frozen release number.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(js, /APP_BUILD = '2026\.\d\d\.\d\d-pwa\d+'/);
});
