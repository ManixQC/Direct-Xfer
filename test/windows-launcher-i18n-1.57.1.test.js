'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');

test('Windows launcher native menus support all Direct-Xfer languages', () => {
  assert.match(src, /case "fr":/);
  assert.match(src, /case "es":/);
  assert.match(src, /default:/);
  assert.match(src, /Ouvrir Direct-Xfer/);
  assert.match(src, /Open Direct-Xfer/);
  assert.match(src, /Abrir Direct-Xfer/);
  assert.match(src, /Français/);
  assert.match(src, /English/);
  assert.match(src, /Español/);
  assert.match(src, /DetectLanguage\(\)/);
  assert.match(src, /public string language/);
});
