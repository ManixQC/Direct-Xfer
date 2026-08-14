'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('PWA topbar no longer renders the Information bubble', () => {
  assert.doesNotMatch(read('pwa/index.html'), /id="help-btn"/);
  assert.doesNotMatch(read('pwa/app.css'), /#help-btn/);
  assert.doesNotMatch(read('pwa/app.js'), /\$\('help-btn'\)/);
});

test('keyboard and command-palette help remain available without a topbar button', () => {
  const app = read('pwa/app.js');
  assert.match(app, /e\.key === '\?'/);
  assert.match(app, /run:\s*openHelp/);
  assert.match(read('pwa/index.html'), /id="help-overlay"/);
});
