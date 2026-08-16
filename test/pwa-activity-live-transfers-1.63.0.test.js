'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const html = read('pwa', 'index.html');
const app = read('pwa', 'app.js');
const css = read('pwa', 'app.css');
const server = read('server.js');
const sw = read('pwa', 'sw.js');

test('PWA Activity contains a dedicated accessible live transfers section', () => {
  assert.match(html, /id="pwa-live-transfers-title"/);
  assert.match(html, /id="pwa-live-transfers-list"/);
  assert.match(html, /data-i18n="liveTransfersTitle"/);
  assert.match(css, /\.pwa-live-transfer\{/);
  assert.match(css, /\.pwa-live-progress/);
  assert.match(app, /setAttribute\('role','progressbar'\)/);
  assert.match(app, /aria-valuenow/);
  assert.match(html, /id="pwa-live-transfers-list"[^>]*aria-live="off"/);
  assert.match(app, /focusedTransferId/);
  assert.match(app, /restored\.focus/);
});

test('PWA polls live transfers every five seconds only in Activity, times out hung requests and cancels stale work', () => {
  assert.match(app, /fetchWithTimeout\('\/app\/activity\/transfers'/);
  assert.match(app, /PWA_LIVE_TRANSFERS_POLL_MS\s*=\s*5000/);
  assert.match(app, /pwaLiveTransfersTimer = setInterval[\s\S]*activePwaPanel === 'activity'[\s\S]*PWA_LIVE_TRANSFERS_POLL_MS\);/);
  assert.match(app, /loadPwaLiveTransfers\(false\)[\s\S]*startPwaActivityRefresh\(\)/);
  assert.match(app, /document\.visibilityState !== 'hidden'/);
  assert.match(app, /pwaLiveTransfersRequestSeq/);
  assert.match(app, /pwaLiveTransfersRequestController/);
  assert.match(app, /cancelPwaLiveTransferLoad\(\)/);
  assert.match(app, /7000\)/);
});

test('PWA live rows use sampled speed, resume/stall/stopping states, country and safe stop control', () => {
  for (const token of ['expectedBytes','zipTotalBytes','zipProcessedBytes','avgBps','liveBps','liveZipBps','durationMs','stalled','resumed','stopping','ipName','country','canStop']) assert.ok(app.includes(token), `missing ${token}`);
  assert.match(app, /samplePwaLiveTransfers/);
  assert.match(app, /\(bytes - prev\.bytes\) \/ elapsed/);
  assert.match(app, /fmtEta\(\(total - done\) \/ etaBps\)/);
  assert.match(app, /appMutate\('\/app\/activity\/transfers\/' \+ encodeURIComponent\(tf\.id\) \+ '\/stop'[\s\S]*timeoutMs:8000/);
  assert.match(app, /liveTransfersStopConfirm/);
  assert.match(css, /live-dot\.offline/);
});

test('server scopes visibility, only exposes a stop when abort is real, and makes stop/end idempotent', () => {
  assert.match(server, /function pwaCanSeeActiveTransfer\(req, transfer\)/);
  assert.match(server, /pwaViewerIsAdmin\(req\)/);
  assert.match(server, /canManagePwaImage\(req, share\)/);
  assert.match(server, /session\.role === 'auditor'/);
  assert.match(server, /typeof transfer\.abort === 'function'/);
  assert.match(server, /function requestActiveTransferStop\(t\)/);
  assert.match(server, /if \(t\.stopRequested\) return \{ ok:true, stopping:true, alreadyRequested:true \}/);
  assert.match(server, /if \(!t \|\| t\.ended\) return;/);
  assert.match(server, /app\.get\('\/app\/activity\/transfers'/);
  assert.match(server, /app\.post\('\/app\/activity\/transfers\/:id\/stop'/);
  assert.match(server, /pwaAuditReq\(req, 'transfer-stopped'/);
});

test('managed resume fragments participate in live telemetry without polluting transfer history', () => {
  assert.match(server, /transient: !!meta\.transient/);
  assert.match(server, /resumed:!!managedSession && \(managedBaselineBytes > 0 \|\| start > 0\)/);
  assert.match(server, /transient:!!managedSession/);
  assert.match(server, /managedSession \? total : end - start \+ 1/);
  assert.match(server, /transfer\.progressBytes = managedBaselineBytes/);
  assert.match(server, /downloadRangesCoveredBytes/);
  assert.match(server, /if \(t\.transient\) return;/);
});

test('PWA cache generation advances so installed apps receive the audited feature', () => {
  assert.match(app, /APP_VERSION = '1\.63\.4'/);
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(html, /app\.css\?v=280/);
  assert.match(html, /app\.js\?v=297/);
  assert.match(sw, /app\.css\?v=280/);
  assert.match(sw, /app\.js\?v=297/);
});
