'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const source = read('lib/server/account-service.js');

test('account bootstrap warnings never log environment-derived values or exception messages', () => {
  assert.match(source, /const ACCOUNT_WARNINGS = Object\.freeze\(\{/);
  assert.match(source, /function warn\(code\) \{[\s\S]*?Object\.hasOwn\(ACCOUNT_WARNINGS, code\)[\s\S]*?logger\.warn\(message\)/);
  assert.doesNotMatch(source, /logger\.warn\(code\)/);
  assert.doesNotMatch(source, /logger\.warn\([^\n]*error/);
  assert.doesNotMatch(source, /error\s*&&\s*error\.message/);
  assert.doesNotMatch(source, /warn\([^\n]*,\s*username\s*\)/);
  assert.doesNotMatch(source, /warn\([^\n]*,\s*error\s*\)/);
});

test('keeps account warning call sites restricted to the fixed catalogue', () => {
  const allowed = new Set(['predictableLegacyOwner', 'legacyPasswordRead', 'legacyPasswordRemove', 'bootstrapPersist']);
  const calls = source.split(/\r?\n/)
    .filter((line) => /\bwarn\(/.test(line) && !/logger\.warn/.test(line) && !/function warn\(/.test(line))
    .map((line) => line.match(/\bwarn\('([^']+)'\);/))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(calls.length >= 4, 'expected account warning call sites');
  for (const code of calls) assert.ok(allowed.has(code), `unexpected account warning code: ${code}`);
});
