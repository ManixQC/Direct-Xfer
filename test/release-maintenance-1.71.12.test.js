'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('1.71.12 dependency maintenance invariants remain preserved after later release bumps', () => {
  assert.equal(pkg.dependencies.express, '^4.22.2');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.2');
  assert.equal(pkg.dependencies.nodemailer, '^9.0.5');
  assert.equal(lock.packages[''].dependencies.nodemailer, '^9.0.5');
  assert.equal(lock.packages['node_modules/nodemailer'].version, '9.0.5');
});

test('1.71.12 Dependabot Express-major exclusion remains preserved', () => {
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /dependency-name:\s*["']express["'][\s\S]*?version-update:semver-major/);
});

test('1.71.12 GitHub Actions maintenance baseline is not regressed', () => {
  const windows = read('.github/workflows/build-windows-csharp.yml');
  const codacy = read('.github/workflows/codacy.yml');
  assert.match(windows, /actions\/setup-dotnet@v(?:6|[7-9]|[1-9][0-9]+)/);
  assert.doesNotMatch(windows, /actions\/setup-dotnet@v5/);
  assert.match(codacy, /codacy\/codacy-analysis-cli-action@562ee3e92b8e92df8b67e0a5ff8aa8e261919c08/);
});

test('historical 1.71.12 test does not pin current release or PWA cache metadata', () => {
  assert.match(pkg.version, /^1\.71\.(?:1[3-9]|[2-9][0-9]|[1-9][0-9]{2,})$/);
  const app = read('pwa/app.js');
  assert.doesNotMatch(app, /APP_VERSION = '1\.71\.12'/);
  assert.doesNotMatch(app, /APP_BUILD = '2026\.08\.26-pwa475'/);
  assert.doesNotMatch(read('pwa/index.html'), /v=456/);
});
