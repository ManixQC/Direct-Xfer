'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const categories = ['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','maintenance','network','restarts','updates','security','system_health'];

test('standard notification Settings renders a description for every category', () => {
  const app = read('public/app.js');
  const css = read('public/style.css');
  for (const cat of categories) assert.match(app, new RegExp(`notifications\\.categoryDesc\\.${cat}`));
  assert.match(app, /appendNotificationPrefRow\(settings, cat, NOTIFICATION_REQUIRED_CATEGORIES\.includes\(cat\), true\)/);
  assert.match(app, /notification-pref-description/);
  assert.match(css, /\.notification-pref-description/);
});

test('PWA notification Settings renders localized descriptions for every category', () => {
  const app = read('pwa/app.js');
  const css = read('pwa/app.css');
  const keyNames = ['Shares','Receptions','Images','Transfers','Visitors','Thresholds','Traffic','Search','Pwa','Maintenance','Network','Restarts','Updates','Security','SystemHealth'];
  for (const key of keyNames) assert.match(app, new RegExp(`notificationsCategoryDesc${key}`));
  assert.match(app, /pwaNotificationCategoryDescription\(cat\)/);
  assert.match(app, /appendPwaNotificationPrefRow\(settings,cat,NOTIFICATION_REQUIRED_CATEGORIES\.indexOf\(cat\)!==-1,true\)/);
  assert.match(css, /\.notification-pref-description/);
});

test('PWA cache is refreshed for notification category descriptions', () => {
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=268/);
  assert.match(read('pwa/index.html'), /app\.css\?v=269/);
});
