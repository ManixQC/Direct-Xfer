'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('16. detailed error center groups failures by category', () => {
  assert.match(html, /id="error-center"/);
  assert.match(html, /id="error-center-list"/);
  assert.match(js, /function errorCategory\(code, badge, hint\)/);
  for (const category of ['proxy', 'quota', 'network', 'server', 'auth', 'file', 'other']) {
    assert.match(js, new RegExp(`['"]${category}['"]`));
  }
  assert.match(js, /function recordTransferError\(it, detail\)/);
  assert.match(js, /dx-pwa-error-log/);
  assert.match(css, /\.error-center-row/);
});

test('error center exposes retry, copy-report and clear-log actions', () => {
  assert.match(html, /id="error-center-retry-all"/);
  assert.match(html, /id="error-center-copy"/);
  assert.match(html, /id="error-center-clear"/);
  assert.match(js, /function copyErrorReport\(\)/);
  assert.match(js, /function clearErrorLog\(\)/);
  assert.match(js, /retryItem\(item\)/);
});

test('17. large transfers automatically run a bounded local network test', () => {
  assert.match(js, /LARGE_TRANSFER_TEST_BYTES = 100 \* 1024 \* 1024/);
  assert.match(js, /async function maybeTestNetworkForLargeTransfer\(candidates\)/);
  assert.match(js, /await maybeTestNetworkForLargeTransfer\(candidates\)/);
  assert.match(js, /async function runNetworkTest\(options\)/);
  assert.match(js, /\/app\/network-test\?bytes=/);
  assert.match(js, /method: 'POST'[\s\S]{0,180}appMutationHeaders\('application\/octet-stream'\)/);
});

test('network probe endpoint is authenticated, bounded and file-independent', () => {
  const guardPos = server.indexOf("app.use('/app', pwaNetworkGuard, requireAppAuth)");
  const routePos = server.indexOf("app.get('/app/network-test'");
  assert.ok(guardPos >= 0 && routePos > guardPos, 'network test route must be behind /app authentication middleware');
  assert.match(server, /pwaNetworkTestParser = express\.raw\(\{ type: 'application\/octet-stream', limit: '2mb' \}\)/);
  assert.match(server, /Math\.min\(pwaNetworkTestPayload\.length/);
  assert.match(server, /Buffer\.isBuffer\(req\.body\) \? req\.body\.length : 0/);
});

test('network test recommendations tune chunk ceiling and concurrency', () => {
  assert.match(js, /function applyNetworkRecommendation\(result\)/);
  assert.match(js, /networkRecommendedChunk/);
  assert.match(js, /networkRecommendedConcurrency/);
  assert.match(js, /it\.chunkCeil = Math\.max\(MIN_CHUNK, networkRecommendedChunk\)/);
  assert.match(js, /concurrency = Math\.min\(concurrency, networkRecommendedConcurrency\)/);
});

test('20. live network dashboard shows metrics and throughput chart', () => {
  assert.match(html, /id="network-dashboard"/);
  for (const id of ['net-latency', 'net-upload', 'net-download', 'net-live-rate', 'net-chunk', 'net-parallel', 'net-retries', 'net-active']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="network-rate-chart"/);
  assert.match(js, /function renderNetworkDashboard\(\)/);
  assert.match(js, /function drawNetworkGraph\(\)/);
  assert.match(js, /function recordNetworkRate\(rate\)/);
  assert.match(css, /\.network-metrics/);
  assert.match(css, /\.network-rate-chart/);
});

test('network dashboard tracks retries and active upload requests', () => {
  assert.match(js, /failures\+\+; networkRetryCount\+\+/);
  assert.match(js, /networkActiveTransfers\+\+/);
  assert.match(js, /networkActiveTransfers = Math\.max\(0, networkActiveTransfers - 1\)/);
  assert.match(js, /networkConfiguredConcurrency = concurrency/);
});
