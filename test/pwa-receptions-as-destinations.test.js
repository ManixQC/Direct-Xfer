'use strict';

// Every reception link the server reports for this device/account — including links
// created OUTSIDE the PWA (e.g. the admin web UI) — must be selectable from the first
// page's Destination picker, not only PWA-created ones. The picker merges a dedicated
// serverReceptions source (never persisted; local records win on token collisions).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'pwa', 'app.js'), 'utf8');

test('the Destination list merges server-reported reception links', () => {
  // A dedicated, non-persisted source holds the server's reception links.
  assert.match(app, /var serverReceptions = \[\];/);
  // allDests concatenates it AFTER the local sources so local records win on collisions.
  assert.match(app, /persistentDests\.concat\(sessionDests\)\.concat\(serverReceptions\)\.forEach/);
});

test('loadReceptions feeds the Destination picker from /app/receptions', () => {
  // The reception records are mapped onto the destination shape (no key, not remembered).
  assert.match(app, /function receptionAsDest\(s\)/);
  assert.match(app, /remembered: false, owned: s\.owned !== false/);
  // loadReceptions populates serverReceptions and re-renders the picker.
  assert.match(app, /serverReceptions = list\.map\(receptionAsDest\);\s*renderDests\(\);/);
});

test('reception links are loaded at startup without visiting the Partages tab', () => {
  assert.match(app, /loadReceptions\(\)\s*\/\/ list ALL reception links/);
});

test('removing or clearing a destination also drops the server-reported copy', () => {
  // A just-revoked link must vanish immediately, not linger until the next refresh.
  assert.match(app, /serverReceptions = serverReceptions\.filter\(function \(d\) \{ return d\.token !== token; \}\);/);
  // A full local-data wipe resets the server-reception source too.
  assert.match(app, /persistentDests = \[\]; sessionDests = \[\]; serverReceptions = \[\];/);
});
