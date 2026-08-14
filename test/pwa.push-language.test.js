'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');

test('PWA exposes and persists a per-device push notification language', () => {
  assert.match(html, /id="push-language"/);
  assert.match(html, /value="fr"[\s\S]*value="en"[\s\S]*value="es"/);
  assert.match(app, /dx-pwa-push-lang/);
  assert.match(app, /language: selectedPushLanguage\(\)/);
  assert.match(app, /push-language'[\s\S]*addEventListener\('change'/);
  assert.match(app, /syncPushSubscription\(\)/);
});

test('server stores push language on the subscription and localizes first-view pushes per endpoint', () => {
  assert.match(server, /lang: normalizePwaPushLang\(req\.body && req\.body\.language\)/);
  assert.match(server, /function localizedPwaPush\(evt, language\)/);
  assert.match(server, /kind === 'image-first-view'/);
  assert.match(server, /Première vue d’image/);
  assert.match(server, /First image view/);
  assert.match(server, /Primera vista de imagen/);
  assert.match(server, /const msg = localizedPwaPush\(evt, sub\.lang\)/);
});

test('push diagnostic itself follows the selected subscription language', () => {
  assert.match(server, /const testMessage = localizedPwaPush\(\{ kind: 'test' \}, sub\.lang\)/);
  assert.match(server, /Test des notifications push/);
  assert.match(server, /Push notification test/);
  assert.match(server, /Prueba de notificaciones push/);
});
