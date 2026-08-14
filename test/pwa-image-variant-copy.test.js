'use strict';

// Each image variant row (Full / Mini / Micro) exposes, next to its "view" (eye) button,
// two copy actions: "copy link" (in the selected format) and "copy BBCode". Full
// uses [img]…[/img], while Mini/Micro are clickable thumbnails that redirect to Full.
// Copy-link reuses copyOne(kind); BBCode uses the shared imageVariantBBCode helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('each variant row pairs a copy-link button with the view button', () => {
  // A shared action cluster wraps the buttons in every variant line.
  assert.match(js, /<span class="iv-actions">/);
  assert.match(js, /<button class="iv-copy" type="button">' \+ ICONS\.link \+ '<\/button>/);
  // The copy-link button is emitted three times — one per variant (full, thumb, micro).
  const copyButtons = (js.match(/<button class="iv-copy" type="button">/g) || []).length;
  assert.equal(copyButtons, 3, 'full, thumb and micro must each carry a copy-link button');
  // A dedicated link glyph exists for the button.
  assert.match(js, /link: dxIcon\(/);
});

test('the copy-link button reuses the shared copyOne(kind) behaviour', () => {
  assert.match(js, /var copyVariant = line\.querySelector\('\.iv-copy'\);\s*if \(copyVariant\) copyVariant\.addEventListener\('click', copyOne\(kind\)\);/);
});

test('each variant row also carries a "BB" copy-BBCode button', () => {
  const bbButtons = (js.match(/<button class="iv-bb" type="button">BB<\/button>/g) || []).length;
  assert.equal(bbButtons, 3, 'full, thumb and micro must each carry a BBCode button');
});

test('the BBCode button uses clickable Mini/Micro thumbnails that redirect to Full', () => {
  assert.match(js, /function imageVariantBBCode\(photo, kind, url\)/);
  assert.match(js, /\(kind === 'thumb' \|\| kind === 'micro'\).*return '\[url=' \+ fullUrl \+ '\]\[img\]' \+ variantUrl \+ '\[\/img\]\[\/url\]'/s);
  assert.match(js, /return '\[img\]' \+ variantUrl \+ '\[\/img\]';/);
  assert.match(js, /copyText\(imageVariantBBCode\(photo, kind, url\)\)/);
  assert.match(js, /var bbVariant = line\.querySelector\('\.iv-bb'\);\s*if \(bbVariant\) bbVariant\.addEventListener\('click', copyBB\(kind\)\);/);
});

test('both copy buttons are labelled and gated exactly like the view button', () => {
  assert.match(js, /copyVariant\.title = t\('copyLink'\) \+ ' — ' \+ imageVariantLabel\(kind\)/);
  assert.match(js, /bbVariant\.title = t\('imgCopyBBCode'\) \+ ' — ' \+ imageVariantLabel\(kind\)/);
  // Open and both copies share one "usable only when ready and still active" gate.
  assert.match(js, /var canUse = photo\.active !== false && variant\.ready !== false && !!imageVariantUrl\(photo, kind\)/);
  assert.match(js, /copyVariant\.disabled = !canUse/);
  assert.match(js, /bbVariant\.disabled = !canUse/);
});

test('the copy-BBCode label is translated in all three languages', () => {
  assert.match(js, /imgCopyBBCode: 'Copier le BBCode'/);
  assert.match(js, /imgCopyBBCode: 'Copy BBCode'/);
  assert.match(js, /imgCopyBBCode: 'Copiar BBCode'/);
});

test('the copy buttons are styled to match the view button', () => {
  assert.match(css, /\.imgvariant \.iv-actions \{[^}]*display: inline-flex/);
  assert.match(css, /\.imgvariant \.iv-open,\s*\.imgvariant \.iv-copy,\s*\.imgvariant \.iv-bb,\s*\.imgvariant \.iv-img \{[^}]*width: 34px; height: 34px/);
  assert.match(css, /\.imgvariant \.iv-bb \{[^}]*font-weight: 800/);
  assert.match(css, /\.iv-open svg, \.iv-copy svg, \.iv-img svg \{/);
});
