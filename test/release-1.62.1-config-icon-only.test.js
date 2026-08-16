'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('Partages Config trigger is icon-only but keeps an accessible translated name', () => {
  const match = html.match(/<button id="share-config-menu-btn"[\s\S]*?<\/button>/);
  assert.ok(match, 'Config trigger must exist');
  const button = match[0];
  assert.match(button, /<span aria-hidden="true">⚙<\/span>/);
  assert.match(button, /data-i18n-aria="sh\.actionConfig"/);
  assert.match(button, /data-i18n-title="sh\.actionConfig"/);
  assert.doesNotMatch(button, />\s*Config\s*</);
});
