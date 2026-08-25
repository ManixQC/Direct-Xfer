'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tls = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'tls-manager.js'), 'utf8');

test('ASVS V11.2.3 managed Local-CA leaf certificates are generated at RSA-3072', () => {
  // The issued server (leaf) certificate key must provide ~128-bit strength.
  assert.match(tls, /const keys = generateForgeRsaKeyPair\(3072\), cert = forge\.pki\.createCertificate\(\)/);
  // The default key size for the managed RSA generator is also 3072-strong.
  assert.match(tls, /function generateForgeRsaKeyPair\(bits=3072\)/);
  // No leaf/server certificate is generated at the old 2048-bit strength.
  assert.doesNotMatch(tls, /generateForgeRsaKeyPair\(2048\)/);
});

test('ASVS V11.2.3 leaf validation rejects sub-3072 keys so legacy 2048 leaves regenerate', () => {
  assert.match(tls, /if \(rsaPublicKeyBits\(cert\.publicKey\) < 3072\) throw new Error\('server certificate RSA key is weaker than 3072 bits'\)/);
  // The Local CA itself is issued at 3072 (its trust anchor is not silently rotated,
  // so its acceptance floor stays at 2048 for already-installed legacy CAs).
  assert.match(tls, /const keys = generateForgeRsaKeyPair\(3072\);/);
});
