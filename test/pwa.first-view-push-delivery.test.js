'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('legacy standard images resolve ownerName into the owning account for PWA Push', () => {
  const owner = server.match(/function shareOwnerAccount\(s\) \{[\s\S]*?\n\}/);
  assert.ok(owner, 'shareOwnerAccount must exist');
  assert.match(owner[0], /findAccountByName\(s\.ownerName\)/, 'legacy ownerName must resolve to an account');
  assert.match(owner[0], /s\.ownerId = account\.id/, 'legacy records must self-heal durable ownerId');
  const keys = server.match(/function ownerKeysForShare\(s\) \{[\s\S]*?return \[\.\.\.new Set\(k\)\];\n\}/);
  assert.ok(keys, 'ownerKeysForShare must exist');
  assert.match(keys[0], /shareOwnerAccount\(s\)/, 'Push routing must use the same legacy owner resolver');
  assert.match(keys[0], /pwaDeviceCreatorAccount\(device\)/, 'same-account PWA devices must be included');
});

test('first-view Push stays pending until a push provider accepts the notification', () => {
  assert.match(server, /s\.firstViewPushPending = \{[\s\S]*?attempts: 0/,
    'the one-shot alert must be persisted before delivery starts');
  assert.match(server, /async function sendPwaPushAwaited\(keys, evt\)/,
    'first-view delivery must have an awaited transport');
  assert.match(server, /sendWebPushAwaited\(/,
    'awaited owner Push must use the same verified transport as the working diagnostic');
  assert.match(server, /if \(result\.accepted > 0 && s\.firstViewPushPending === pending\)/,
    'pending state may only clear after explicit push-service acceptance');
  assert.match(server, /pending\.lastFailure = result\.targeted \? 'push-service-rejected' : 'no-subscription'/,
    'failed sends must remain retryable instead of consuming the one-shot alert');
});

test('re-subscribing flushes pending first-view Push through the awaited delivery path', () => {
  assert.match(server, /async function flushPendingFirstViewPushForKeys\(keys\)/);
  assert.match(server, /jobs\.push\(deliverPendingFirstViewPush\(share\)\)/);
  assert.match(server, /app\.post\('\/app\/push\/subscribe', pwaJsonParser, async \(req, res\) => \{/);
  assert.match(server, /const pendingFlushed = await flushPendingFirstViewPushForKeys\(keys\)/);
});
