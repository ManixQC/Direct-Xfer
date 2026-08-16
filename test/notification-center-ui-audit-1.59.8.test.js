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
const pwaHtml = read('pwa', 'index.html');
const pwaApp = read('pwa', 'app.js');
const pwaCss = read('pwa', 'app.css');
const pwaSw = read('pwa', 'sw.js');

test('standard notification sound and settings controls use visible external mask assets', () => {
  const head = html.match(/<div class="notification-head">[\s\S]*?<\/div>/);
  assert.ok(head, 'standard notification header not found');
  assert.match(head[0], /id="notifications-sound"[\s\S]*notification-sound-glyph/);
  assert.match(head[0], /id="notifications-prefs-btn"[\s\S]*notification-settings-glyph/);
  assert.doesNotMatch(head[0], /<svg|🔔|🔕|⚙️/);
  assert.ok(fs.existsSync(path.join(root,'public','ui','notification-volume-on.svg')));
  assert.ok(fs.existsSync(path.join(root,'public','ui','notification-volume-off.svg')));
  assert.ok(fs.existsSync(path.join(root,'public','ui','notification-settings.svg')));
  assert.match(css, /notification-volume-off\.svg/);
  assert.match(css, /notification-volume-on\.svg/);
  assert.match(css, /notification-settings\.svg/);
  assert.match(app, /classList\.toggle\('notification-sound-on', notificationsSoundOn\)/);
  assert.doesNotMatch(app, /notifications-sound[^\n]*(?:textContent|innerHTML)/);
});

test('standard notification dropdown remains bounded when preferences are expanded', () => {
  assert.match(css, /\.notification-dropdown\s*\{[\s\S]*max-height:[^;]+;[\s\S]*overflow:hidden;[\s\S]*min-height:0;/);
  assert.match(css, /\.notification-prefs\s*\{[\s\S]*max-height:min\(250px, 40dvh\);[\s\S]*overflow-y:auto;[\s\S]*overflow-x:hidden;/);
  assert.match(css, /\.notification-list\s*\{[^}]*flex:1 1 180px;[^}]*overflow:auto;/);
  assert.match(app, /closeNotificationsMenu\(\)[\s\S]*prefs\.classList\.add\('hidden'\)[\s\S]*prefsBtn\.setAttribute\('aria-expanded','false'\)/);
});

test('PWA notification controls use the same stable mask assets and overflow hardening', () => {
  assert.match(pwaHtml, /id="pwa-notifications-sound"[\s\S]*pwa-notification-sound-glyph/);
  assert.match(pwaHtml, /id="pwa-notifications-prefs-btn"[\s\S]*pwa-notification-settings-glyph/);
  assert.doesNotMatch(pwaHtml, /<svg class="pwa-notification-head-icon|>🔕<|>⚙️</);
  assert.doesNotMatch(pwaApp, /pwa-notifications-sound[^\n]*textContent\s*=/);
  assert.doesNotMatch(pwaApp, /pwa-notifications-prefs-btn[^\n]*textContent\s*=\s*['"]⚙️/);
  assert.match(pwaCss, /pwa-notification-sound-glyph[\s\S]*notification-volume-off\.svg/);
  assert.match(pwaCss, /pwa-notification-settings-glyph[\s\S]*notification-settings\.svg/);
  assert.match(pwaCss, /\.pwa-notifications-dropdown\s*\{[^}]*display:flex;[^}]*flex-direction:column;/);
  assert.match(pwaCss, /\.notification-prefs\s*\{[^}]*max-height:min\(245px,40dvh\);[^}]*overflow-y:auto;/);
  assert.match(pwaCss, /\.pwa-notification-list\s*\{[^}]*flex:1 1 160px;[^}]*overflow:auto;/);
  for (const icon of ['/ui/notification-volume-on.svg','/ui/notification-volume-off.svg','/ui/notification-settings.svg']) assert.ok(pwaSw.includes("'"+icon+"'"), icon+' missing from PWA shell');
});

test('notification control labels re-localize after language changes', () => {
  assert.match(app, /applyTranslations\(\);\s*updateNotificationsSoundBtn\(\);/);
  assert.match(pwaApp, /typeof updatePwaNotificationsSoundBtn === 'function'\) updatePwaNotificationsSoundBtn\(\)/);
  assert.match(pwaHtml, /id="pwa-notifications-prefs-btn"[^>]*data-i18n-title="notificationsPrefs"[^>]*data-i18n-aria="notificationsPrefs"/);
});

test('changed notification assets are cache-busted consistently', () => {
  assert.match(html, /\/style\.css\?v=286/);
  assert.match(html, /\/app\.js\?v=292/);
  assert.match(pwaHtml, /\/app\/app\.css\?v=274/);
  assert.match(pwaHtml, /\/app\/app\.js\?v=290/);
  assert.match(pwaSw, /'\/app\/app\.css\?v=274'/);
  assert.match(pwaSw, /'\/app\/app\.js\?v=290'/);
});
