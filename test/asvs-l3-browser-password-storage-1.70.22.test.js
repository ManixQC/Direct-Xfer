'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

for (const relative of ['public/login-vault.js', 'pwa/login-vault.js']) {
  test(`ASVS V14.3.3 ${relative} fails closed when reusable password storage is not permitted`, () => {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /fetch\('\/api\/meta'/);
    assert.match(source, /meta\.loginPasswordStorageAllowed === true/);
    assert.match(source, /if \(!result\.allowed\) await deleteDatabase\(\)/);
    assert.match(source, /if \(!policy\.available \|\| !policy\.allowed\) return false;/);
    assert.match(source, /if \(!policy\.available \|\| !policy\.allowed\) return null;/);
    // Encryption is permitted only in the normal-profile branch after the
    // server-authoritative policy check; no reusable plaintext is persisted.
    assert.match(source, /AES-GCM/);
    assert.doesNotMatch(source, /localStorage|sessionStorage/);
  });
}

test('ASVS V14.3.3 login controls start fail-closed before server policy is known', () => {
  const pwaHtml = fs.readFileSync(path.join(root, 'pwa', 'login.html'), 'utf8');
  const publicHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(pwaHtml, /id="mobile-remember-password"[^>]*disabled/);
  assert.match(pwaHtml, /id="mobile-remember-password-row"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(publicHtml, /id="remember-password"[^>]*disabled/);
  assert.match(publicHtml, /id="remember-password-row"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(pwaHtml, /login-vault\.js\?v=486/);
});
