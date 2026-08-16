'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('standard mobile install invitation waits for installation-state detection', () => {
  const app = read('public', 'app.js');
  const css = read('public', 'style.css');
  const html = read('public', 'index.html');
  assert.match(app, /navigator\.getInstalledRelatedApps/);
  assert.match(app, /dx-pwa-installed/);
  assert.match(app, /applyInstallOffer\(!installed\)/);
  assert.match(app, /fetch\('\/pwa\/install-state'/);
  assert.match(app, /return localInstalled/);
  assert.doesNotMatch(app, /setInstalledMarker\(false\)/);
  assert.match(css, /html\.is-mobile\.pwa-install-offer #app-view \.pwa-install-cta/);
  assert.match(html, /admin-pwa-detect\.webmanifest/);
});

test('installed PWA records a same-origin fallback marker from app and login shells', () => {
  const app = read('pwa', 'app.js');
  const login = read('pwa', 'login.js');
  for (const source of [app, login]) {
    assert.match(source, /function rememberInstalledPwa\(\)/);
    assert.match(source, /localStorage\.setItem\('dx-pwa-installed'/);
    assert.match(source, /dx_pwa_installed=' \+ encodeURIComponent\(String\(Date\.now\(\)\)\)/);
    assert.match(source, /if \(isStandaloneApp\(\)\) rememberInstalledPwa\(\)/);
    assert.match(source, /appinstalled[\s\S]*rememberInstalledPwa\(\)/);
  }
});

test('server exposes out-of-scope Android PWA relationship documents without hard-coded origin', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/admin-pwa-detect\.webmanifest'/);
  assert.match(server, /app\.get\('\/\.well-known\/assetlinks\.json'/);
  assert.match(server, /app\.get\('\/pwa\/install-state'/);
  assert.match(server, /installedStandaloneSeenAt/);
  assert.match(server, /delegate_permission\/common\.query_webapk/);
  assert.match(server, /pwaDetectionOrigin\(req\)/);
  assert.doesNotMatch(server, /site:\s*'https:\/\//);
});

test('PWA shell build advances so installed clients receive the marker code', () => {
  assert.match(read('pwa','app.js'), /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa','sw.js'), /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(read('pwa','index.html'), /v1\.63\.4 · pwa317/);
});

test('installed-PWA detection uses the real install manifest URLs and accepts the verified webapp result', () => {
  const app = read('public', 'app.js');
  const server = read('server.js');
  const html = read('public', 'index.html');
  assert.match(server, /direct-xfer-pwa\.webmanifest/);
  assert.match(server, /direct-xfer-pwa-en\.webmanifest/);
  assert.match(server, /direct-xfer-pwa-es\.webmanifest/);
  assert.doesNotMatch(server, /related_applications:[\s\S]{0,240}\/app\/manifest\.webmanifest/);
  assert.match(app, /apps\.some\(\(app\) => app && app\.platform === 'webapp'\)/);
  assert.doesNotMatch(app, /url\.indexOf\('\/app\/manifest'\)/);
  assert.match(html, /app\.js\?v=297/);
});
