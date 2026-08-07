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
  assert.match(js, /if \(fmt === 'bb'\) return '\[img\]' \+ url \+ '\[\/img\]';/);
  assert.match(js, /copyOne\('full'\)/);
  assert.match(js, /copyOne\('thumb'\)/);
  assert.match(js, /copyOne\('micro'\)/);
  assert.match(js, /var kind = imageDefaultVariant\(\);/);
  assert.match(js, /return formatLink\(imageVariantUrl\(photo, kind\), photo\.name/);
});

test('release metadata is internally consistent across package, lock and app build', () => {
  // Assert internal consistency rather than a frozen release number.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(js, /APP_BUILD = '2026\.\d\d\.\d\d-pwa\d+'/);
});
