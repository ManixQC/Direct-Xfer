'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('1.63.3 PWA live transfers refresh every five seconds', () => {
  const app = read('pwa','app.js');
  assert.match(app, /PWA_LIVE_TRANSFERS_POLL_MS\s*=\s*5000/);
  assert.match(app, /setInterval\(function \(\) \{[\s\S]{0,260}loadPwaLiveTransfers\(false\)[\s\S]{0,120}PWA_LIVE_TRANSFERS_POLL_MS/);
});

test('1.63.3 live transfer heading is 50 percent larger', () => {
  const css = read('pwa','app.css');
  assert.match(css, /\.pwa-live-transfers-head h2,\.pwa-live-transfers-head h3\{[^}]*font-size:1\.5rem/);
});

test('1.63.3 installed PWA double-back exit uses CloseWatcher rather than history stacking', () => {
  const app = read('pwa','app.js');
  assert.match(app, /PWA_BACK_EXIT_WINDOW_MS\s*=\s*2000/);
  assert.match(app, /new window\.CloseWatcher\(\)/);
  assert.match(app, /window\.close\(\)/);
  assert.doesNotMatch(app, /history\.pushState\(\{\s*dxBack/);
});

test('1.63.3 PWA assets are cache-busted', () => {
  const html = read('pwa','index.html');
  const sw = read('pwa','sw.js');
  assert.match(html, /app\.css\?v=279/);
  assert.match(html, /app\.js\?v=296/);
  assert.match(sw, /app\.css\?v=279/);
  assert.match(sw, /app\.js\?v=296/);
});
