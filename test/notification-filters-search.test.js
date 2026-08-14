'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('standard notification center has category/severity filters and full-text search', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const css = read('public/style.css');
  assert.match(html, /id="notifications-category-filter"/);
  assert.match(html, /id="notifications-severity-filter"/);
  assert.match(html, /id="notifications-search"[^>]+type="search"/);
  assert.match(app, /function notificationMatchesFilters\(n\)/);
  assert.match(app, /rows\.filter\(notificationMatchesFilters\)/);
  assert.match(app, /normalizeNotificationSearch/);
  assert.match(app, /notificationTitleText\(n \|\| \{\}\)/);
  assert.match(app, /notificationMetaText\(n \|\| \{\}\)/);
  assert.match(app, /notifications\.filteredCount/);
  assert.match(app, /notifications\.noMatch/);
  assert.match(css, /\.notification-filters\s*\{/);
  assert.match(css, /\.notification-search\s*\{/);
});

test('PWA notification center has equivalent filters/search and keeps unread badge based on all rows', () => {
  const html = read('pwa/index.html');
  const app = read('pwa/app.js');
  const css = read('pwa/app.css');
  assert.match(html, /id="pwa-notifications-category-filter"/);
  assert.match(html, /id="pwa-notifications-severity-filter"/);
  assert.match(html, /id="pwa-notifications-search"[^>]+type="search"/);
  assert.match(app, /function pwaNotificationMatchesFilters\(n\)/);
  assert.match(app, /rows\.filter\(pwaNotificationMatchesFilters\)/);
  assert.match(app, /var unreadCount=rows\.reduce/);
  assert.doesNotMatch(app, /var unreadCount=visibleRows\.reduce/);
  assert.match(app, /notificationsFilteredCount/);
  assert.match(app, /notificationsNoMatch/);
  assert.match(css, /\.pwa-notification-filters\s*\{/);
  assert.match(css, /\.pwa-notification-search\s*\{/);
});

test('PWA cache is bumped for notification filter UI', () => {
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa281'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa281'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=267/);
});
