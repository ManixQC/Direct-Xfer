'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const manifests = ['manifest.webmanifest', 'manifest-en.webmanifest', 'manifest-es.webmanifest']
  .map((name) => JSON.parse(fs.readFileSync(path.join(root, 'pwa', name), 'utf8')));

test('1. header exposes a live online/offline connection indicator', () => {
  assert.match(html, /id="network-pill"[^>]*role="status"/);
  assert.match(js, /function updateNetworkIndicator\(\)/);
  assert.match(js, /window\.addEventListener\('online',[\s\S]*?updateNetworkIndicator\(\)/);
  assert.match(css, /\.network-pill\.offline/);
});

test('2. the most recent locally available batch can be restored', () => {
  assert.match(html, /id="last-batch-btn"/);
  assert.match(js, /metaSet\('lastBatch'/);
  assert.match(js, /async function resendLastBatch\(\)/);
  assert.match(js, /lastBatchRestored/);
});

test('3. transfer summaries can be copied', () => {
  assert.match(html, /id="copy-summary-btn"/);
  assert.match(js, /function summaryText\(summary\)/);
  assert.match(js, /function copyLastSummary\(\)/);
});

test('4. privacy mode masks sensitive file names in queue and history', () => {
  assert.match(html, /id="privacy-names"/);
  assert.match(js, /function displayFileName\(it, index\)/);
  assert.match(js, /privacyNames \? privateFileName\(historyIndex\) : h\.name/);
});

test('5. sender names are stored per destination', () => {
  assert.match(js, /dx-pwa-sender-by-destination/);
  assert.match(js, /map\[currentDest\.token\]/);
  assert.match(js, /function saveSenderForCurrent\(\)/);
});

test('6. touch rows support swipe actions', () => {
  assert.match(js, /function attachSwipeGestures\(row, it\)/);
  assert.match(js, /if \(dx < 0\) removeItem\(it, true\)/);
  assert.match(js, /else toggleItemPaused\(it\)/);
  assert.match(css, /\.uprow\.swiping/);
});

test('7. installed-app shortcuts include files and camera but not document scanning', () => {
  manifests.forEach((manifest) => {
    const urls = new Set((manifest.shortcuts || []).map((shortcut) => shortcut.url));
    assert.ok(urls.has('/app/?action=camera'));
    assert.ok(urls.has('/app/?action=files'));
    // "Scan a document" only reopened the camera with no scanning UI, so it was
    // removed from the shortcuts and the launch-action handler alike.
    assert.ok(!urls.has('/app/?action=scan'));
  });
  assert.doesNotMatch(js, /launchAction === 'scan'/);
});

test('8. app badge reflects queued and failed items even while idle', () => {
  assert.match(js, /function updateAppBadge\(\)/);
  assert.match(js, /navigator\.setAppBadge\(pending\)/);
  assert.match(js, /updateFilesCount\(\);[\s\S]{0,120}updateResultActions\(\); updateAppBadge\(\)/);
});

test('9. large cellular uploads request confirmation', () => {
  assert.match(html, /id="confirm-mobile-data"[^>]*checked/);
  assert.match(js, /function confirmMobileDataIfNeeded\(candidates\)/);
  assert.match(js, /10 \* 1024 \* 1024/);
  assert.match(js, /if \(!confirmMobileDataIfNeeded\(candidates\)\) return/);
});

test('10. completed transfer result uses the native share sheet when available', () => {
  assert.match(html, /id="share-result-btn"/);
  assert.match(js, /async function shareLastSummary\(\)/);
  assert.match(js, /navigator\.share\(\{ title: 'Direct-Xfer', text: text \}\)/);
});

test('11. local preview supports images, video, audio, PDF and text', () => {
  assert.match(html, /id="preview-video"/);
  assert.match(html, /id="preview-audio"/);
  assert.match(html, /id="preview-frame"/);
  assert.match(html, /id="preview-text"/);
  assert.match(js, /async function openPreview\(it\)/);
  assert.match(js, /type === 'application\/pdf'/);
  assert.match(server, /frame-src 'self' blob:/);
});

test('12. queued images can be rotated and center-cropped to common ratios', () => {
  assert.match(js, /async function rotateItem\(it\)/);
  assert.match(js, /function cropAnnotate\(ratio\)/);
  assert.match(html, /id="ann-crop-square"/);
  assert.match(html, /id="ann-crop-43"/);
  assert.match(html, /id="ann-crop-169"/);
});

test('13. photo optimization has original, high, messaging and data-saver presets', () => {
  assert.match(html, /id="optimize-preset"/);
  for (const value of ['original', 'high', 'message', 'saver']) assert.match(html, new RegExp(`value="${value}"`));
  assert.match(js, /function applyOptimizationPreset\(value, persist\)/);
});

test('14. selected files support numbered bulk rename', () => {
  assert.match(html, /id="bulk-rename-btn"/);
  assert.match(js, /function bulkRename\(\)/);
  assert.match(js, /prefix \+ '-' \+ num/);
});

test('15. queue order can be changed by drag or mobile arrow controls', () => {
  assert.match(js, /function reorderQueue\(fromId, toId\)/);
  assert.match(js, /function moveQueueItem\(id, delta\)/);
  assert.match(js, /row\.addEventListener\('dragstart'/);
  assert.match(css, /\.icon-action\.move \{ display: inline-flex; \}/);
});
