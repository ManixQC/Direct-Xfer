'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT,p),'utf8');

test('notification retention is capped per account instead of globally', () => {
  const s = read('server.js');
  assert.match(s, /NOTIFICATION_CENTER_MAX_PER_ACCOUNT\s*=\s*500/);
  assert.match(s, /function trimNotificationCenterAccount\(accountId/);
  assert.match(s, /counts\.get\(key\)[\s\S]*NOTIFICATION_CENTER_MAX_PER_ACCOUNT/);
  assert.doesNotMatch(s, /const NOTIFICATION_CENTER_MAX = 500/);
  assert.match(s, /list\.unshift\(rec\);\s*trimNotificationCenterAccount\(accountId, list\)/);
});

test('notification IPs honor the current anonymization setting at read time', () => {
  const s = read('server.js');
  const fn = /function publicNotification\(n\) \{([\s\S]*?)\n\}/.exec(s);
  assert.ok(fn, 'publicNotification missing');
  assert.match(fn[1], /ip:n\.ip \? pubIp\(n\.ip\) : null/);
});

test('center expiry-soon warning no longer depends on webhook/email reminder settings', () => {
  const s = read('server.js');
  const fn = /function checkCenterLinkStates\(\) \{([\s\S]*?)\n\}/.exec(s);
  assert.ok(fn, 'checkCenterLinkStates missing');
  assert.match(fn[1], /24 \* 3600 \* 1000/);
  assert.match(fn[1], /link-expiring-soon/);
  assert.match(fn[1], /dedupeKey:`expiring:\$\{s\.id\}:\$\{deadline\}`/);
  assert.doesNotMatch(fn[1], /notifyExpiring|expiryWarnHours/);
});

test('saturated visitor registry does not emit phantom new visitors', () => {
  const s = read('server.js');
  const fn = /function recordVisitorIp\(s, ip\) \{([\s\S]*?)\n\}/.exec(s);
  assert.ok(fn, 'recordVisitorIp missing');
  assert.match(fn[1], /s\.visitors\.length >= VISITORS_MAX\) return false/);
  assert.match(fn[1], /s\.visitors\.push\(ip\);\s*return true/);
});

test('standard and PWA ignore stale out-of-order notification polls', () => {
  const std = read('public/app.js');
  const pwa = read('pwa/app.js');
  assert.match(std, /notificationsRequestSeq/);
  assert.match(std, /seq !== notificationsRequestSeq\) return/);
  assert.match(pwa, /notificationRequestSeq/);
  assert.match(pwa, /seq!==notificationRequestSeq\)return/);
});


test('new-country notifications resolve uncached landing visits and reject fake/local countries', () => {
  const s = read('server.js');
  const countryStart = s.indexOf('function noteCenterCountry(s, rawIp, geo)');
  const countryEnd = s.indexOf('function maybeCenterViewThreshold', countryStart);
  const country = s.slice(countryStart, countryEnd);
  assert.ok(countryStart >= 0, 'noteCenterCountry missing');
  assert.match(country, /geoLookup === false/);
  assert.match(country, /countryCode \|\| ''/);
  assert.match(country, /code\.length !== 2\) return false/);
  const bumpStart = s.indexOf('function bumpViews(s, req)');
  const bumpEnd = s.indexOf('// Safe in-browser preview', bumpStart);
  const bump = s.slice(bumpStart, bumpEnd);
  assert.ok(bumpStart >= 0, 'bumpViews missing');
  assert.match(bump, /geolocate\(rawIp\)\.then/);
  assert.match(bump, /noteCenterCountry\(s, rawIp, resolved\)/);
});

test('PWA shell is advanced for the notification polling fix', () => {
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=268/);
});
