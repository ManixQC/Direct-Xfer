'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebauthnService } = require('../lib/server/webauthn-service');

function serviceWithRsaBits(bits) {
  const crypto = {
    createPublicKey() {
      return { asymmetricKeyType:'rsa', asymmetricKeyDetails:{ modulusLength:bits } };
    },
    verify() { return true; },
  };
  return createWebauthnService({
    APP_NAME:'Direct-Xfer',
    PUBLIC_URL:'https://direct-xfer.invalid',
    crypto,
    getSession:() => null,
    getAccountById:() => null,
    pwaDevices:() => [],
    timingSafeEqualStr:(a, b) => String(a) === String(b),
  });
}

test('ASVS V11.2.3 rejects RSA-2048 WebAuthn credentials', () => {
  const webauthn = serviceWithRsaBits(2048);
  assert.equal(webauthn.MIN_RSA_MODULUS_BITS, 3072);
  assert.throws(
    () => webauthn.webauthnPublicKey({ kty:'RSA', n:'x', e:'AQAB' }, -257),
    /rsa-key-too-small/,
  );
});

test('ASVS V11.2.3 accepts RSA-3072 WebAuthn credentials', () => {
  const webauthn = serviceWithRsaBits(3072);
  const key = webauthn.webauthnPublicKey({ kty:'RSA', n:'x', e:'AQAB' }, -257);
  assert.equal(key.asymmetricKeyDetails.modulusLength, 3072);
});
