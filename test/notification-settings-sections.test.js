'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('standard Configuration exposes account notification-center choices', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /id="cfg-notification-center-prefs"/);
  assert.match(html, /data-i18n="notifications\.settingsTitle"/);
  assert.match(app, /NOTIFICATION_SETTINGS_CATEGORIES = \['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','network','restarts','updates','maintenance','security','system_health'\]/);
  assert.match(app, /NOTIFICATION_REQUIRED_CATEGORIES = \['security','maintenance','system_health'\]/);
  assert.match(app, /setNotificationCategoryPreference\(cat, cb\.checked\)/);
  assert.match(app, /api\('POST','\/api\/notifications\/prefs'/);
  assert.match(app, /void loadNotificationPrefs\(\);/);
});

test('PWA Settings exposes the same account-scoped choices and keeps required categories locked', () => {
  const html = read('pwa/index.html');
  const app = read('pwa/app.js');
  assert.match(html, /id="settings-notification-prefs"/);
  assert.match(html, /data-i18n="notificationsSettingsTitle"/);
  assert.match(app, /NOTIFICATION_REQUIRED_CATEGORIES = \['security','maintenance','system_health'\]/);
  assert.match(app, /NOTIFICATION_SETTINGS_CATEGORIES = \['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','network','restarts','updates','maintenance','security','system_health'\]/);
  assert.match(app, /cb\.disabled=true/);
  assert.match(app, /setPwaNotificationCategoryPreference\(cat,cb\.checked\)/);
  assert.match(app, /appMutate\('\/app\/notifications\/prefs'/);
  assert.match(app, /panel === 'settings'[\s\S]{0,180}loadPwaNotificationPrefs\(\)/);
});

test('Security, Maintenance and System health remain server-enforced while system subcategories stay account-scoped', () => {
  const server = read('server.js');
  assert.match(server, /const NOTIFICATION_MUTABLE_CATEGORIES = \['images','shares','receptions','transfers','search','pwa','visitors','thresholds','traffic','network','restarts','updates'\]/);
  assert.match(server, /if \(!NOTIFICATION_MUTABLE_CATEGORIES\.includes\(category\)\) return false; \/\/ security\/maintenance\/system health always on/);
  assert.match(server, /adminRouter\.get\('\/notifications\/prefs'/);
  assert.match(server, /app\.get\('\/app\/notifications\/prefs'/);
});

test('PWA cache revision includes notification Settings UI', () => {
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa280'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa280'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=266/);
  assert.match(read('pwa/index.html'), /app\.css\?v=266/);
});
