'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('1.44.1 splits Activity into Visitors, Thresholds and Traffic server-side', () => {
  const server = read('server.js');
  assert.match(server, /'new-country':\['visitors','info'\]/);
  assert.match(server, /'visitor-device-new':\['visitors','info'\]/);
  assert.match(server, /'view-threshold':\['thresholds','success'\]/);
  assert.match(server, /'download-threshold':\['thresholds','success'\]/);
  assert.match(server, /'high-download-volume':\['traffic','warning'\]/);
  assert.match(server, /'link-viral':\['traffic','warning'\]/);
  assert.match(server, /NOTIFICATION_ACTIVITY_SPLIT_CATEGORIES = \['visitors','thresholds','traffic'\]/);
  assert.match(server, /raw\.includes\('activity'\) \? raw\.concat\(NOTIFICATION_ACTIVITY_SPLIT_CATEGORIES\)/);
  assert.match(server, /notificationCategorySchemaVersion/);
  assert.match(server, /migratedNotificationCategory\(n\)/);
});

test('standard notification settings and filter expose the three detailed categories', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  for (const cat of ['visitors','thresholds','traffic']) {
    assert.match(html, new RegExp(`option value="${cat}"`));
    assert.match(app, new RegExp(`notifications\\.category\\.${cat}`));
  }
  assert.doesNotMatch(html.match(/id="notifications-category-filter"[\s\S]*?<\/select>/)?.[0] || '', /value="activity"/);
  assert.match(app, /NOTIFICATION_SETTINGS_CATEGORIES = \['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','network','restarts','updates','maintenance','security','system_health'\]/);
});

test('PWA notification settings/filter expose detailed categories and no Expand all control remains', () => {
  const html = read('pwa/index.html');
  const app = read('pwa/app.js');
  for (const [cat, key] of [['visitors','Visitors'],['thresholds','Thresholds'],['traffic','Traffic']]) {
    assert.match(html, new RegExp(`option value="${cat}"`));
    assert.match(app, new RegExp(`notificationsCategory${key}`));
  }
  assert.match(app, /NOTIFICATION_SETTINGS_CATEGORIES = \['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','network','restarts','updates','maintenance','security','system_health'\]/);
  assert.doesNotMatch(html, /toggle-cards-btn|cards-toggle-row|Tout déplier/);
  assert.doesNotMatch(app, /toggleAllCards|updateToggleCardsLabel/);
});

test('release/cache are advanced to 1.51.2 pwa289 v238', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.60.0');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.60\.0'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=273/);
});
