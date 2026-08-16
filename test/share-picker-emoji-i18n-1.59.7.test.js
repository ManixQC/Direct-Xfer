'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('pk.emoji is translated in all supported admin languages', () => {
  const app = read('public', 'app.js');
  assert.match(app, /'pk\.emoji': 'Emoji du lien \(facultatif\)'/);
  assert.match(app, /'pk\.emoji': 'Link emoji \(optional\)'/);
  assert.match(app, /'pk\.emoji': 'Emoji del enlace \(opcional\)'/);
});


test('every pk.* key used by the share picker has FR/EN/ES translations', () => {
  const html = read('public', 'index.html');
  const app = read('public', 'app.js');
  const keys = [...new Set([...html.matchAll(/data-i18n(?:-title|-placeholder)?="(pk\.[^"]+)"/g)].map(m => m[1]))];
  assert.ok(keys.length >= 20, 'expected the share picker translation surface to be covered');
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const definitions = app.match(new RegExp(`["']${escaped}["']\\s*:`, 'g')) || [];
    assert.equal(definitions.length, 3, `${key} must be defined once in FR, EN and ES`);
  }
});

test('create and edit share forms still use pk.emoji instead of a hardcoded label', () => {
  const html = read('public', 'index.html');
  const uses = html.match(/data-i18n="pk\.emoji"/g) || [];
  assert.equal(uses.length, 2);
  assert.match(html, /id="opt-emoji"/);
  assert.match(html, /id="edit-emoji"/);
});

test('1.63.4 admin script is cache-busted after translation update', () => {
  const html = read('public', 'index.html');
  assert.match(html, /<script src="\/app\.js\?v=297"><\/script>/);
});
