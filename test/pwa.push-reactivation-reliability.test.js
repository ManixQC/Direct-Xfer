'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');

test('manual Push OFF -> ON force-renews the Android browser subscription', () => {
  assert.match(app, /async function enablePush\(forceRenew\)/);
  assert.match(app, /var ok = await enablePush\(true\)/);
  assert.match(app, /forceRenew \|\| !pushApplicationKeyMatches\(sub, serverKey\)/);
  assert.match(app, /await retireBrowserPushSubscription\(sub\)/);
  assert.match(app, /localStorage\.setItem\('dx-pwa-push', '0'\)/);
});

test('first-view push is retained while no subscription exists and flushed on re-subscribe', () => {
  assert.match(server, /s\.firstViewPushPending = \{/);
  assert.match(server, /async function flushPendingFirstViewPushForKeys\(keys\)/);
  assert.match(server, /share\.firstViewPushPending/);
  assert.match(server, /const pendingFlushed = await flushPendingFirstViewPushForKeys\(keys\)/);
  assert.match(server, /res\.json\(\{ ok: true, pendingFlushed \}\)/);
});

test('Push diagnostic distinguishes vendor acceptance from real service-worker delivery', () => {
  assert.match(app, /waitForPushReceipt\(testId, 30000\)/);
  assert.match(app, /postPushTest\(current\.sub\.endpoint, testId\)/);
  assert.match(app, /pushTestAcceptedDelayed/);
  assert.match(app, /pushTestDelivered/);
  assert.match(sw, /type: 'PUSH_RECEIVED'/);
  assert.match(sw, /testId: data\.testId/);
  assert.match(sw, /sentAt: Number\(data\.ts\)/);
  assert.match(sw, /swVersion: VERSION/);
  assert.match(server, /sentAt: result\.sentAt/);
  assert.match(server, /testId: payload && payload\.testId/);
  assert.match(server, /\{ url: '\/app\/#settings', testId \}/);
});

test('reliability fix is forced onto installed PWAs', () => {
  assert.match(app, /APP_BUILD = '2026\.08\.14-pwa281'/);
  assert.match(html, /app\.js\?v=267/);
  assert.match(sw, /pwa281/);
  assert.match(sw, /app\.js\?v=267/);
});
