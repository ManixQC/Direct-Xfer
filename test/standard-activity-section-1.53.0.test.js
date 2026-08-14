'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');
const css = read('public/style.css');

test('1.53.0 exposes a persistent Activity section in the standard interface', () => {
  assert.match(html, /id="activity-section"/);
  assert.match(html, /id="activity-section-body"/);
  assert.match(html, /id="activity-section-search"/);
  assert.match(html, /id="activity-section-kind"/);
  assert.match(html, /id="activity-section-refresh"/);
  assert.match(html, /id="activity-section-open"/);
  assert.match(app, /'activity\.sectionTitle': 'Activité'/);
  assert.match(app, /function filteredActivityEvents\(/);
  assert.match(app, /function activityGroup\(/);
  assert.match(css, /\.activity-section-body\{max-height:460px/);
});

test('standard Activity section shares one durable history feed with the full history modal', () => {
  assert.match(app, /api\('GET','\/api\/activity\/recent\?limit=1000'\)/);
  assert.match(app, /new EventSource\('\/api\/activity\/stream'\)/);
  assert.match(app, /function ensureActivityStream\(\)/);
  assert.match(app, /if\(state\.activitySource\)return/);
  assert.match(app, /renderActivityRows\(\$\('activity-body'\),state\.activityEvents\|\|\[\],500\)/);
  assert.match(app, /renderActivityRows\(\$\('activity-section-body'\),filtered,30\)/);
  assert.match(app, /function openLiveActivity\(\).*ensureActivityStream\(\)/);
});

test('Activity section is role-gated and its client state is cleared across auth boundaries', () => {
  assert.match(app, /show\('activity-section', isFull \|\| role === 'auditor'\)/);
  assert.match(app, /else stopActivityStream\(\)/);
  assert.match(app, /state\.activitySource\.close/);
  assert.match(app, /state\.activityEvents = \[\]/);
  assert.match(app, /state\.activityInitialized = false/);
});

test('release is bumped to 1.53.0 with a fresh companion cache', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.53.0');
  assert.equal(JSON.parse(read('package-lock.json')).version, '1.53.0');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.53\.0'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.12-pwa256'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.12-pwa256'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=242/);
  assert.match(read('pwa/sw.js'), /app\.js\?v=242/);
});
