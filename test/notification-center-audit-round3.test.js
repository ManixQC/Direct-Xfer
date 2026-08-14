'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const standard = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('explicit empty account target never falls back to all admins', () => {
  assert.match(server, /const ids = Array\.isArray\(accountIds\) \? accountIds\.map\(String\) : notificationAdminAccountIds\(\);/);
  assert.doesNotMatch(server, /Array\.isArray\(accountIds\) && accountIds\.length \? accountIds\.map\(String\) : notificationAdminAccountIds\(\)/);
  assert.match(server, /return addAdminCenterNotification\(type, data, notificationAccountIdsForRequest\(req\)\);/);
});

test('notification mutations invalidate older polls in standard and PWA UIs', () => {
  assert.match(standard, /notificationsRequestSeq \+= 1;[\s\S]{0,300}accountNotifications = accountNotifications\.filter/);
  assert.match(standard, /notificationsRequestSeq \+= 1; accountNotifications=\[\]; renderNotifications\(\)/);
  assert.match(standard, /notificationsRequestInFlight = false;\n  \}/);
  assert.match(pwa, /notificationRequestSeq\+=1;accountNotifications=accountNotifications\.filter/);
  assert.match(pwa, /notificationRequestSeq\+=1;accountNotifications=\[\];renderPwaNotifications\(\)/);
  assert.match(pwa, /finally \{ if\(timer\)clearTimeout\(timer\); if\(notificationRequestController===ctrl\)notificationRequestController=null; notificationRequestInFlight=false; \}/);
});

test('partial Range or preview aborts do not become failed-transfer notifications', () => {
  assert.match(server, /const centerInteresting = !!\(centerShare && \(completed \? meaningfulCompletedTransfer : \(\(t\.direction \|\| 'down'\) === 'up' \|\| !!t\.notify\)\)\);/);
  assert.doesNotMatch(server, /centerInteresting[^\n]*Number\(t\.bytes\) > 0/);
});
