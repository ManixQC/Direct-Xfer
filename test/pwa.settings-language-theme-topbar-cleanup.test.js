'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('language and theme controls live at the top of Settings, not in the topbar', () => {
  const html = read('pwa/index.html');
  const header = html.match(/<header class="topbar">([\s\S]*?)<\/header>/);
  assert.ok(header);
  assert.doesNotMatch(header[1], /id="lang-select"|id="theme-select"/);
  const appearance = html.indexOf('settings-appearance-card');
  const settings = html.indexOf('id="settings-card"');
  assert.ok(appearance > -1 && settings > appearance);
  assert.match(html.slice(appearance, settings), /id="lang-select"[\s\S]*id="theme-select"/);
  assert.doesNotMatch(html, /id="toggle-cards-btn"|cards-toggle-row|Tout déplier/);
  assert.doesNotMatch(read('pwa/app.js'), /toggleAllCards|updateToggleCardsLabel/);
});

test('topbar shows only the logo without Send or Paired device labels', () => {
  const html = read('pwa/index.html');
  const header = html.match(/<header class="topbar">([\s\S]*?)<\/header>/);
  assert.ok(header);
  assert.doesNotMatch(header[1], /data-i18n="title"|id="device-badge"|Appareil associé/);
  assert.match(header[1], /id="admin-home-link"[\s\S]*?\/app\/icon\.svg/);
});

test('PWA cache is advanced for the topbar/settings move', () => {
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa/index.html'), /app\.css\?v=274/);
});
