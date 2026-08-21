'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const launcher = fs.readFileSync(path.join(__dirname, '..', 'windows-launcher', 'Program.cs'), 'utf8');

test('systray quit command is concise in every supported language', () => {
  assert.match(launcher, /Language = "Langue", Stop = "Quitter"/);
  assert.match(launcher, /Language = "Idioma", Stop = "Salir"/);
  assert.match(launcher, /Language = "Language", Stop = "Exit"/);
  assert.doesNotMatch(launcher, /Quitter la systray|Salir de la bandeja|Exit tray/);
});
