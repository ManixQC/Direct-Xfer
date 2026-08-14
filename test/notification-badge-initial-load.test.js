'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('standard notification badge hydrates on every authenticated app entry', () => {
  const initStart = app.indexOf('async function init()');
  const initEnd = app.indexOf('document.addEventListener(\'visibilitychange\'', initStart);
  const init = app.slice(initStart, initEnd);
  assert.match(init, /startNotificationsPolling\(\);/);

  const showLoginStart = app.indexOf('function showLogin()');
  const showLoginEnd = app.indexOf('function showApp()', showLoginStart);
  const showLogin = app.slice(showLoginStart, showLoginEnd);
  assert.match(showLogin, /stopNotificationsPolling\(\);/);

  assert.match(app, /function stopNotificationsPolling\(\)/);
  assert.match(app, /function startNotificationsPolling\(\)[\s\S]{0,700}refreshNotifications\(true\)/);
});

test('session bootstrap no longer owns the only notification polling start', () => {
  const bootstrapStart = app.indexOf('(async function bootstrap()');
  const bootstrapEnd = app.indexOf('// ==================================================================', bootstrapStart);
  const bootstrap = app.slice(bootstrapStart, bootstrapEnd);
  assert.doesNotMatch(bootstrap, /startNotificationsPolling\(\);/);
});
