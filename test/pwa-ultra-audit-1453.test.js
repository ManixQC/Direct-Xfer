'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('pwa/app.js');
const sw = read('pwa/sw.js');
const login = read('pwa/login.js');
const vault = read('pwa/login-vault.js');
const server = read('server.js');

test('PWA has one authoritative timeout helper and preserves caller abort signals', () => {
  assert.equal((app.match(/function fetchWithTimeout\s*\(/g) || []).length, 1);
  assert.match(app, /var upstream = options\.signal \|\| null/);
  assert.match(app, /upstream\.addEventListener\('abort', relayAbort/);
  assert.match(app, /new Promise\(function \(_, reject\) \{ fallbackTimer = setTimeout/);
});

test('device status is coalesced, bounded and startup does not issue the old duplicate request', () => {
  assert.match(app, /var deviceInfo = null, deviceStatusPromise = null/);
  assert.match(app, /if \(deviceStatusPromise\) return deviceStatusPromise/);
  assert.match(app, /fetchWithTimeout\('\/app\/device\/status(?:\?[^']*)?'.*10000\)/s);
  const boot = app.slice(app.indexOf('await Promise.allSettled(['), app.indexOf('maybeAutoResume(); startImageStatsPolling()'));
  assert.match(boot, /settleWithin\(deviceBootstrap, 12000, null\)/);
  assert.doesNotMatch(boot, /\n\s*fetchDeviceStatus\(\),/);
});

test('destination validation is side-effect free and cannot hang forever', () => {
  const block = app.slice(app.indexOf('function validateDest(dest)'), app.indexOf('function showLimits'));
  assert.match(block, /fetchWithTimeout\('\/u\/'/);
  assert.match(block, /upload-status\?id=dxcheck0000&config=1/);
  assert.match(block, /10000/);
  assert.doesNotMatch(block, /fetch\('\/u\/'/);
});

test('IndexedDB and OPFS transient failures are retryable and transactions are bounded', () => {
  assert.match(app, /dbPromise = null;\s*throw error;/);
  assert.match(app, /idb-transaction-timeout/);
  assert.match(app, /idb-read-timeout/);
  assert.match(app, /try \{ tx\.abort\(\); \} catch \(_\) \{\}/);
  assert.match(app, /opfsDirPromise = null;\s*throw error;/);
});

test('share target is crash-safe, retry-safe and cleans legacy orphan batches', () => {
  assert.match(sw, /complete: false/);
  assert.match(sw, /meta\.complete = true/);
  assert.match(sw, /if \(!info\.meta\).*deleteShareBatch/s);
  assert.match(sw, /Corrupt metadata is as unrecoverable as missing metadata/);
  assert.match(sw, /key\.indexOf\('dx-share-'\) === 0/);
  assert.match(app, /dx-pwa-pending-shared-batch/);
  assert.match(app, /meta\.createdAt \|\| Date\.now\(\)/);
  assert.match(app, /same logical File identity and cannot duplicate shared text/);
  assert.match(app, /Share Target recovery must never abort the rest of PWA initialization/);
  const clear = app.slice(app.indexOf('async function clearLocalDataInternal'), app.indexOf('async function clearLocalData()'));
  assert.match(clear, /dx-pwa-pending-shared-batch/);
});

test('authenticated PWA HTML is never cached; offline navigation uses public data-free shell', () => {
  assert.match(server, /app\.get\('\/direct-xfer-pwa-shell\.html'/);
  assert.match(server, /DATA-FREE offline shell/);
  assert.match(sw, /Never cache authenticated \/app\/ HTML/);
  assert.match(sw, /caches\.match\('\/direct-xfer-pwa-shell\.html'\)/);
  assert.doesNotMatch(sw, /cache\.put\(['"]\/app\/['"]/);
});

test('first install does not show a false update and old share caches are migrated away', () => {
  assert.match(sw, /var upgrading = !!self\.registration\.active/);
  assert.match(sw, /if \(!upgrading\) return \[\]/);
  assert.match(sw, /key\.indexOf\('dx-share-'\) === 0/);
});

test('push navigation metadata survives server transport into the service worker', () => {
  assert.match(server, /openCenter: !!\(payload && payload\.openCenter\)/);
  assert.match(server, /panel: payload && payload\.panel/);
  assert.match(server, /openCenter: !!evt\.openCenter, panel: evt\.panel/);
  assert.match(server, /openCenter: true,\s*panel: 'images'/s);
  assert.match(sw, /openCenter: !!\(data && data\.openCenter\)/);
  assert.match(sw, /panel: \(data && data\.panel\) \|\| ''/);
});

test('large image libraries paginate and lightweight polling cannot abort a full restore', () => {
  assert.match(server, /res\.json\(\{ images, offset, limit, total: inventory\.length, hasMore:/);
  assert.match(server, /pwaImageInventoryForRequest/);
  assert.match(app, /imageFullRefreshInFlight/);
  assert.match(app, /if \(!loadMissing && imageFullRefreshInFlight\) return/);
  assert.match(app, /\/app\/images\?limit=500&offset=0&includeInactive=1/);
  assert.match(app, /while \(payload\.hasMore && pages < 20\)/);
  assert.match(app, /refreshImageStats\(false\)/);
});

test('image inventory and fallback stats requests are bounded and preserve cancellation', () => {
  assert.match(app, /fetchWithTimeout\('\/app\/images\?limit=500&offset=0&includeInactive=1', requestOptions, 15000\)/);
  assert.match(app, /fetchWithTimeout\('\/app\/image\/'[\s\S]*?\/stats'[\s\S]*?10000\)/);
  assert.match(app, /var upstream = options\.signal \|\| null/);
});

test('mobile login and password vault cannot hang indefinitely', () => {
  assert.match(login, /function fetchWithTimeout\(/);
  assert.match(login, /fetchWithTimeout\('\/app\/login'/);
  assert.match(login, /15000\)/);
  assert.match(login, /settleWithin\(persistRememberedLogin[\s\S]*?1800\)/);
  assert.match(vault, /Login vault open timed out/);
  assert.match(vault, /Login vault transaction timed out/);
});

test('sync XHR send failures use normal retry cleanup instead of leaving an active ghost transfer', () => {
  assert.match(app, /try \{ xhr\.send\(blob\.slice\(offset, end\)\); \}\s*catch \(_\) \{ finish\(\{ retry: true/);
});

test('notification rule mutations are serialized and failed adds keep the user input', () => {
  assert.match(app, /notificationRuleMutationBusy=false/);
  assert.match(app, /if\(notificationRuleMutationBusy\)return false/);
  assert.match(app, /if\(saved\)\{if\(\$\('settings-notification-rule-threshold'\)\)/);
});
