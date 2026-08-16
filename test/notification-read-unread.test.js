'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

test('notification read state is persisted server-side and old rows migrate as read',()=>{
  const s=read('server.js');
  assert.match(s,/const NOTIFICATION_READ_STATE_VERSION = 1/);
  assert.match(s,/notificationReadStateVersion/);
  assert.match(s,/n\.readAt = Math\.max\(1, Number\(n\.at\) \|\| migratedAt\)/);
  assert.match(s,/readAt:null/);
  assert.match(s,/unread:!\(Number\(n\.readAt\)>0\)/);
  assert.match(s,/function markNotificationsReadForAccount\(accountId, requestedIds, persistAfter = true\)/);
  assert.match(s,/adminRouter\.post\('\/notifications\/read'/);
  assert.match(s,/app\.post\('\/app\/notifications\/read'/);
});

test('standard notification badge counts unread only and opening the panel marks visible rows read',()=>{
  const s=read('public/app.js');
  assert.match(s,/const unreadCount = rows\.reduce/);
  assert.match(s,/badge\.textContent = unreadCount > 99/);
  assert.match(s,/function markVisibleNotificationsRead\(\)/);
  assert.match(s,/api\('POST','\/api\/notifications\/read', \{ ids:readIds \}\)/);
  assert.match(s,/if \(notificationsMenuIsOpen\(\)\) void markVisibleNotificationsRead\(\)/);
  assert.match(s,/if\(opening\)\{ notificationsShown = NOTIFICATIONS_PAGE_SIZE; renderNotifications\(\); void markVisibleNotificationsRead\(\); refreshNotifications\(true\); \}/);
});

test('PWA notification badge counts unread only and panel-open state marks arrivals read',()=>{
  const s=read('pwa/app.js');
  assert.match(s,/var unreadCount=rows\.reduce/);
  assert.match(s,/badge\.textContent=unreadCount>99/);
  assert.match(s,/function markPwaNotificationsRead\(\)/);
  assert.match(s,/appMutate\('\/app\/notifications\/read'/);
  assert.match(s,/if\(pwaNotificationsOpen\(\)\)void markPwaNotificationsRead\(\)/);
});

test('read mutations reconcile server-confirmed read and existence ids to avoid GET/read races',()=>{
  const std=read('public/app.js'), pwa=read('pwa/app.js'), server=read('server.js');
  assert.match(server,/const ids = notifications\.filter\(\(n\) => !n\.unread\)/);
  assert.match(server,/const existingIds = notifications\.map\(\(n\) => String\(n\.id\)\)/);
  assert.match(std,/const markedIds = new Set\(Array\.isArray\(result && result\.ids\)/);
  assert.match(std,/const existingIds = Array\.isArray\(result && result\.existingIds\)/);
  assert.match(pwa,/var markedIds=new Set\(Array\.isArray\(data&&data\.ids\)/);
  assert.match(pwa,/var existingIds=Array\.isArray\(data&&data\.existingIds\)/);
});

test('unread rows have a visual distinction and PWA cache advances',()=>{
  assert.match(read('public/style.css'),/notification-item\.notification-unread/);
  assert.match(read('pwa/app.css'),/pwa-notification-item\.notification-unread/);
  assert.match(read('pwa/app.js'),/APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/sw.js'),/VERSION = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/index.html'),/app\.js\?v=290/);
});
