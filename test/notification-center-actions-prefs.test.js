'use strict';
// Coverage for the notification-center additions: clickable rows (1), relative
// time (2), arrival alert + sound (6), category preferences (7), contextual
// actions (9), on-demand paging (12) and the PWA push deep-link (14).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('server gates muted categories and exposes prefs endpoints (feature 7)', () => {
  const s = read('server.js');
  assert.match(s, /const NOTIFICATION_MUTABLE_CATEGORIES = \['images','shares','receptions','transfers','search','pwa','visitors','thresholds','traffic','network','restarts','updates'\]/);
  // Security and System health must never be silenceable; lifecycle/update categories are mutable.
  const arr = /const NOTIFICATION_MUTABLE_CATEGORIES = \[([^\]]*)\]/.exec(s)[1];
  assert.ok(!/security/.test(arr) && !/system_health/.test(arr), 'security/maintenance/system health stay always-on');
  assert.match(arr, /restarts/);
  assert.match(arr, /updates/);
  assert.match(s, /function notificationCategoryMuted\(accountId, category\)/);
  assert.match(s, /function setAccountMutedNotificationCategories\(accountId, list\)/);
  // The mute check runs inside addCenterNotification before the dedupe ledger.
  assert.match(s, /if \(notificationCategoryMuted\(accountId, category\)\) return null;/);
  const add = s.slice(s.indexOf('function addCenterNotification'));
  assert.ok(add.indexOf('notificationCategoryMuted(accountId, category)') < add.indexOf('notificationDedupeSeen'), 'mute check precedes dedupe');
  assert.match(s, /adminRouter\.get\('\/notifications\/prefs'/);
  assert.match(s, /adminRouter\.post\('\/notifications\/prefs'/);
  assert.match(s, /app\.get\('\/app\/notifications\/prefs'/);
  assert.match(s, /app\.post\('\/app\/notifications\/prefs'/);
});

test('server push payload deep-links a first-view push to the center (feature 14)', () => {
  const s = read('server.js');
  assert.match(s, /kind: 'image-first-view'[\s\S]{0,600}openCenter: true/);
  assert.match(s, /openCenter: true,\s*\n\s*panel: 'images'/);
});

test('standard client adds clickable rows, relative time, actions, paging, arrival + prefs', () => {
  const s = read('public/app.js');
  assert.match(s, /function openNotificationTarget\(n\)/);              // 1
  assert.match(s, /main\.classList\.add\('notification-clickable'\)/); // 1
  assert.match(s, /if \(n\.at\) parts\.push\(timeAgo\(n\.at\)\)/);      // 2
  assert.match(s, /metaEl\.setAttribute\('title', formatDate\(n\.at\)\)/); // 2 tooltip
  assert.match(s, /function announceNewNotifications\(fresh\)/);        // 6
  assert.match(s, /localStorage\.getItem\('dx-notif-sound'\)/);         // 6
  assert.match(s, /btn\.classList\.add\('notif-pulse'\)/);              // 6
  assert.match(s, /function notificationActions\(n\)/);                 // 9
  assert.match(s, /const NOTIFICATION_REVOKE_TYPES = \[/);              // 9
  assert.match(s, /const NOTIFICATIONS_PAGE_SIZE = 20/);                // 12
  assert.match(s, /notification-loadmore/);                            // 12
  assert.match(s, /async function loadNotificationPrefs\([^)]*\)/);          // 7
  assert.match(s, /api\('POST','\/api\/notifications\/prefs'/);         // 7
});

test('PWA client mirrors the additions and opens the center on push tap', () => {
  const s = read('pwa/app.js');
  assert.match(s, /function pwaTimeAgo\(ts\)/);                         // 2
  assert.match(s, /if\(n\.at\)parts\.push\(pwaTimeAgo\(n\.at\)\)/);     // 2
  assert.match(s, /function openPwaNotificationTarget\(n\)/);           // 1
  assert.match(s, /notification-clickable/);                           // 1
  assert.match(s, /function pwaNotificationActions\(n\)/);              // 9
  assert.match(s, /pwa-notification-loadmore/);                        // 12
  assert.match(s, /function announcePwaNotifications\(fresh\)/);        // 6
  assert.match(s, /function openPwaNotificationCenter\(panel\)/);       // 14
  assert.match(s, /OPEN_NOTIFICATION_CENTER/);                         // 14
  assert.match(s, /launchOpenCenter/);                                 // 14 cold start
  assert.match(s, /\/app\/notifications\/prefs/);                       // 7
});

test('service worker forwards the center deep-link (feature 14)', () => {
  const sw = read('pwa/sw.js');
  assert.match(sw, /data\.openCenter/);
  assert.match(sw, /OPEN_NOTIFICATION_CENTER/);
  assert.match(sw, /opencenter=1/);
});
