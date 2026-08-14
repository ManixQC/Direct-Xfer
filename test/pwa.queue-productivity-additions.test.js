'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

test('clipboard button queues images text and URLs', () => {
  assert.match(html, /id="pick-text"[\s\S]{0,180}data-i18n="clipboardQueue"/);
  assert.match(js, /async function emptyClipboardIntoQueue\(\)/);
  assert.match(js, /navigator\.clipboard\.read\(\)/);
  assert.match(js, /\^image\\\//);
  assert.match(js, /queueRemoteUrl\(text, true\)/);
  assert.match(js, /clipboard-url\.txt/);
});

test('touch and pen queue reordering uses pointer events', () => {
  assert.match(js, /function attachTouchReorderHandle\(/);
  assert.match(js, /window\.PointerEvent/);
  assert.match(js, /document\.elementFromPoint\(/);
  assert.match(js, /reorderQueue\(it\.id, targetId\)/);
  assert.match(css, /\.drag-handle[\s\S]*touch-action:\s*none/);
});

test('queue summary reports count total bytes and sent bytes', () => {
  assert.match(js, /filesTotalSummary/);
  assert.match(js, /function updateFilesCount\(\)/);
  assert.match(js, /var total = live\.reduce/);
  assert.match(js, /var sent = live\.reduce/);
});

test('all live queue names can be copied', () => {
  assert.match(html, /id="copy-queue-names-btn"/);
  assert.match(js, /function copyQueueNames\(\)/);
  assert.match(js, /copyText\(names\.join\('\\n'\)\)/);
});

test('quick queue filters cover requested categories', () => {
  for (const kind of ['all', 'images', 'videos', 'documents', 'waiting', 'done', 'errors']) {
    assert.match(html, new RegExp(`data-queue-kind="${kind}"`));
  }
  assert.match(js, /function queueKindMatches\(it\)/);
  assert.match(js, /queueKindFilter/);
});

test('batch stopwatch shows elapsed and average time per completed file', () => {
  assert.match(js, /function startBatchClock\(\)/);
  assert.match(js, /batchElapsed/);
  assert.match(js, /avgPerFile/);
  assert.match(js, /elapsedSec\s*\/\s*done/);
});

test('leaving is guarded while a transfer can be interrupted', () => {
  assert.match(js, /function hasActiveTransferRisk\(\)/);
  assert.match(js, /addEventListener\('beforeunload'/);
  assert.match(js, /transferActiveExit/);
  assert.match(js, /activeXhrs\.size/);
});

test('completion notifications expose open copy-link and resend actions', () => {
  assert.match(js, /async function showBatchCompletionNotification\(/);
  assert.match(js, /action:\s*'open'/);
  assert.match(js, /action:\s*'copy-link'/);
  assert.match(js, /action:\s*'resend-last'/);
  assert.match(sw, /NOTIFICATION_ACTION/);
  assert.match(sw, /action === 'copy-link'/);
  assert.match(sw, /action === 'resend-last'/);
  assert.match(js, /return restored;/);
  assert.match(js, /startBatch\(restored\)/);
  assert.doesNotMatch(js, /resendLastBatch\(\)\)\.then\(function \(\) \{ if \(!sending\) startBatch\(\)/);
});

test('optimization panel estimates whole-batch reduction before upload', () => {
  assert.match(html, /id="optimization-estimate"/);
  assert.match(js, /function updateOptimizationEstimate\(\)/);
  assert.match(js, /optimizationEstimate/);
  assert.match(js, /saved:\s*fmtBytes\(saved\)/);
  assert.match(js, /pct:/);
  assert.match(js, /fmtEta\(after \/ avgRate\)/);
});

test('low battery guard warns for large or long batches and lowers concurrency', () => {
  assert.match(js, /async function checkBatteryBeforeBatch\(candidates\)/);
  assert.match(js, /navigator\.getBattery\(\)/);
  assert.match(js, /level > 20/);
  assert.match(js, /100 \* 1024 \* 1024/);
  assert.match(js, /bytes \/ avgRate >= 180/);
  assert.match(js, /concurrency-select'\)\.value = '1'/);
});
