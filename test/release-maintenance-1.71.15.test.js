'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('1.71.15 keeps the audited dependency maintenance baseline', () => {
  assert.equal(pkg.version, '1.71.15');
  assert.equal(pkg.dependencies.express, '^4.22.2');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.2');
  assert.equal(pkg.dependencies['node-forge'], '^1.4.0');
  assert.equal(lock.packages['node_modules/node-forge'].version, '1.4.0');
  assert.equal(pkg.dependencies.nodemailer, '^9.0.5');
  assert.equal(lock.packages['node_modules/nodemailer'].version, '9.0.5');
});

test('1.71.15 PWA release metadata advances atomically', () => {
  for (const rel of ['pwa/app.js', 'pwa/sw.js', 'pwa/theme-init.js', 'pwa/index.html']) {
    const source = read(rel);
    assert.match(source, /1\.71\.15|pwa478|v=459/);
    assert.doesNotMatch(source, /1\.71\.12|pwa475|v=456/);
  }
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.26-pwa478'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.26-pwa478'/);
});

test('1.71.15 Tesseract source acquisition targets the exact annotated release tag ref', () => {
  const dockerfile = read('Dockerfile');
  const firstFrom = dockerfile.indexOf('FROM ');
  assert.ok(dockerfile.indexOf('ARG DX_TESSERACT_BUILD_VERSION=5.5.3') < firstFrom);
  assert.ok(dockerfile.indexOf('ARG DX_TESSERACT_BUILD_COMMIT=db0ec62f81b0737fbbe184d8fea40af5738f8eef') < firstFrom);
  assert.match(dockerfile, /refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}:refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}/);
  assert.match(dockerfile, /cat-file -t refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}/);
  assert.match(dockerfile, /rev-parse refs\/tags\/\$\{DX_TESSERACT_BUILD_VERSION\}\^\{commit\}/);
  assert.match(dockerfile, /DX_TESSERACT_BUILD_COMMIT=db0ec62f81b0737fbbe184d8fea40af5738f8eef/);
  assert.doesNotMatch(dockerfile, /git clone --depth=1 --branch/);
});
