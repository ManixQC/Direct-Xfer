'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createWebauthnService } = require('../lib/server/webauthn-service');

function service() {
  return createWebauthnService({
    APP_NAME: 'Direct-Xfer',
    PUBLIC_URL: 'https://direct-xfer.invalid',
    crypto,
    getSession: () => null,
    getAccountById: () => null,
    pwaDevices: () => [],
    timingSafeEqualStr: (a, b) => String(a) === String(b),
  });
}

test('ASVS V6.3.8 phantom passkey credentials are shaped like a real account response', () => {
  const webauthn = service();
  const list = webauthn.phantomAllowCredentials('nobody');
  assert.ok(Array.isArray(list) && list.length >= 1, 'non-empty allowCredentials');
  for (const entry of list) {
    assert.equal(entry.type, 'public-key');
    assert.equal(typeof entry.id, 'string');
    // base64url credential id, indistinguishable from a real descriptor id.
    assert.match(entry.id, /^[A-Za-z0-9_-]+$/);
  }
});

test('ASVS V6.3.8 phantom credentials are deterministic per username and case-insensitive', () => {
  const webauthn = service();
  const a = webauthn.phantomAllowCredentials('Alice');
  const b = webauthn.phantomAllowCredentials('alice');
  const c = webauthn.phantomAllowCredentials('  ALICE ');
  const other = webauthn.phantomAllowCredentials('bob');
  assert.equal(a[0].id, b[0].id, 'same id regardless of case');
  assert.equal(a[0].id, c[0].id, 'same id regardless of surrounding whitespace');
  assert.notEqual(a[0].id, other[0].id, 'different usernames yield different ids');
});

test('ASVS V6.3.8 login options no longer leak passkey/account existence via 404', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'pwa-routes.js'), 'utf8');
  // The username-scoped login options endpoint must not return an enumerating
  // "passkey-unavailable" 404; unknown/keyless usernames fall through to a phantom
  // credential list and the same 200 response as a real eligible account.
  assert.doesNotMatch(routes, /passkey-unavailable/);
  assert.match(routes, /phantomAllowCredentials\(username\)/);
});
