'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const app = read('pwa','app.js');
const css = read('pwa','app.css');
const server = read('server.js');

test('offline live snapshots are visibly stale and cannot expose stale stop controls or speed', () => {
  assert.match(app, /feedOffline = !!pwaLiveTransfersError/);
  assert.match(app, /displayBps = feedOffline \? 0/);
  assert.match(app, /tf\.canStop && !feedOffline/);
  assert.match(app, /liveTransfersStale/);
  assert.match(app, /pwaLiveTransferSamples = Object\.create\(null\)/);
  assert.match(css, /\.pwa-live-transfer\.offline\{/);
});

test('live transfer and activity rows keep a non-clipping fallback on narrow layouts', () => {
  assert.match(css, /\.pwa-live-name\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.pwa-live-transfer\{[^}]*width:100%[^}]*max-width:100%/);
  assert.match(css, /\.pwa-live-meta span\{[^}]*word-break:break-word/);
  assert.match(css, /\.server-activity-list\{[^}]*overflow-x:auto/);
  assert.match(css, /@media\(max-width:620px\)[\s\S]*\.server-activity-list\{overflow:visible\}/);
});

test('correlated Activity rendering counts groups in one pass instead of rescanning 1000 rows per group', () => {
  assert.match(app, /correlationCounts=Object\.create\(null\)/);
  assert.match(app, /correlationCounts\[visibleKey\]=\(correlationCounts\[visibleKey\]\|\|0\)\+1/);
  assert.doesNotMatch(app, /rendered\.filter\(function\(x\)\{return String\(x\.correlationId\|\|x\.shareId\|\|''\)===correlation;\}\)\.length/);
});

test('a resumable upload keeps a real stop path after an interrupted chunk', () => {
  assert.match(server, /if \(!failed\) \{ fail\('stopped', false\); return; \}/);
  assert.match(server, /uploadTransfers\.delete\(uploadId\);[\s\S]{0,180}fs\.unlink\(part,[\s\S]{0,180}endTransfer\(transfer, false, 'stopped'\)/);
});
