'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const releaseVersion = pkg.version;

function capture(source, re, label) {
  const match = source.match(re);
  assert.ok(match, `${label} must be present`);
  return match[1];
}


test(`${releaseVersion} keeps the audited dependency maintenance baseline`, () => {
  assert.equal(lock.version, releaseVersion);
  assert.equal(lock.packages[''].version, releaseVersion);
  assert.equal(pkg.dependencies.express, '^4.22.2');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.2');
  assert.equal(pkg.dependencies['node-forge'], '^1.4.0');
  assert.equal(lock.packages['node_modules/node-forge'].version, '1.4.0');
  assert.equal(pkg.dependencies.nodemailer, '^9.0.5');
  assert.equal(lock.packages['node_modules/nodemailer'].version, '9.0.5');
});

test(`${releaseVersion} PWA release metadata advances atomically without release-specific test literals`, () => {
  const app = read('pwa/app.js');
  const sw = read('pwa/sw.js');
  const theme = read('pwa/theme-init.js');
  const index = read('pwa/index.html');
  const login = read('pwa/login.js');
  const loginHtml = read('pwa/login.html');
  const admin = read('pwa/admin-advanced.js');
  const mobile = read('pwa/mobile-intelligence.js');

  const appVersion = capture(app, /APP_VERSION = '([^']+)'/, 'PWA APP_VERSION');
  const appBuild = capture(app, /APP_BUILD = '([^']+)'/, 'PWA APP_BUILD');
  const swBuild = capture(sw, /VERSION = '([^']+)'/, 'service-worker VERSION');
  const themeVersion = capture(theme, /var release = \{ version: '([^']+)'/, 'theme release version');
  const themeBuild = capture(theme, /var release = \{ version: '[^']+', build: '([^']+)' \}/, 'theme release build');
  const buildTagVersion = capture(index, /id="build-tag"[^>]*>v([^ ]+) · /, 'PWA build-tag version');
  const buildTagPwa = capture(index, /id="build-tag"[^>]*>v[^ ]+ · (pwa\d+)</, 'PWA build-tag generation');

  assert.equal(appVersion, releaseVersion);
  assert.equal(themeVersion, releaseVersion);
  assert.equal(buildTagVersion, releaseVersion);
  assert.equal(swBuild, appBuild);
  assert.equal(themeBuild, appBuild);
  assert.match(appBuild, /^\d{4}\.\d{2}\.\d{2}-(pwa\d+)$/);
  assert.equal(buildTagPwa, appBuild.match(/-(pwa\d+)$/)[1]);

  const currentCache = capture(index, /\/app\/app\.css\?v=(\d+)/, 'PWA current cache generation');
  assert.match(currentCache, /^\d+$/);
  const escapedCache = currentCache.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const releaseCacheChecks = [
    [index, new RegExp(`direct-xfer-pwa\\.webmanifest\\?v=${escapedCache}`), 'PWA manifest'],
    [index, new RegExp(`\\/app\\/app\\.js\\?v=${escapedCache}`), 'PWA app script'],
    [app, new RegExp(`direct-xfer-pwa(?:-en|-es)?\\.webmanifest\\?v=${escapedCache}`), 'localized PWA manifest'],
    [app, new RegExp(`direct-xfer-pwa-sw\\.js\\?v=${escapedCache}`), 'PWA service worker registration'],
    [loginHtml, new RegExp(`direct-xfer-pwa\\.webmanifest\\?v=${escapedCache}`), 'login manifest'],
    [loginHtml, new RegExp(`login-vault\\.js\\?v=${escapedCache}`), 'login vault'],
    [theme, new RegExp(`admin-advanced\\.js\\?v=${escapedCache}`), 'advanced admin module'],
    [theme, new RegExp(`admin-audit-connectors\\.js\\?v=${escapedCache}`), 'audit/connectors module'],
    [admin, new RegExp(`server-health-dashboard\\.js\\?v=${escapedCache}`), 'system-health module'],
    [sw, new RegExp(`\\/app\\/app\\.js\\?v=${escapedCache}`), 'service-worker app precache'],
    [sw, new RegExp(`\\/app\\/mobile-intelligence\\.js\\?v=${escapedCache}`), 'mobile intelligence precache'],
    [login, new RegExp(`direct-xfer-pwa-sw\\.js\\?v=${escapedCache}`), 'login service worker registration'],
  ];
  for (const [source, pattern, label] of releaseCacheChecks) assert.match(source, pattern, `${label} must use the current cache generation`);
});


test(`${releaseVersion} test runner ignores stale version-stamped maintenance copies but keeps current generic tests`, () => {
  const { selectTests } = require('../scripts/run-tests');
  const fixture = [
    'account-service-deep-audit-1.69.11.test.js',
    'trivy-container-hardening-1.71.15.test.js',
    'trivy-container-hardening-1.71.16.test.js',
    'release-maintenance-1.71.11.test.js',
    'release-maintenance-1.71.12.test.js',
    'trivy-container-hardening.test.js',
    'release-maintenance.test.js',
  ];
  const { retired, selected } = selectTests(fixture);
  assert.deepEqual(retired, [
    'release-maintenance-1.71.11.test.js',
    'release-maintenance-1.71.12.test.js',
    'trivy-container-hardening-1.71.15.test.js',
    'trivy-container-hardening-1.71.16.test.js',
  ]);
  assert.ok(selected.includes('account-service-deep-audit-1.69.11.test.js'));
  assert.ok(selected.includes('release-maintenance.test.js'));
  assert.ok(selected.includes('trivy-container-hardening.test.js'));
});

test(`${releaseVersion} Tesseract source acquisition targets the exact annotated release tag ref`, () => {
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
