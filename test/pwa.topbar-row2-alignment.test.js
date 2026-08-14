'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');

test('PWA topbar no longer owns language/theme controls', () => {
  const topbar = html.match(/<header class=\"topbar\">([\s\S]*?)<\/header>/);
  assert.ok(topbar);
  assert.doesNotMatch(topbar[1], /id=\"lang-select\"/);
  assert.doesNotMatch(topbar[1], /id=\"theme-select\"/);
  assert.match(html, /class=\"card settings-appearance-card\" data-pwa-panel=\"settings\"[\s\S]*?id=\"lang-select\"[\s\S]*?id=\"theme-select\"/);
});

test('mobile notification stays on row 1 and transient install uses row 2', () => {
  assert.match(css, /@media \(max-width:560px\)[\s\S]*?\.pwa-notifications-menu\s*\{[^}]*grid-column:\s*4;[^}]*grid-row:\s*1;/s);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*?#install-btn\s*\{[^}]*grid-column:\s*4;[^}]*grid-row:\s*2;/s);
});
