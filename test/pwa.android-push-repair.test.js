'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

test('PWA repairs Android subscriptions tied to a stale VAPID application server key', () => {
  assert.match(app, /sub\.options && sub\.options\.applicationServerKey/);
  assert.match(app, /!pushApplicationKeyMatches\(sub, serverKey\)/);
  assert.match(app, /await retireBrowserPushSubscription\(sub\)/);
  assert.match(app, /pushManager\.subscribe\(\{ userVisibleOnly: true, applicationServerKey: serverKey \}\)/);
});

test('PWA settings expose a real push notification test and retry stale/rejected subscriptions', () => {
  assert.match(html, /id="push-test-btn"/);
  assert.match(html, /id="push-test-status"/);
  assert.match(app, /addEventListener\('click', testPushNotifications\)/);
  assert.match(app, /appMutate\('\/app\/push\/test'/);
  assert.match(app, /stale-subscription'[\s\S]*push-service-rejected/);
  assert.match(app, /registerPushSubscription\(false, true\)/);
});

test('server push diagnostic targets only current PWA subscription and awaits vendor result', () => {
  assert.match(server, /app\.post\('\/app\/push\/test'[\s\S]*ownerKeys = pwaOwnerKeys\(req\)/);
  assert.match(server, /x\.endpoint === endpoint[\s\S]*x\.ownerKeys\.some/);
  assert.match(server, /await sendWebPushAwaited\('test'/);
  assert.match(server, /urgency: 'high'/);
  assert.match(server, /timeout: 15000/);
});

test('push fix is forced onto installed PWAs', () => {
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(html, /app\.js\?v=297/);
  assert.match(sw, /pwa317/);
  assert.match(sw, /app\.js\?v=297/);
});
