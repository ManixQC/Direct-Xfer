'use strict';

// Compatibility shim retained so overlay-style upgrades from 1.59.0 do not leave
// a stale regression file that asserts the previous release identifiers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('1.59.0 ultra-audit regression file is superseded by the 1.59.8 suite', () => {
  assert.equal(fs.existsSync(path.join(root, 'test', 'recent-changes-ultra-audit-1.59.8.test.js')), true);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.59.8');
});
