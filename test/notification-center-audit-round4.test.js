'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const standard = fs.readFileSync(path.join(root,'public','app.js'),'utf8');

test('paired PWA device is the sole notification principal when admin and device cookies coexist', () => {
  const a = server.slice(server.indexOf('function notificationAccountIdsForRequest(req)'), server.indexOf('function publicNotification', server.indexOf('function notificationAccountIdsForRequest(req)')));
  assert.match(a, /if \(dev\)[\s\S]*return acc && acc\.id \? \[String\(acc\.id\)\] : \[\]/);
  assert.doesNotMatch(a, /ids\.push/);
  const b = server.slice(server.indexOf('function pwaNotificationAccountId(req)'), server.indexOf('function pwaPushTargets', server.indexOf('function pwaNotificationAccountId(req)')));
  assert.match(b, /if \(d\)[\s\S]*return account && account\.id \? String\(account\.id\) : null/);
  assert.ok(b.indexOf('if (d)') < b.indexOf('req.pwaSession'), 'device must be checked before admin session');
});

test('activity and repeated-download trackers use exact IP unless anonymization is enabled', () => {
  assert.match(server, /tr\.events\.push\(\{ at:now, kind:String\(kind\|\|'activity'\), ip:pubIp\(String\(rawIp \|\| ''\)/);
  assert.match(server, /const ip = pubIp\(String\(rawIp\)\.replace/);
});

test('cold GeoIP login notifications are enriched asynchronously without recreation', () => {
  const login = server.slice(server.indexOf('function attemptLogin('), server.indexOf('// Changes an account', server.indexOf('function attemptLogin(')));
  assert.match(login, /const loginCenterNote = recognizedOwnDevice \? null : addCenterNotification/);
  assert.match(login, /geolocate\(ip\)\.then/);
  assert.match(login, /enrichCenterNotificationGeo\(acc\.id, loginCenterNote\.id/);
  const enrich = server.slice(server.indexOf('function enrichCenterNotificationGeo('), server.indexOf('function addCenterNotification', server.indexOf('function enrichCenterNotificationGeo(')));
  assert.match(enrich, /if \(!rec\) return false/);
});

test('restored notification normalization is scheduled for durable persistence', () => {
  const fn = server.slice(server.indexOf('function notificationCenterStore()'), server.indexOf('function trimNotificationCenterAccount', server.indexOf('function notificationCenterStore()')));
  assert.match(fn, /const changed =/);
  assert.match(fn, /if \(changed\) scheduleFlush\(\)/);
});

test('standard polling sleeps in hidden tabs and aborts old-session GETs', () => {
  assert.match(standard, /let notificationsRequestController = null/);
  assert.match(standard, /notificationsRequestController = ctrl/);
  const stop = standard.slice(standard.indexOf('function stopNotificationsPolling()'), standard.indexOf('function startNotificationsPolling()', standard.indexOf('function stopNotificationsPolling()')));
  assert.match(stop, /invalidateNotificationsFetch\(\)/);
  assert.match(standard, /function invalidateNotificationsFetch\(\)[\s\S]*notificationsRequestController\.abort\(\)/);
  assert.match(stop, /notificationsRequestInFlight = false/);
  assert.match(standard, /if\(isLoggedIn\(\) && !document\.hidden\) refreshNotifications\(true\)/);
  assert.match(standard, /visibilitychange[\s\S]*refreshNotifications\(true\)/);
});

test('automatic-disable event identity includes the active triggering limit', () => {
  const fn = server.slice(server.indexOf('function noteCenterAutoDisabled('), server.indexOf('function checkCenterLinkStates()', server.indexOf('function noteCenterAutoDisabled(')));
  assert.match(fn, /reason === 'download-limit'[\s\S]*s\.maxDownloads/);
  assert.match(fn, /reason === 'visitor-limit'[\s\S]*s\.maxVisitors/);
  assert.match(fn, /reason === 'bandwidth-limit'[\s\S]*s\.maxBytesServed/);
  assert.match(fn, /auto-disabled:\$\{s\.id\}:\$\{reason\}:\$\{trigger\}/);
});
