'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

test('read reconciliation invalidates stale GETs in standard and PWA clients',()=>{
  const std=read('public/app.js'), pwa=read('pwa/app.js'), server=read('server.js');
  assert.match(server,/const existingIds = notifications\.map\(\(n\) => String\(n\.id\)\)/);
  assert.match(server,/const ids = notifications\.filter\(\(n\) => !n\.unread\)/);
  assert.match(std,/function invalidateNotificationsFetch\(\)/);
  assert.match(std,/invalidateNotificationsFetch\(\);[\s\S]{0,500}existingIds/);
  assert.match(pwa,/function invalidatePwaNotificationFetch\(\)/);
  assert.match(pwa,/invalidatePwaNotificationFetch\(\);[\s\S]{0,500}existingIds/);
});

test('read completion still clears the local badge after the panel is quickly closed',()=>{
  const std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(std,/if \(readSeq !== notificationsReadSeq\) return;/);
  assert.doesNotMatch(std,/readSeq !== notificationsReadSeq \|\| !notificationsMenuIsOpen/);
  assert.match(pwa,/if\(readSeq!==notificationReadSeq\)return;/);
  assert.doesNotMatch(pwa,/readSeq!==notificationReadSeq\|\|!pwaNotificationsOpen/);
});

test('localized category and severity labels participate in full-text search',()=>{
  const std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(std,/function notificationCategorySearchLabel\(category\)/);
  assert.match(std,/function notificationSeveritySearchLabel\(severity\)/);
  assert.match(std,/notificationCategorySearchLabel\(n && n\.category\)/);
  assert.match(std,/notificationSeveritySearchLabel\(n && n\.severity\)/);
  assert.match(pwa,/function pwaNotificationCategorySearchLabel\(category\)/);
  assert.match(pwa,/function pwaNotificationSeveritySearchLabel\(severity\)/);
  assert.match(pwa,/pwaNotificationCategorySearchLabel\(n&&n\.category\)/);
  assert.match(pwa,/pwaNotificationSeveritySearchLabel\(n&&n\.severity\)/);
});

test('standard logout resets notification filters and search between accounts',()=>{
  const std=read('public/app.js');
  const block=/function showLogin\(\) \{[\s\S]*?function showApp\(\)/.exec(std)?.[0]||'';
  assert.match(block,/notifications-category-filter/);
  assert.match(block,/notifications-severity-filter/);
  assert.match(block,/notifications-search/);
  assert.match(block,/categoryFilter\.value = ''/);
  assert.match(block,/severityFilter\.value = ''/);
  assert.match(block,/searchFilter\.value = ''/);
});

test('PWA Push notifications show their device metadata when title does not contain it',()=>{
  const pwa=read('pwa/app.js');
  assert.match(pwa,/if\(n\.device&&pwaNotificationTitle\(n\)\.indexOf\(String\(n\.device\)\)===-1\)parts\.push\(n\.device\)/);
});

test('Spanish generic notification link name is localized in both clients',()=>{
  assert.match(read('public/app.js'),/state\.lang==='es'\?'Enlace':'Link'/);
  assert.match(read('pwa/app.js'),/lang==='es'\?'Enlace':'Link'/);
});
