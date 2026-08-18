'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'test-historical', 'MANIFEST.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const restorer = fs.readFileSync(path.join(root, 'scripts', 'restore-historical-tests.js'), 'utf8');

test('historical test manifest preserves the complete reference test tree', () => {
  assert.equal(manifest.repository, 'ManixQC/Direct-Xfer');
  assert.equal(manifest.sourceCommit, '2bda57280908b8b9ec8b3bc6d591438c3a5b0295');
  assert.equal(manifest.sourceTestTree, '4495f102596386007a8776f11f401163b25203c7');
  assert.equal(manifest.count, 326);
  assert.equal(manifest.tests.length, 326);
  assert.equal(new Set(manifest.tests.map(x => x.path)).size, 326);
  assert.equal(new Set(manifest.tests.map(x => x.sha)).size, 287);
  for (const entry of manifest.tests) {
    assert.match(entry.path, /(?:\.test\.js|\.integration\.test\.js)$/);
    assert.match(entry.sha, /^[0-9a-f]{40}$/);
  }
});

test('historical test restorer verifies Git blob integrity before writing', () => {
  assert.match(restorer, /raw\.githubusercontent\.com/);
  assert.match(restorer, /blob \$\{buf\.length\}\\0/);
  assert.match(restorer, /SHA mismatch/);
  assert.match(restorer, /Post-write SHA mismatch/);
  assert.match(restorer, /atomicWrite/);
});

test('default test command remains scoped to current 1.66.3 tests', () => {
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.equal(packageJson.scripts['test:historical:restore'], 'node scripts/restore-historical-tests.js');
  assert.equal(packageJson.scripts['test:historical'], 'node --test test-historical/*.test.js');
});
