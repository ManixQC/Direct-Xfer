'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('standard-admin image alerts target PWA devices delegated by the same account', () => {
  const ownerKeys = server.match(/function ownerKeysForShare\(s\) \{[\s\S]*?\n\}/);
  assert.ok(ownerKeys, 'ownerKeysForShare must exist');
  assert.match(ownerKeys[0], /pwaDevices\(\)/, 'account-owned shares must enumerate paired PWA devices');
  assert.match(ownerKeys[0], /pwaDeviceCreatorAccount\(device\)/, 'paired devices must resolve their delegating account');
  assert.match(ownerKeys[0], /String\(creator\.id\) === accountId/, 'only devices paired by the owning account may receive the event');
  assert.match(ownerKeys[0], /device\.sessionLockedAt/, 'locked PWA devices must not receive owner push notifications');
  assert.match(ownerKeys[0], /new Set\(k\)/, 'owner keys should be deduplicated when a PWA-created image has both account and device ownership');
});

test('first-view push preference repairs browser/server subscriptions and provisions push when enabled', () => {
  assert.match(pwa, /async function syncPushSubscription\(\) \{ return registerPushSubscription\(false, false\); \}/);
  assert.match(pwa, /Push subscriptions are bound to the VAPID\/application server public key/);
  assert.match(pwa, /pushApplicationKeyMatches\(sub, serverKey\)/);
  assert.match(pwa, /if \(\$\('live-push'\) && \$\('live-push'\)\.checked\) \{\s*syncPushSubscription\(\)/);
  assert.match(pwa, /id === 'img-notify-first-view'[\s\S]*enablePush\(false\)\.then/,
    'enabling first-view notifications should also provision closed-app push');
});
