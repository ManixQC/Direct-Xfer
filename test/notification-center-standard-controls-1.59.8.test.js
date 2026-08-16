'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const html = read('public', 'index.html');
const app = read('public', 'app.js');
const css = read('public', 'style.css');
const pwaApp = read('pwa', 'app.js');

test('standard notification delete button has exactly one CSS-drawn X', () => {
  assert.match(app, /class:'btn ghost sm notification-delete', attrs:\{ type:'button'/);
  assert.doesNotMatch(app, /notification-delete', text:'×'/);
  assert.match(css, /\.notification-delete::before\s*\{[\s\S]*linear-gradient\(45deg[\s\S]*linear-gradient\(-45deg/);
});

test('PWA notification delete button does not duplicate its CSS-drawn X either', () => {
  assert.match(pwaApp, /className='btn ghost sm pwa-notification-delete'; del\.title=/);
  assert.doesNotMatch(pwaApp, /pwa-notification-delete'; del\.textContent='×'/);
});

test('notification header actions use stable masked icons instead of inline SVG or emoji glyphs', () => {
  const head = html.match(/<div class="notification-head">[\s\S]*?<\/div>/);
  assert.ok(head, 'notification header not found');
  assert.match(head[0], /id="notifications-sound"[\s\S]*notification-head-glyph notification-sound-glyph/);
  assert.match(head[0], /id="notifications-prefs-btn"[\s\S]*notification-head-glyph notification-settings-glyph/);
  assert.doesNotMatch(head[0], /<svg|🔔|🔕|⚙️/);
  assert.match(css, /\.notification-head-actions\s*\{[^}]*align-items:center/);
  assert.match(css, /\.notification-head-btn\s*\{[^}]*display:inline-flex !important;[^}]*align-items:center;[^}]*justify-content:center/);
  assert.match(css, /\.notification-head-glyph\s*\{[\s\S]*background-color:currentColor;[\s\S]*mask-size:contain/);
  assert.match(css, /notification-volume-off\.svg/);
  assert.match(css, /notification-settings\.svg/);
});

test('sound state toggles the masked icon without replacing its content', () => {
  assert.match(app, /classList\.toggle\('notification-sound-on', notificationsSoundOn\)/);
  assert.match(app, /classList\.toggle\('notification-sound-off', !notificationsSoundOn\)/);
  assert.doesNotMatch(app, /b\.textContent\s*=\s*notificationsSoundOn/);
  assert.match(css, /\.notification-head-btn\.notification-sound-on \.notification-sound-glyph[\s\S]*notification-volume-on\.svg/);
});

test('standard admin assets are cache-busted for the 1.63.4 notification fix', () => {
  assert.match(html, /\/style\.css\?v=286/);
  assert.match(html, /\/app\.js\?v=297/);
});
