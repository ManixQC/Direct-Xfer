'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const login = fs.readFileSync(path.join(ROOT, 'pwa', 'login.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'pwa', 'login.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

for (const filename of ['manifest.webmanifest', 'manifest-en.webmanifest', 'manifest-es.webmanifest']) {
  test(filename + ' explicitly allows browser installation', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pwa', filename), 'utf8'));
    assert.equal(manifest.prefer_related_applications, false);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/app/launch');
    assert.equal(manifest.scope, '/app/');
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.type === 'image/png'));
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.type === 'image/png'));
  });
}

test('Android keeps a useful install logo visible while beforeinstallprompt is pending', () => {
  assert.match(app, /window\.addEventListener\('beforeinstallprompt'/);
  assert.match(app, /var mobileInstallEntry = secureOrigin/);
  assert.match(app, /nativePromptReady \|\| iosInstallFlow \|\| mobileInstallEntry/);
  assert.match(app, /await promptEvent\.prompt\(\)/);
  assert.doesNotMatch(app, /ouvrez le menu du navigateur, puis choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil »/);
  assert.match(app, /Android ne peut créer qu’un raccourci/);
});

test('HTTP users receive an explicit trusted-HTTPS diagnosis on both mobile pages', () => {
  assert.match(appHtml, /id="install-diagnostic"/);
  assert.match(loginHtml, /id="mobile-install-warning"/);
  assert.match(app, /location\.protocol === 'https:'/);
  assert.match(login, /location\.protocol === 'https:'/);
  assert.match(app, /fetch\('\/app\/install-info'/);
  assert.match(login, /fetch\('\/app\/install-info'/);
});

test('server exposes only a safe HTTPS install destination derived from PUBLIC_URL', () => {
  assert.match(server, /function pwaHttpsInstallUrl\(\)/);
  assert.match(server, /normalizedOrigin\(PUBLIC_URL\)/);
  assert.match(server, /origin\.startsWith\('https:\/\/'\)/);
  assert.match(server, /app\.get\('\/app\/install-info', pwaNetworkGuard/);
  assert.match(server, /requiresTrustedHttps: true/);
});
