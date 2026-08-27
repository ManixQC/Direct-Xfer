'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateTrackedUtf8, BINARY_EXTENSIONS } = require('../scripts/check-codacy-input-utf8');

test('Codacy UTF-8 preflight accepts UTF-8 source and skips known binary assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-codacy-utf8-'));
  fs.writeFileSync(path.join(dir, 'good.js'), 'const café = true;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));

  const result = validateTrackedUtf8(dir, ['good.js', 'icon.png']);
  assert.equal(result.invalid.length, 0);
  assert.equal(result.checked, 1);
  assert.equal(result.skippedBinary, 1);
  assert.ok(BINARY_EXTENSIONS.has('.png'));
  assert.ok(BINARY_EXTENSIONS.has('.ico'));
});

test('Codacy UTF-8 preflight reports malformed tracked text precisely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-codacy-utf8-bad-'));
  fs.writeFileSync(path.join(dir, 'bad.js'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xff]));

  const result = validateTrackedUtf8(dir, ['bad.js']);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].relative, 'bad.js');
});
