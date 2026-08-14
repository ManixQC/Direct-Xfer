const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT,p),'utf8');

test('1.44.1 exposes one account-scoped notification store to admin and PWA', () => {
  const s=read('server.js');
  assert.match(s,/function notificationCenterStore\(\)/);
  assert.match(s,/function notificationsForAccount\(accountId, req\)/);
  assert.match(s,/addFirstViewCenterNotification\(s,/);
  assert.match(s,/adminRouter\.get\('\/notifications'/);
  assert.match(s,/adminRouter\.delete\('\/notifications\/:id'/);
  assert.match(s,/adminRouter\.delete\('\/notifications'/);
  assert.match(s,/app\.get\('\/app\/notifications'/);
  assert.match(s,/app\.post\('\/app\/notifications\/delete'/);
  assert.match(s,/app\.post\('\/app\/notifications\/clear'/);
});

test('standard and PWA both render synced notification controls', () => {
  const std=read('public/index.html'), pwa=read('pwa/index.html');
  assert.match(std,/id="notifications-btn"/); assert.match(std,/id="notifications-clear"/);
  assert.match(pwa,/id="pwa-notifications-btn"/); assert.match(pwa,/id="pwa-notifications-clear"/);
  assert.match(read('public/app.js'),/refreshNotifications/);
  assert.match(read('pwa/app.js'),/refreshPwaNotifications/);
});

test('release is bumped to 1.51.2 and PWA cache is advanced', () => {
  assert.equal(JSON.parse(read('package.json')).version,'1.59.0');
  assert.match(read('pwa/app.js'),/APP_VERSION = '1\.59\.0'/);
  assert.match(read('pwa/app.js'),/pwa279/);
  assert.match(read('pwa/sw.js'),/pwa279/);
  assert.match(read('pwa/index.html'),/v=265/);
});
