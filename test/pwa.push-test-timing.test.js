
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('push diagnostic starts Android delivery timeout after push-service acceptance', () => {
  const fn = app.match(/async function testPushNotifications\(\)[\s\S]*?\n  \}\n\n  \/\/ --- ZIP bundling/);
  assert.ok(fn, 'testPushNotifications function should exist');
  const code = fn[0];
  const sendPos = code.indexOf('result = await postPushTest');
  const waitPos = code.indexOf('waitForPushReceipt(testId, 30000)');
  assert.ok(sendPos >= 0 && waitPos > sendPos, 'receipt timeout must begin only after the server sends/accepts the push');
  assert.doesNotMatch(code.slice(0, sendPos), /waitForPushReceipt\(/, 'subscription setup must not consume the Android delivery timeout');
  assert.match(code, /pushTestAccepted/);
});

test('server timestamp crosses the encrypted push payload into the service-worker receipt', () => {
  assert.match(server, /const sentAt = Date\.now\(\);[\s\S]*ts: sentAt/);
  assert.match(server, /res\.json\(\{ ok: true, sent: 1, pushStatus: result\.statusCode, testId, sentAt: result\.sentAt/);
  assert.match(sw, /sentAt: Number\(data\.ts\) \|\| 0/);
  assert.match(sw, /swVersion: VERSION/);
  assert.match(app, /pushDeliveryMs\(receipt, sentAt\)/);
});

test('push delivery window is 30 seconds and release is forced to pwa289/v238', () => {
  assert.match(app, /APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(app, /waitForPushReceipt\(testId, 30000\)/);
  assert.match(sw, /VERSION = '2026\.08\.15-pwa289'/);
  assert.match(sw, /app\.js\?v=273/);
});
