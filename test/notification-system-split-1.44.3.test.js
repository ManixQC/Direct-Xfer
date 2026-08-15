'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('1.44.3 splits legacy System notifications into focused categories', () => {
  const server = read('server.js');
  const expected = {
    'system-problem':'system_health', 'service-unavailable':'system_health', 'service-restored':'system_health',
    'config-save-failed':'system_health', 'server-crash-recovered':'system_health',
    'retention-file-deleted':'maintenance', 'cleanup-complete':'maintenance',
    'public-ip-changed':'network', 'server-restarted':'restarts', 'server-clean-shutdown':'restarts',
    'update-available':'updates', 'update-installed':'updates',
  };
  for (const [type, category] of Object.entries(expected)) {
    assert.match(server, new RegExp(`'${type}':\\['${category}'`));
  }
  assert.match(server, /const NOTIFICATION_CATEGORY_SCHEMA_VERSION = 3;/);
  assert.match(server, /if \(category === 'system'\) return NOTIFICATION_SYSTEM_CATEGORY_BY_TYPE\[type\] \|\| 'system_health';/);
  assert.match(server, /const nextCategory = migratedNotificationCategory\(n\)/);
  assert.match(server, /if \(nextCategory !== currentCategory\) \{ n\.category = nextCategory/);
});

test('restarts and updates are optional while system health remains mandatory', () => {
  const server = read('server.js');
  const standard = read('public/app.js');
  const pwa = read('pwa/app.js');
  const mutable = /const NOTIFICATION_MUTABLE_CATEGORIES = \[([^\]]*)\]/.exec(server)?.[1] || '';
  assert.match(mutable, /'restarts'/);
  assert.match(mutable, /'updates'/);
  assert.doesNotMatch(mutable, /'maintenance'/);
  assert.match(mutable, /'network'/);
  assert.doesNotMatch(mutable, /'system_health'/);
  assert.match(standard, /NOTIFICATION_REQUIRED_CATEGORIES = \['security','maintenance','system_health'\]/);
  assert.match(pwa, /NOTIFICATION_REQUIRED_CATEGORIES = \['security','maintenance','system_health'\]/);
  assert.match(standard, /NOTIFICATION_MUTABLE_CATEGORIES = \[[^\]]*'restarts'[^\]]*'updates'/);
  assert.match(pwa, /NOTIFICATION_MUTABLE_CATEGORIES = \[[^\]]*'restarts'[^\]]*'updates'/);
});

test('standard and PWA settings expose system subcategories with descriptions and filters', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const pwaHtml = read('pwa/index.html');
  const pwa = read('pwa/app.js');
  for (const cat of ['maintenance','network','restarts','updates','system_health']) {
    assert.match(html, new RegExp(`option value="${cat}"`));
    assert.match(app, new RegExp(`notifications\\.category\\.${cat}`));
    assert.match(app, new RegExp(`notifications\\.categoryDesc\\.${cat}`));
    assert.match(pwaHtml, new RegExp(`option value="${cat}"`));
  }
  for (const key of ['Maintenance','Network','Restarts','Updates','SystemHealth']) {
    assert.match(pwa, new RegExp(`notificationsCategory${key}`));
    assert.match(pwa, new RegExp(`notificationsCategoryDesc${key}`));
  }
  assert.doesNotMatch(html.match(/id="notifications-category-filter"[\s\S]*?<\/select>/)?.[0] || '', /value="system"/);
  assert.doesNotMatch(pwaHtml.match(/id="pwa-notifications-category-filter"[\s\S]*?<\/select>/)?.[0] || '', /value="system"/);
});

test('release is 1.51.2 with refreshed PWA cache', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.59.5');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.59\.5'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa284'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa284'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=268/);
});
