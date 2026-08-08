'use strict';

// The "resize the Mini (from the Full)" action must exist in both the standard
// admin and the PWA: a per-image control that regenerates the Mini at a chosen
// size from the full image and keeps the Micro at half the Mini, on-device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pub = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('standard admin exposes a "resize Mini" action wired to the photo card', () => {
  assert.match(pub, /async function resizePhotoMini\(s\)/);
  // Regenerates from the full image, uploads Mini + Micro, Micro = half the Mini.
  assert.match(pub, /'\/i\/' \+ s\.token/);
  assert.match(pub, /\/api\/photos\/' \+ encodeURIComponent\(s\.id\) \+ '\/' \+ variant/);
  assert.match(pub, /micro:\s*\[Math\.max\(1, Math\.round\(tw \/ 2\)\)/);
  // Offers a choice: max longest-side in pixels OR a percentage of the full size.
  assert.match(pub, /const isPercent = \/%\\s\*\$\/\.test\(raw\)/);
  assert.match(pub, /Math\.round\(w \* num \/ 100\)/);
  // Button on the card + translation in all three languages.
  assert.match(pub, /resizePhotoMini\(s\)/);
  assert.match(pub, /'photo\.resizeMini':\s*'Redimensionner la Mini'/);
  assert.match(pub, /'photo\.resizeMini':\s*'Resize the Mini'/);
  assert.match(pub, /'photo\.resizeMini':\s*'Redimensionar la Mini'/);
});

test('PWA exposes a "resize Mini" action on each image row', () => {
  assert.match(pwa, /async function resizeImageMini\(photo\)/);
  // Fetches the full through the authenticated owner preview, uploads Mini + Micro.
  assert.match(pwa, /\/app\/image\/' \+ encodeURIComponent\(photo\.token\) \+ '\/preview\/full/);
  assert.match(pwa, /\/app\/image\/' \+ encodeURIComponent\(photo\.token\) \+ '\/thumb/);
  assert.match(pwa, /\/app\/image\/' \+ encodeURIComponent\(photo\.token\) \+ '\/micro/);
  assert.match(pwa, /Math\.round\(tw \/ 2\)/);
  // Offers a choice: max longest-side in pixels OR a percentage of the full size.
  assert.match(pwa, /var isPercent = \/%\\s\*\$\/\.test\(raw\)/);
  assert.match(pwa, /Math\.round\(w \* num \/ 100\)/);
  // Button in the row template, wired, and disabled for inactive images.
  assert.match(pwa, /class="btn ghost sm il-resize-mini"/);
  assert.match(pwa, /resizeMiniBtn\.addEventListener\('click'/);
  assert.match(pwa, /'\.il-versions', '\.il-resize-mini'/);
  assert.match(pwa, /imgResizeMini: 'Redimensionner la Mini'/);
  assert.match(pwa, /imgResizeMini: 'Resize the Mini'/);
  assert.match(pwa, /imgResizeMini: 'Redimensionar la Mini'/);
});

test('the PWA bottom navigation lays its five tabs out on a single row', () => {
  const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
  // Five nav items: send, images, shares, activity, settings.
  const navItems = (html.match(/data-pwa-nav="/g) || []).length;
  assert.equal(navItems, 5, 'the bottom nav must declare five tabs');
  // The grid must have exactly five columns so none wrap to a second row.
  assert.match(css, /\.pwa-bottom-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  // The five icons must render at an identical size. Text glyphs from different Unicode
  // blocks (and color emoji) vary in size, so each icon must be an inline SVG drawn on
  // the SAME 24×24 grid — one CSS box size then controls all five uniformly.
  const navIcons = [...html.matchAll(/<span class="pwa-nav-icon"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  assert.equal(navIcons.length, 5, 'each nav item must carry one icon span');
  for (const icon of navIcons) {
    assert.match(icon, /<svg[^>]*viewBox="0 0 24 24"/, 'nav icon must be a 24×24 inline SVG');
    assert.doesNotMatch(icon, /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u, 'nav icon must be monochrome, not a color emoji');
  }
  // A single shared box size drives every icon (no per-item sizing that could diverge).
  assert.match(css, /\.pwa-nav-item \.pwa-nav-icon svg \{[^}]*width: 22px; height: 22px;/);
});
