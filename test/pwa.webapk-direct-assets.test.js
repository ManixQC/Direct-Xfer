'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const login = fs.readFileSync(path.join(ROOT, 'pwa', 'login.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'pwa', 'login.html'), 'utf8');

for (const filename of ['manifest.webmanifest', 'manifest-en.webmanifest', 'manifest-es.webmanifest']) {
  test(filename + ' uses a public 200 launch URL inside the PWA scope', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pwa', filename), 'utf8'));
    assert.equal(manifest.start_url, '/app/launch');
    assert.equal(manifest.scope, '/app/');
  });
}

test('manifest and service worker use direct root aliases instead of protected /app asset URLs', () => {
  // Derive the cache-busting version from the app shell, then require every reference
  // to use the SAME value — instead of a hardcoded literal that goes stale on each release.
  const vMatch = appHtml.match(/href="\/direct-xfer-pwa\.webmanifest\?v=(\d+)"/);
  assert.ok(vMatch, 'app shell must reference the versioned manifest alias');
  const v = vMatch[1];
  assert.match(loginHtml, new RegExp('href="/direct-xfer-pwa\\.webmanifest\\?v=' + v + '"'));
  assert.match(app, new RegExp("register\\('/direct-xfer-pwa-sw\\.js\\?v=" + v + "', \\{ scope: '/app/' \\}\\)"));
  assert.match(login, new RegExp("register\\('/direct-xfer-pwa-sw\\.js\\?v=" + v + "', \\{ scope: '/app/' \\}\\)"));
  assert.match(server, /app\.get\('\/direct-xfer-pwa-sw\.js'/);
  assert.match(server, /Service-Worker-Allowed', '\/app\/'/);
  assert.match(server, /application\/manifest\+json/);
});

test('public launch shell and direct install assets are precached without authentication redirects', () => {
  assert.match(server, /'\/launch'/);
  assert.match(sw, /'\/app\/launch'/);
  assert.match(sw, /'\/direct-xfer-pwa\.webmanifest'/);
  // The SW cache VERSION must equal the app build tag (kept in lock-step), whatever it is.
  const build = app.match(/APP_BUILD = '([^']+)'/)[1];
  assert.match(sw, new RegExp("var VERSION = '" + build.replace(/\./g, '\\.') + "'"));
});
