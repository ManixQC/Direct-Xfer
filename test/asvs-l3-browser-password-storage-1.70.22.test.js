'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

for (const relative of ['public/login-vault.js', 'pwa/login-vault.js']) {
  test(`ASVS V14.3.3 ${relative} cannot persist reusable passwords`, () => {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /indexedDB\.open\s*\(/);
    assert.doesNotMatch(source, /subtle\.encrypt\s*\(/);
    assert.doesNotMatch(source, /password\s*:\s*password/);
    assert.match(source, /deleteDatabase\s*\(DB_NAME\)/);
    assert.match(source, /function available\(\) \{ return false; \}/);
    assert.match(source, /async function load\(\) \{ await purgeLegacyVault\(\); return null; \}/);
  });
}

test('ASVS V14.3.3 PWA remember-password control is retired', () => {
  const html = fs.readFileSync(path.join(root, 'pwa/login.html'), 'utf8');
  assert.match(html, /id="mobile-remember-password"[^>]*disabled/);
  assert.match(html, /class="mobile-login-check hidden"[^>]*aria-hidden="true"/);
  assert.match(html, /login-vault\.js\?v=443/);
});
