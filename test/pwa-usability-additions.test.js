'use strict';

// Batch of usability additions (suggestions 1–10, minus #6):
//  #1 relative timestamps in history · #2 clear-search buttons · #3 empty states ·
//  #4 per-destination emoji · #5 copy-image bitmap · #7 keyboard 1–5 tabs ·
//  #8 password-strength meter · #9 resend-from-history · #10 variant comparison.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');

test('#1 history rows show relative time via the existing fmtRelative helper', () => {
  assert.match(js, /t\('historyDest', \{ dest: h\.destination \}\) \+ ' · ' \+ fmtRelative\(h\.at\)/);
});

test('#2 both search fields have a clear (✕) button wired to reset + refilter', () => {
  assert.match(html, /id="img-search-clear"/);
  assert.match(html, /id="queue-search-clear"/);
  assert.match(js, /function wireClearButton\(inputId, clearId, onClear\)/);
  assert.match(js, /wireClearButton\('img-search', 'img-search-clear', applyImageView\)/);
  assert.match(js, /wireClearButton\('queue-search', 'queue-search-clear'/);
  // The queue filter now hides/shows via its wrapper so the ✕ hides with it.
  assert.match(js, /\$\('queue-search-wrap'\)\.classList\.toggle\('hidden'/);
});

test('#3 images and destinations have empty-state messages', () => {
  assert.match(html, /id="imglink-empty"/);
  assert.match(html, /id="dest-empty-hint"/);
  // Images distinguish "none at all" from "none match".
  assert.match(js, /imageRecordsByToken\.size === 0 \? t\('imgListEmpty'\) : \(rows\.length === 0 \? t\('imgNoMatch'\)/);
  assert.match(js, /\$\('dest-empty-hint'\)\.classList\.toggle\('hidden', !!list\.length\)/);
  for (const key of [/imgListEmpty: '/, /imgNoMatch: '/, /destEmptyHint: '/]) assert.match(js, key);
});

test('#4 destinations carry an optional emoji shown in the picker', () => {
  assert.match(html, /id="dest-emoji"/);
  assert.match(js, /emoji: String\(\(\$\('dest-emoji'\) && \$\('dest-emoji'\)\.value\) \|\| ''\)\.trim\(\)\.slice\(0, 8\)/);
  assert.match(js, /\(d\.emoji \? d\.emoji \+ ' ' : ''\) \+ \(d\.pinned/);
});

test('#5 each variant can copy its bitmap to the clipboard', () => {
  assert.match(js, /clipboard: dxIcon\(/);
  assert.match(js, /class="iv-img"/);
  assert.match(js, /async function copyImageToClipboard\(url\)/);
  assert.match(js, /new ClipboardItem\(\{ 'image\/png': png \}\)/);
  assert.match(js, /function copyImageBitmap\(kind\)/);
  assert.match(js, /if \(imgBtn\) imgBtn\.addEventListener\('click', copyImageBitmap\(kind\)\)/);
  // Hidden where the Clipboard image API is unavailable.
  assert.match(js, /imgBtn\.classList\.toggle\('hidden', !\(window\.ClipboardItem && navigator\.clipboard\)\)/);
});

test('#7 number keys 1–5 jump to the matching nav panel', () => {
  assert.match(js, /\/\^\[1-5\]\$\/\.test\(e\.key\)/);
  assert.match(js, /activatePwaPanel\(\['send', 'images', 'shares', 'activity', 'settings'\]\[Number\(e\.key\) - 1\]\)/);
});

test('#8 link-password fields show a strength meter', () => {
  assert.match(html, /id="img-password-strength"/);
  assert.match(html, /id="share-password-strength"/);
  assert.match(js, /function passwordScore\(v\)/);
  assert.match(js, /function attachPwStrength\(inputId, meterId\)/);
  assert.match(js, /attachPwStrength\('img-password', 'img-password-strength'\)/);
  assert.match(css, /\.pw-strength \{/);
  for (const key of [/pwWeak: '/, /pwMedium: '/, /pwStrong: '/]) assert.match(js, key);
});

test('#9 history entries can be resent to their destination', () => {
  // The destination token is stored so the target can be re-selected.
  assert.match(js, /destination: it\.snapshot\.name, destToken: it\.snapshot\.token/);
  assert.match(js, /function resendFromHistory\(h\)/);
  // Falls back to matching a saved destination by name for older entries.
  assert.match(js, /allDests\(\)\.find\(function \(d\) \{ return \(d\.name \|\| ''\) === h\.destination; \}\)/);
  assert.match(js, /resend\.addEventListener\('click', function \(\) \{ resendFromHistory\(h\); \}\)/);
});

test('#10 an overlay compares the three variants side by side', () => {
  assert.match(html, /id="compare-overlay"/);
  assert.match(html, /id="compare-grid"/);
  assert.match(js, /function openVariantCompare\(photo\)/);
  assert.match(js, /function closeCompare\(\)/);
  assert.match(js, /class="btn ghost sm il-compare"/);
  assert.match(js, /openVariantCompare\(imageRecordsByToken\.get\(data\.token\) \|\| data\)/);
  // Dismissible via Escape and the Android back button.
  assert.match(js, /else if \(!\$\('compare-overlay'\)\.classList\.contains\('hidden'\)\) closeCompare\(\)/);
  assert.match(js, /\['compare-overlay', closeCompare\]/);
  assert.match(css, /\.compare-grid \{/);
});
