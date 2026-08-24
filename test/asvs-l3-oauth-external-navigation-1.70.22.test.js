'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'oauth-bridge.js'), 'utf8');

test('ASVS V3.7.3 requires confirmation before external OAuth navigation', () => {
  const goStart = source.indexOf('function go(url)');
  const pollStart = source.indexOf('async function poll()', goStart);
  assert.ok(goStart >= 0 && pollStart > goStart);
  const go = source.slice(goStart, pollStart);
  assert.match(go, /parsed\.origin !== location\.origin/);
  assert.match(go, /window\.confirm\(prompt\)/);
  assert.match(go, /if \(!window\.confirm\(prompt\)\).*return/s);
  assert.ok(go.indexOf('window.confirm(prompt)') < go.indexOf('location.replace(parsed.href)'));
});
