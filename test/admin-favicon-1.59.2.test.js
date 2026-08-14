'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('admin interface exposes the round Direct-Xfer logo as browser favicon', () => {
  const html = read('public', 'index.html');
  const favicon = path.join(root, 'public', 'favicon.png');
  const pwaIcon = path.join(root, 'pwa', 'icon-192.png');
  assert.match(html, /<link rel="icon" href="\/favicon\.png\?v=267" type="image\/png" sizes="192x192" \/>/);
  assert.equal(fs.existsSync(favicon), true);
  assert.deepEqual(fs.readFileSync(favicon), fs.readFileSync(pwaIcon));
});
