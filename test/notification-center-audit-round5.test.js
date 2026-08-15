'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

test('read mutations are scoped to the notifications actually visible/clicked',()=>{
  const server=read('server.js'), std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(server,/function markNotificationsReadForAccount\(accountId, requestedIds, persistAfter = true\)/);
  assert.match(server,/const wanted = Array\.isArray\(requestedIds\)/);
  assert.match(server,/if \(wanted && !wanted\.has\(String\(n\.id\)\)\) continue;/);
  assert.match(server,/markNotificationsReadForAccount\(req\.session\.accountId, req\.body && req\.body\.ids\)/);
  assert.match(server,/markNotificationsReadForAccount\(accountId, req\.body && req\.body\.ids\)/);
  assert.match(std,/function visibleNotificationReadIds\(\)/);
  assert.match(std,/api\('POST','\/api\/notifications\/read', \{ ids:readIds \}\)/);
  assert.match(std,/api\('POST', '\/api\/notifications\/read', \{ ids:\[String\(n\.id\)\] \}\)/);
  assert.match(pwa,/function visiblePwaNotificationReadIds\(\)/);
  assert.match(pwa,/JSON\.stringify\(\{ids:readIds\}\)/);
  assert.match(pwa,/JSON\.stringify\(\{ids:\[String\(n\.id\)\]\}\)/);
});

test('auditors may mutate only their own notification-center housekeeping',()=>{
  const server=read('server.js');
  assert.match(server,/req\.path === '\/notifications\/read'/);
  assert.match(server,/req\.path === '\/notifications\/prefs'/);
  assert.match(server,/req\.method === 'DELETE'/);
  assert.match(server,/return \(isRead \|\| ownNotificationMutation\) \? next\(\) : res\.status\(403\)\.json\(\{ error: 'read-only' \}\);/);
});

test('generic share lifecycle notifications use the managed resource category',()=>{
  const server=read('server.js');
  const fn=/function addShareCenterNotification\(s, type, data = \{\}\) \{[\s\S]*?\n\}/.exec(server)?.[0]||'';
  assert.match(fn,/defaultCategory === 'shares' && s && s\.type === 'inbox'\) payload\.category = 'receptions'/);
  assert.match(fn,/defaultCategory === 'shares' && s && s\.type === 'photo'\) payload\.category = 'images'/);
});

test('PWA notification deep links and copy action use current server-resolved managed URLs',()=>{
  const server=read('server.js'), pwa=read('pwa/app.js'), std=read('public/app.js');
  assert.match(server,/function notificationLinkUrlForRequest\(n, req, accountId\)/);
  assert.match(server,/if \(!share \|\| !isActive\(share\)\) return null;/);
  assert.match(server,/linkUrl:notificationLinkUrlForRequest\(n, req, accountId\)/);
  assert.match(pwa,/if\(cat==='shares'\|\|cat==='receptions'\) return 'shares';/);
  assert.match(pwa,/return n&&n\.linkUrl\?String\(n\.linkUrl\):null;/);
  assert.doesNotMatch(pwa,/return location\.origin\+prefix\+n\.token/);
  assert.match(pwa,/copyText\(link\)\.then\(function\(\)\{toast\(t\('notificationsLinkCopied'\),'ok'\);\},function\(\)\{toast\(t\('copyFailed'\),'err'\);\}\)/);
  assert.match(std,/const linkUrl = \(share && share\.active !== false && share\.url\) \|\| \(!state\.sharesLoaded && n && n\.linkUrl\) \|\| null;/);
});

test('notification preference writes are serialized and recover from failed saves',()=>{
  const std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(std,/let notificationPrefsSaving = false;/);
  assert.match(std,/if \(notificationPrefsSaving\) \{ notificationPrefsSaveQueued = true; return; \}/);
  assert.match(std,/do \{[\s\S]*\} while \(notificationPrefsSaveQueued\);/);
  assert.match(std,/notificationPrefsLoaded = false;[\s\S]{0,180}await loadNotificationPrefs\(true\);/);
  assert.match(pwa,/var notificationPrefsSaving = false;/);
  assert.match(pwa,/if\(notificationPrefsSaving\)\{notificationPrefsSaveQueued=true;return;\}/);
  assert.match(pwa,/do\{[\s\S]*\}while\(notificationPrefsSaveQueued\);/);
  assert.match(pwa,/notificationPrefsLoaded=false;[\s\S]{0,180}await loadPwaNotificationPrefs\(true\);/);
});

test('PWA clipboard fallback rejects a browser refusal instead of reporting false success',()=>{
  const pwa=read('pwa/app.js');
  assert.match(pwa,/var copied=document\.execCommand\('copy'\)===true/);
  assert.match(pwa,/reject\(new Error\('clipboard-denied'\)\)/);
});

test('PWA shell advanced for notification-center fixes',()=>{
  assert.match(read('pwa/app.js'),/APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa/sw.js'),/VERSION = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa/index.html'),/app\.js\?v=273/);
});


test('newly visible rows and contextual actions become read without touching hidden rows', () => {
  const std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(std,/onNotificationFilterChanged\(\).*markVisibleNotificationsRead/);
  assert.match(std,/notification-loadmore[\s\S]{0,700}markVisibleNotificationsRead/);
  assert.match(std,/markOneNotificationRead\(n\); a\.run\(\)/);
  assert.match(pwa,/onPwaNotificationFilterChanged\(\)[\s\S]{0,250}markPwaNotificationsRead/);
  assert.match(pwa,/pwa-notification-loadmore[\s\S]{0,700}markPwaNotificationsRead/);
  assert.match(pwa,/markOnePwaNotificationRead\(n\);a\.run\(\)/);
});

test('failed notification preference loads stay retryable', () => {
  const std=read('public/app.js'), pwa=read('pwa/app.js');
  assert.match(std,/let loaded = false;[\s\S]{0,700}notificationPrefsLoaded = loaded/);
  assert.match(pwa,/var loaded=false;[\s\S]{0,700}notificationPrefsLoaded=loaded/);
});


test('auditor exception is limited to personal notification mutations so future notification admin routes stay read-only', () => {
  const s=read('server.js');
  assert.match(s,/req\.path === '\/notifications\/read'/);
  assert.match(s,/req\.path === '\/notifications\/prefs'/);
  assert.match(s,/req\.method === 'DELETE'/);
  assert.doesNotMatch(s,/const ownNotificationMutation = \/\^/);
});
