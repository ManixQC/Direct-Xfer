'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('tablet image variant actions use a fixed 2x2 block and cannot overlap resolution text', () => {
  assert.match(css, /@media \(min-width: 721px\) and \(max-width: 1400px\) \{[\s\S]*?\.imgvariant \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 74px;[\s\S]*?\.imgvariant \.iv-actions \{[\s\S]*?width: 74px;[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(2, 34px\);[\s\S]*?grid-auto-rows: 34px;/s);
});
