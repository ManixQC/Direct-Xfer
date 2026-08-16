'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const html = read('pwa', 'index.html');
const css = read('pwa', 'app.css');
const app = read('pwa', 'app.js');
const sw = read('pwa', 'sw.js');

test('PWA Activity puts live transfers before persistent activity history', () => {
  const live = html.indexOf('id="pwa-live-transfers-title"');
  const history = html.indexOf('id="server-activity-card"');
  assert.ok(live >= 0, 'live transfers section missing');
  assert.ok(history >= 0, 'activity history card missing');
  assert.ok(live < history, 'live transfers must be the first Activity section');
  assert.match(html, /class="card pwa-live-transfers"[^>]*data-pwa-panel="activity"/);
});

test('Activity filter controls cannot force the PWA card wider than the viewport', () => {
  assert.match(css, /\.server-activity-tools\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*max-width:100%/);
  assert.match(css, /\.server-activity-tools>:not\(\.sr-only\)\{[^}]*min-width:0[^}]*max-width:100%[^}]*width:100%/);
  assert.ok(css.includes('.server-activity-tools{grid-template-columns:minmax(0,1fr)}'), 'mobile Activity filters must collapse to one column');
  assert.match(css, /\.activity-filter-check\{[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
});

test('Activity event cards wrap complete titles, metadata and timestamps instead of clipping them', () => {
  assert.match(css, /\.server-activity-row\{[^}]*grid-template-columns:30px minmax\(0,1fr\) auto[^}]*width:100%[^}]*overflow:visible/);
  assert.match(css, /\.server-activity-row \.history-main strong\{[^}]*white-space:normal[^}]*overflow:visible[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.server-activity-row \.history-meta\{[^}]*white-space:normal[^}]*overflow:visible[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.server-activity-group-head\{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.server-activity-row time\{[^}]*justify-self:end/);
  assert.ok(css.includes('.server-activity-row{grid-template-columns:26px minmax(0,1fr)}'), 'mobile event rows must use two bounded columns');
  assert.ok(css.includes('.server-activity-row time{grid-column:2;justify-self:start;white-space:normal}'), 'mobile timestamp must stay under the event content');
});

test('Live transfer cards also keep long filenames visible without losing the stop button', () => {
  assert.match(css, /\.pwa-live-transfer\{[^}]*grid-template-columns:auto minmax\(0,1fr\) auto/);
  assert.match(css, /\.pwa-live-name-text\{[^}]*white-space:normal[^}]*overflow:visible[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.pwa-live-stop\{[^}]*width:34px[^}]*height:34px/);
});

test('installed PWAs receive the Activity layout fix through a new cache generation', () => {
  assert.match(app, /APP_VERSION = '1\.63\.4'/);
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(html, /v1\.63\.4 · pwa317/);
  assert.match(html, /app\.css\?v=280/);
  assert.match(html, /app\.js\?v=297/);
  assert.match(sw, /app\.css\?v=280/);
  assert.match(sw, /app\.js\?v=297/);
});
