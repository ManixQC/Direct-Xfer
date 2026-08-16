'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const pub = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractedQueueMerge() {
  const start = pwa.indexOf('function queueRecordFreshness');
  const end = pwa.indexOf('function markSessionOnly', start);
  assert.ok(start >= 0 && end > start);
  return new Function(`${pwa.slice(start, end)}; return { mergeQueueRecords };`)();
}

test('PWA queue recovery chooses the freshest checkpoint rather than blindly preferring IndexedDB', () => {
  const { mergeQueueRecords } = extractedQueueMerge();
  const primary = [{ id:'x', lastCheckpointAt:100, sentBytes:900, note:'stale-idb' }];
  const backup = [{ id:'x', lastCheckpointAt:200, sentBytes:500, note:'fresh-local' }];
  assert.equal(mergeQueueRecords(primary, backup)[0].note, 'fresh-local');
  const tied = mergeQueueRecords([{ id:'y', lastCheckpointAt:300, sentBytes:10 }], [{ id:'y', lastCheckpointAt:300, sentBytes:20 }]);
  assert.equal(tied[0].sentBytes, 20);
  assert.match(pwa, /backgroundFailedAt: Math\.max/);
  assert.match(pwa, /backgroundCompletedAt: Math\.max/);
  assert.match(pwa, /checkpointActiveTransfers[\s\S]*persistItem\(it, false\)/);
});

test('Background Sync diagnostic keeps durable completion/failure timestamps after foreground import', () => {
  assert.match(pwa, /historyEntries[\s\S]*entry&&entry\.background/);
  assert.match(pwa, /backgroundResponse: record\.backgroundResponse/);
  assert.match(pwa, /lastFail=Number\(it\.backgroundFailedAt\)/);
});

test('long-operation UI is concurrency-safe and cleanup is guaranteed on thrown preparation/hash errors', () => {
  assert.match(pwa, /longOperations = new Map\(\)/);
  assert.match(pwa, /longOperations\.delete\(token\); renderLongOperation\(\)/);
  const prep = pwa.slice(pwa.indexOf('async function prepareUpload'), pwa.indexOf('function persistErrorLog'));
  assert.match(prep, /finally \{ endLongOperation\(longOp\); \}/);
  const dedup = pwa.slice(pwa.indexOf('async function tryServerDedup'), pwa.indexOf('async function sendItem', pwa.indexOf('async function tryServerDedup')));
  assert.match(dedup, /finally \{ endLongOperation\(hashOp\); \}/);
});

test('per-device passkey revocation rolls back memory if persistence fails', () => {
  assert.match(server, /const passkeysBefore = JSON\.parse\(JSON\.stringify\(accountPasskeys\(acc\)\)\)/);
  assert.match(server, /if \(!persistNow\(\)\) \{ acc\.passkeys = passkeysBefore; return res\.status\(503\)/);
  assert.match(pwa, /passkeyDeviceRemoved/);
});

test('adaptive low-priority routine events suppress Web Push while preserving other delivery channels', () => {
  assert.match(server, /suppressWebPush:!!\(primaryCenterNotification && primaryCenterNotification\.priority === 'low'\)/);
  assert.match(server, /if \(webPushActive\(\) && !opts\.suppressWebPush\)/);
  assert.match(server, /aggregated: true[\s\S]*suppressWebPush/);
});

test('notification deep-links are consumed once and correlated activity is chronological inside each thread', () => {
  assert.match(pub, /function consumeFocusQueryParam/);
  assert.match(pub, /consumeFocusQueryParam\('focusShare'\)/);
  assert.match(pub, /consumeFocusQueryParam\('image'\)/);
  assert.match(pub, /g\.events\.sort\(\(a,b\)=>\(Number\(a\.at\)\|\|0\)-\(Number\(b\.at\)\|\|0\)\)/);
});

test('search highlighting is accent-insensitive and exact nested basenames receive filename rank', () => {
  assert.match(pub, /function normalizedHighlightMap/);
  assert.match(pwa, /function pwaHighlightMap/);
  assert.match(server, /path\.basename\(String\(d\.file \|\| ''\)\)/);
  assert.match(server, /baseNorm===normalized \? 3/);
});

test('trash purge impact measures managed bytes and smart restore preserves a custom display name', () => {
  assert.match(server, /async function trashManagedPurgeMetrics/);
  assert.match(server, /purgeImpact&&r\.purgeImpact\.bytes/);
  assert.doesNotMatch(server, /sh\.hostPath=item\.hostPath; sh\.name=item\.name/);
  assert.match(pub, /impact\.bytes!=null\?impact\.bytes/);
  assert.match(pwa, /imp\.bytes!=null\?imp\.bytes/);
});

test('installed-PWA fallback markers expire instead of surviving an uninstall forever', () => {
  assert.match(pub, /PWA_INSTALL_MARKER_MAX_AGE_MS = 180/);
  assert.match(pub, /now - at <= PWA_INSTALL_MARKER_MAX_AGE_MS/);
  assert.match(server, /PWA_INSTALL_HEARTBEAT_MAX_AGE_MS = 180/);
  assert.match(server, /Date\.now\(\) - seenAt <= PWA_INSTALL_HEARTBEAT_MAX_AGE_MS/);
});
