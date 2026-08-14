'use strict';

// Static guards for the cut-off "easy" pack finished in this pass:
//   #6  per-link emoji marker actually rendered in the admin list (not just stored)
//   #7  hover tooltips "créé il y a X" / "expire dans X" on the share cards
//   #8  compact/comfortable density toggle for the admin links table
//   #14 one-click +30 j expiry extension (spec asked for +7 j / +30 j)
// These pin the client wiring so a refactor can't silently drop the display half
// again (the emoji was stored + round-tripped but never shown before this pass).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

test('#6 the custom link emoji is rendered in the admin card, not only captured', () => {
  // Input + edit repopulation must exist (capture half).
  for (const id of ['opt-emoji', 'edit-emoji']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing input #${id}`);
  }
  assert.match(app, /emoji: \$\('opt-emoji'\)/, 'create payload must send emoji');
  assert.match(app, /\$\('edit-emoji'\)\.value = s\.emoji/, 'edit form must repopulate emoji');
  // Display half — the headline icon must fall back to the type glyph and prefer
  // the custom emoji when one is set. This is the part that was missing.
  assert.match(app, /text: s\.emoji \|\| typeIco/, 'card icon must use s.emoji when set');
  assert.match(app, /icoSpan\.setAttribute\('title', t\('sh\.emojiTip'\)\)/);
});

test('#7 created/expires cards expose relative-time hover tooltips', () => {
  assert.match(app, /function timeUntil\(ts\)/, 'timeUntil() helper must exist');
  // Created span: "Créé il y a X" via timeAgo().
  assert.match(app, /title: t\('sh\.createdTip', \{ v: timeAgo\(s\.createdAt\) \}\)/);
  // Expires span: day-aware "expire dans X" via timeUntil() (NOT formatDuration,
  // which caps at minutes and would print a huge count for a multi-day expiry),
  // and "expiré" when the deadline is already past.
  assert.match(app, /t\('sh\.expiresIn', \{ v: timeUntil\(s\.effectiveExpiresAt\) \}\)/);
  assert.match(app, /s\.effectiveExpiresAt <= Date\.now\(\) \? t\('sh\.expired'\)/);
});

test('#8 admin-table density toggle is fully wired (button, state, persistence, css)', () => {
  assert.match(html, /id="shares-density-toggle"/, 'density toggle button missing');
  assert.match(app, /function setShareDensity\(density/, 'setShareDensity() missing');
  assert.match(app, /shareDensity: 'comfortable'/, 'uiPrefs default missing');
  assert.match(app, /shareDensity: uiPrefChoice\('shareDensity', \['comfortable', 'compact'\]/, 'state init missing');
  assert.match(app, /'shares-density-toggle'\)\.addEventListener\('click'/, 'click wiring missing');
  assert.match(app, /setShareDensity\(state\.shareDensity, false\)/, 'not applied on init');
  // Persisted so the choice survives a reload, like the list/grid view.
  assert.match(app, /updateUiPrefs\(\{ shareDensity: state\.shareDensity \}\)/);
  // CSS actually tightens the cards + styles the active button.
  assert.match(css, /\.shares-list\.density-compact \.share \{/, 'compact card padding rule missing');
  assert.match(css, /\.density-toggle\.active \{/, 'active button style missing');
});

test('#14 one-click +30 j extension is offered alongside +7 j', () => {
  assert.match(app, /text: t\('sh\.extend7d'\)/);
  assert.match(app, /text: t\('sh\.extend30d'\)/);
  assert.match(app, /extendShare\(s, 2592000\)/, '+30 d must extend by 30 days');
});

test('new i18n keys exist in all three admin languages', () => {
  for (const key of ['sh.createdTip', 'sh.emojiTip', 'sh.densityTip', 'sh.extend30d']) {
    const count = (app.match(new RegExp("'" + key.replace('.', '\\.') + "':", 'g')) || []).length;
    assert.ok(count >= 3, `i18n key ${key} should be in fr/en/es (found ${count})`);
  }
});
