'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifests = [
  'manifest.webmanifest',
  'manifest-en.webmanifest',
  'manifest-es.webmanifest',
];

const expectedShareLabels = new Map([
  ['manifest.webmanifest', 'Envoyer'],
  ['manifest-en.webmanifest', 'Send'],
  ['manifest-es.webmanifest', 'Enviar'],
]);

test('Android share target uses a concise action label without repeating the app name', () => {
  for (const filename of manifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pwa', filename), 'utf8'));
    assert.equal(manifest.short_name, 'Direct-Xfer');
    assert.equal(manifest.name, expectedShareLabels.get(filename));
    assert.ok(!manifest.name.includes(manifest.short_name));
  }
});

test('Android share target is explicit and image-compatible in every manifest', () => {
  for (const filename of manifests) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pwa', filename), 'utf8'));
    assert.equal(manifest.short_name, 'Direct-Xfer');
    assert.equal(manifest.share_target.action, '/app/share-target');
    assert.equal(manifest.share_target.method, 'POST');
    assert.equal(manifest.share_target.enctype, 'multipart/form-data');
    const files = manifest.share_target.params.files;
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'files');
    const accept = files[0].accept;
    assert.ok(accept.includes('image/jpeg'));
    assert.ok(accept.includes('.jpg'));
    assert.ok(accept.includes('image/png'));
    assert.ok(accept.includes('.png'));
    assert.ok(accept.includes('image/webp'));
    assert.ok(accept.includes('.webp'));
    assert.ok(!accept.includes('*/*'));
    assert.ok(!accept.includes('image/*'));
    assert.ok(!accept.includes('application/*'));
  }
});

test('service worker intercepts the exact Android share target action', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');
  assert.match(sw, /-pwa\d+/);
  assert.match(sw, /request\.method === 'POST'.*url\.pathname === '\/app\/share-target'/s);
  assert.match(sw, /request\.formData\(\)/);
  assert.match(sw, /Response\.redirect\('\/app\/\?shared='/);
});

test('manifest URL is versioned on install and language changes', () => {
  const index = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
  const login = fs.readFileSync(path.join(ROOT, 'pwa', 'login.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
  // Versioned (?v=N) on every reference and consistent across them — not a fixed number.
  const v = index.match(/direct-xfer-pwa\.webmanifest\?v=(\d+)/)[1];
  assert.match(login, new RegExp('direct-xfer-pwa\\.webmanifest\\?v=' + v));
  assert.match(app, new RegExp('direct-xfer-pwa.*webmanifest.*\\?v=' + v, 's'));
});

test('service worker registration starts early and the mobile install entry remains visible while Chrome prepares its prompt', () => {
  const app = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
  const login = fs.readFileSync(path.join(ROOT, 'pwa', 'login.js'), 'utf8');
  assert.match(app, /swReadyForInstall = false/);
  assert.match(app, /var mobileInstallEntry = secureOrigin/);
  assert.match(app, /nativePromptReady \|\| iosInstallFlow \|\| mobileInstallEntry/);
  assert.match(app, /installPullToRefresh\(\); registerServiceWorker\(\);/);
  assert.match(login, /serviceWorker\.register\('\/direct-xfer-pwa-sw\.js\?v=\d+', \{ scope: '\/app\/' \}\)/);
});
