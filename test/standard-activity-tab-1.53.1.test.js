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
const server = read('server.js');
const pwaHtml = read('pwa/index.html');
const pwaApp = read('pwa/app.js');

test('1.54.0 moves Activity from the home card to a dedicated standard topbar tab', () => {
  assert.match(html, /id="activity-btn"[^>]*aria-controls="activity-page"/);
  assert.match(html, /id="activity-page" class="app-view activity-page hidden"/);
  assert.match(html, /id="activity-back"/);
  assert.match(html, /id="activity-section-body"/);
  const homeStart = html.indexOf('<main id="app-view"');
  const homeEnd = html.indexOf('</main>', homeStart);
  const activityPage = html.indexOf('<main id="activity-page"');
  const activitySection = html.indexOf('id="activity-section"');
  assert.ok(activityPage > homeEnd, 'Activity must no longer be a card inside the home dashboard');
  assert.ok(activitySection > activityPage, 'Activity section must live inside the dedicated page');
  assert.match(app, /const ACTIVITY_PATH = '\/activity'/);
  assert.match(app, /function openActivityPage\(/);
  assert.match(app, /location\.pathname === ACTIVITY_PATH/);
  assert.match(server, /app\.get\('\/activity', adminGuard/);
  assert.match(css, /\.activity-launch-btn/);
});

test('dedicated standard Activity page keeps persistent history, filters and one SSE stream', () => {
  assert.match(html, /id="activity-section-search"/);
  assert.match(html, /id="activity-section-kind"/);
  assert.match(html, /id="activity-section-refresh"/);
  assert.match(app, /api\('GET','\/api\/activity\/recent\?limit=1000'\)/);
  assert.match(app, /new EventSource\('\/api\/activity\/stream'\)/);
  assert.match(app, /if\(state\.activitySource\)return/);
  assert.match(app, /const sectionLimit=activityPageOpen\(\)\?1000:30/);
  assert.match(app, /show\('activity-btn', isFull \|\| role === 'auditor'\)/);
  assert.match(app, /state\.activityEvents = \[\]/);
});

test('PWA Activity tab mirrors standard persistent activity and keeps local transfer history outside the tab', () => {
  assert.match(pwaHtml, /id="server-activity-card"[^>]*data-pwa-panel="activity"/);
  assert.match(pwaHtml, /id="server-activity-list"/);
  assert.match(pwaHtml, /id="history-card"[^>]*data-pwa-panel="send"/);
  assert.match(pwaApp, /fetch\('\/app\/activity\/recent\?limit=1000'/);
  assert.match(pwaApp, /function renderPwaServerActivity\(/);
    assert.match(pwaApp, /startPwaActivityRefresh/);
  assert.match(server, /app\.get\('\/app\/activity\/recent'/);
  assert.match(server, /function pwaCanSeeActivityEvent\(/);
});

test('release is bumped to 1.54.0 with a fresh companion cache', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.62.2');
  assert.equal(JSON.parse(read('package-lock.json')).version, '1.62.2');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.62\.2'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=290/);
  assert.match(read('pwa/sw.js'), /app\.js\?v=290/);
});
