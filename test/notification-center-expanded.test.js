const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('notification center declares every requested event family', () => {
  const s = read('server.js');
  const types = [
    'share-first-download','inbox-first-deposit','transfer-complete','transfer-failed','link-expired','link-expiring-soon',
    'download-limit-reached','reception-quota-reached','link-new-visitor','new-country','view-threshold','download-threshold',
    'unusual-activity','repeated-downloads','password-failures','link-auto-disabled','dlp-detected','dlp-blocked',
    'ocr-failed','index-failed','pwa-device-paired','pwa-device-revoked','admin-login','admin-login-unusual',
    'system-problem','update-available','update-installed'
  ];
  for (const type of types) assert.match(s, new RegExp(`['\"]${type}['\"]`), `missing ${type}`);
  assert.match(s, /function addCenterNotification\(/);
  assert.match(s, /function addShareCenterNotification\(/);
  assert.match(s, /function checkCenterLinkStates\(/);
  assert.match(s, /function checkCenterSystemHealth\(/);
});

test('traffic and quota hooks feed the shared center', () => {
  const s = read('server.js');
  assert.match(s, /function incrementDownloads[\s\S]*share-first-download/);
  assert.match(s, /function incrementDownloads[\s\S]*inbox-first-deposit/);
  assert.match(s, /function endTransfer[\s\S]*transfer-complete[\s\S]*transfer-failed/);
  assert.match(s, /function bumpViews[\s\S]*link-new-visitor[\s\S]*noteCenterCountry[\s\S]*maybeCenterViewThreshold/);
  assert.match(s, /function inboxRejectReason[\s\S]*reception-quota-reached/);
  assert.match(s, /noteCenterRepeatedDownload/);
  assert.match(s, /noteCenterActivity/);
});

test('security, DLP, search, device and login hooks feed the shared center', () => {
  const s = read('server.js');
  assert.match(s, /function unlockHandler[\s\S]*password-failures/);
  assert.match(s, /function dlpDecision[\s\S]*dlp-detected[\s\S]*dlp-blocked/);
  assert.match(s, /search-ocr[\s\S]*ocr-failed/);
  assert.match(s, /search-index[\s\S]*index-failed/);
  assert.match(s, /function issuePwaDevice[\s\S]*pwa-device-paired/);
  assert.match(s, /app\.post\('\/app\/device\/revoke'[\s\S]*pwa-device-revoked/);
  assert.match(s, /function attemptLogin[\s\S]*admin-login[\s\S]*admin-login-unusual/);
  assert.match(s, /function checkForUpdate[\s\S]*update-available/);
});

test('standard and PWA render structured notification types and current shell', () => {
  const std = read('public/app.js');
  const pwa = read('pwa/app.js');
  assert.match(std, /function notificationTitleText\(/);
  assert.match(std, /function notificationMetaText\(/);
  assert.match(pwa, /function pwaNotificationTitle\(/);
  assert.match(pwa, /function pwaNotificationMeta\(/);
  assert.match(pwa, /APP_BUILD = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=268/);
});
