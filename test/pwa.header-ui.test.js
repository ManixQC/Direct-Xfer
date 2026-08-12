'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('PWA header logo is doubled to 68 pixels without losing the admin link', () => {
  assert.match(html, /id="admin-home-link"[^>]+href="\/"/);
  assert.match(html, /<img[^>]+src="\/app\/icon\.svg"[^>]+width="68"[^>]+height="68"/);
  assert.match(css, /\.admin-home-link img\s*\{[^}]*width:\s*68px;[^}]*height:\s*68px;/s);
});

test('mobile install action remains accessible below the compact topbar', () => {
  assert.match(html, /id="install-btn"[^>]+data-i18n-title="install"[^>]+data-i18n-aria="install"/);
  assert.match(html, /class="install-logo-mark"[\s\S]*?<img[^>]+src="\/app\/icon\.svg"[\s\S]*?class="install-logo-badge">⇩<\/span>/);
  assert.match(html, /class="sr-only" data-i18n="install">Installer<\/span>/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*?#install-btn\s*\{[^}]*grid-column:\s*4;[^}]*grid-row:\s*2;/);
  assert.match(css, /#install-btn:not\(\.hidden\)\s*\{[^}]*display:\s*inline-grid;[^}]*box-shadow:[^}]*animation:\s*install-attention/s);
});
