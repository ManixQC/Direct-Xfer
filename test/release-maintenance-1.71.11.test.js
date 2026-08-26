'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('1.71.11 keeps Express on the audited 4.x line and accepts Nodemailer 9.0.5', () => {
  assert.equal(pkg.version, '1.71.11');
  assert.equal(pkg.dependencies.express, '^4.22.2');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.2');
  assert.equal(pkg.dependencies.nodemailer, '^9.0.5');
  assert.equal(lock.packages[''].dependencies.nodemailer, '^9.0.5');
  assert.equal(lock.packages['node_modules/nodemailer'].version, '9.0.5');
  assert.match(lock.packages['node_modules/nodemailer'].resolved, /nodemailer-9\.0\.5\.tgz$/);
});

test('1.71.11 Dependabot keeps Express major migration out of routine updates', () => {
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /dependency-name:\s*["']express["'][\s\S]*?version-update:semver-major/);
  assert.match(dependabot, /versioning-strategy:\s*["']increase["']/);
});

test('1.71.11 adopts the validated GitHub Actions maintenance updates', () => {
  const windows = read('.github/workflows/build-windows-csharp.yml');
  const codacy = read('.github/workflows/codacy.yml');
  assert.match(windows, /actions\/setup-dotnet@v6/);
  assert.doesNotMatch(windows, /actions\/setup-dotnet@v5/);
  assert.match(codacy, /codacy\/codacy-analysis-cli-action@562ee3e92b8e92df8b67e0a5ff8aa8e261919c08/);
});

test('1.71.11 PWA release metadata advances atomically', () => {
  for (const rel of ['pwa/app.js', 'pwa/sw.js', 'pwa/theme-init.js', 'pwa/index.html']) {
    const source = read(rel);
    assert.match(source, /1\.71\.11|pwa474|v=455/);
    assert.doesNotMatch(source, /1\.71\.9|pwa472|v=453/);
  }
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.26-pwa474'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.26-pwa474'/);
});
