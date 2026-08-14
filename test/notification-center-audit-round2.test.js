'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT,p),'utf8');

test('notification dedupe survives visible deletion and is bounded per account', () => {
  const s = read('server.js');
  assert.match(s, /NOTIFICATION_DEDUPE_MAX_PER_ACCOUNT\s*=\s*5000/);
  assert.match(s, /function notificationDedupeStore\(\)/);
  assert.match(s, /function notificationDedupeSeen\(accountId, dedupeKey, now, windowMs\)/);
  assert.match(s, /state\.meta\.notificationDedupe/);
  assert.match(s, /notificationDedupeSeen\(accountId, dedupeKey, now, dedupeWindowMs\)/);
  assert.match(s, /dedupeWindowMs,\s*\n\s*\};/);
});

test('request-scoped notification routing never falls back to every admin', () => {
  const s = read('server.js');
  const start = s.indexOf('function notificationAccountIdsForRequest(req)');
  const end = s.indexOf('function publicNotification', start);
  const fn = s.slice(start,end);
  assert.ok(start >= 0);
  assert.match(fn, /if \(dev\)[\s\S]*return acc && acc\.id \? \[String\(acc\.id\)\] : \[\]/);
  assert.match(fn, /if \(sess && sess\.accountId\) return \[String\(sess\.accountId\)\]/);
  assert.doesNotMatch(fn, /notificationAdminAccountIds\(\)/);
});

test('DLP dedupe keys do not persist raw client IPs', () => {
  const s = read('server.js');
  assert.match(s, /dlp-detected:[^\n]*maskIp\(clientIp\(req\)\)/);
  assert.match(s, /dlp-blocked:[^\n]*maskIp\(clientIp\(req\)\)/);
  assert.doesNotMatch(s, /dlp-detected:[^\n]*\$\{clientIp\(req\)\}/);
  assert.doesNotMatch(s, /dlp-blocked:[^\n]*\$\{clientIp\(req\)\}/);
});

test('notification GET is explicitly non-cacheable and clients bound slow polling', () => {
  const s = read('server.js'), std = read('public/app.js'), pwa = read('pwa/app.js');
  const route = s.slice(s.indexOf("adminRouter.get('/notifications'"), s.indexOf("adminRouter.delete('/notifications/:id'"));
  assert.match(route, /Cache-Control', 'no-store/);
  assert.match(std, /notificationsRequestInFlight/);
  assert.match(std, /fetchWithTimeout\('\/api\/notifications',[\s\S]{0,220}15000\)/);
  assert.match(std, /cache:'no-store'/);
  assert.match(pwa, /notificationRequestInFlight/);
  assert.match(pwa, /ctrl\.abort\(\);\},15000/);
});

test('expired authentication clears cached notification content', () => {
  const std = read('public/app.js'), pwa = read('pwa/app.js');
  assert.match(std, /res\.status === 401 \|\| res\.status === 403[\s\S]*accountNotifications = \[\][\s\S]*renderNotifications\(\)/);
  assert.match(std, /function showLogin\(\)[\s\S]*accountNotifications = \[\][\s\S]*renderNotifications\(\)/);
  assert.match(pwa, /r\.status===401\|\|r\.status===403\)\{accountNotifications=\[\];renderPwaNotifications\(\);return;\}/);
  assert.match(pwa, /disconnectLive\(\);\s*accountNotifications = \[\];\s*renderPwaNotifications\(\)/);
});

test('activity detectors are periodically pruned and bounded', () => {
  const s = read('server.js');
  assert.match(s, /CENTER_TRACKER_IDLE_MS\s*=\s*60 \* 60 \* 1000/);
  assert.match(s, /CENTER_ACTIVITY_TRACKER_MAX\s*=\s*2000/);
  assert.match(s, /CENTER_REPEAT_TRACKER_MAX\s*=\s*5000/);
  assert.match(s, /function pruneCenterTrackers\(/);
  assert.match(s, /pruneCenterTrackers\(now, true\)/);
  assert.match(s, /tr\.lastSeenAt = now/);
});

test('deleting an account purges its notification records and dedupe ledger', () => {
  const s = read('server.js');
  const start = s.indexOf("adminRouter.delete('/accounts/:id'");
  const end = s.indexOf("adminRouter.get('/security/anomalies'", start);
  const route = s.slice(start,end);
  assert.match(route, /clearNotificationsForAccount\(acc\.id, false\)/);
  assert.match(route, /clearNotificationDedupeForAccount\(acc\.id\)/);
});

test('revoked links do not emit later expiry notifications', () => {
  const s = read('server.js');
  const start = s.indexOf('function checkCenterLinkStates()');
  const end = s.indexOf('function checkCenterSystemHealth()', start);
  const fn = s.slice(start,end);
  assert.match(fn, /if \(!s \|\| s\.revoked\) continue/);
});

test('reception quota notification means the link quota is actually reached', () => {
  const s = read('server.js');
  const start = s.indexOf('function inboxRejectReason(s, name, sizeHint, opts = {})');
  const end = s.indexOf('// HTTP status for each reception rejection reason.', start);
  const fn = s.slice(start,end);
  assert.match(fn, /if \(usedBytes >= Number\(s\.maxTotalBytes\)\) maybeCenterReceptionQuota\(s\)/);
  assert.doesNotMatch(fn, /maxTotalBytes[^\n]*addShareCenterNotification/);
  assert.match(s, /\['quota-full','max-files'\][\s\S]*maybeCenterReceptionQuota\(centerShare\)/);
  assert.doesNotMatch(s, /\['quota-full','max-files','sender-storage-cap','storage-cap'\]/);
});

test('first-view center entry is enriched when asynchronous GeoIP resolves', () => {
  const s = read('server.js');
  assert.match(s, /function enrichFirstViewCenterNotification\(/);
  assert.match(s, /if \(!rec\) return false; \/\/ Respect a user deletion/);
  assert.match(s, /enrichFirstViewCenterNotification\(s, rawIp, resolved\)/);
});
