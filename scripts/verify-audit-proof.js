#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');

function keyId(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type:'spki', format:'der' })).digest('hex');
}
function entriesDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries || []) hash.update(JSON.stringify(entry) + '\n');
  return hash.digest('hex');
}
function payload(proof) {
  return JSON.stringify([
    Number(proof.proofVersion) || 0, String(proof.app || ''), String(proof.appVersion || ''),
    Number(proof.exportedAt) || 0, Number(proof.entryCount) || 0, String(proof.entriesSha256 || ''),
    Number(proof.head && proof.head.seq) || 0, String(proof.head && proof.head.hash || ''),
    String(proof.hmacKeyId || ''), String(proof.publicKeyId || ''),
  ]);
}
function verify(proof, options = {}) {
  try {
  if (!proof || proof.proofVersion !== 1 || proof.algorithm !== 'Ed25519' || !Array.isArray(proof.entries) || proof.entryCount !== proof.entries.length) return { ok:false, reason:'malformed-proof' };
  if (entriesDigest(proof.entries) !== proof.entriesSha256) return { ok:false, reason:'entry-digest-mismatch' };
  const publicKey = crypto.createPublicKey(String(proof.publicKey || ''));
  if (publicKey.asymmetricKeyType !== 'ed25519') return { ok:false, reason:'public-key-not-ed25519' };
  const actualKeyId = keyId(publicKey);
  if (actualKeyId !== proof.publicKeyId) return { ok:false, reason:'public-key-id-mismatch' };
  if (options.publicKeyId && String(options.publicKeyId).toLowerCase() !== actualKeyId) return { ok:false, reason:'untrusted-public-key' };
  if (options.publicKey) {
    const trusted = crypto.createPublicKey(String(options.publicKey));
    if (trusted.asymmetricKeyType !== 'ed25519' || keyId(trusted) !== actualKeyId) return { ok:false, reason:'untrusted-public-key' };
  }
  let previous = '', sequence = 0;
  for (const entry of proof.entries) {
    if (!entry || entry.seq !== sequence + 1 || String(entry.prevHash || '') !== previous || !/^[a-f0-9]{64}$/.test(String(entry.hash || ''))) {
      return { ok:false, reason:'chain-structure-invalid' };
    }
    sequence = entry.seq; previous = entry.hash;
  }
  if (Number(proof.head && proof.head.seq) !== sequence || String(proof.head && proof.head.hash || '') !== previous) return { ok:false, reason:'signed-head-mismatch' };
  const ok = crypto.verify(null, Buffer.from(payload(proof)), publicKey, Buffer.from(String(proof.signature || ''), 'base64'));
  return { ok, reason:ok ? null : 'signature-invalid', entries:proof.entries.length, keyId:proof.publicKeyId };
  } catch (error) {
    return { ok:false, reason:'unreadable-proof', error:error.message };
  }
}

if (require.main === module) {
  const filename = process.argv[2];
  const keyIdIndex = process.argv.indexOf('--key-id');
  const publicKeyIndex = process.argv.indexOf('--public-key');
  const allowEmbedded = process.argv.includes('--allow-embedded-key');
  if (!filename) { console.error('Usage: node scripts/verify-audit-proof.js <proof.json> (--key-id SHA256 | --public-key public.pem | --allow-embedded-key)'); process.exit(2); }
  try {
    const options = {};
    if (keyIdIndex >= 0) {
      options.publicKeyId = String(process.argv[keyIdIndex + 1] || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(options.publicKeyId)) throw new Error('invalid --key-id (expected 64 hexadecimal characters)');
    }
    if (publicKeyIndex >= 0) {
      const publicKeyFile = process.argv[publicKeyIndex + 1];
      if (!publicKeyFile) throw new Error('missing --public-key file');
      options.publicKey = fs.readFileSync(publicKeyFile, 'utf8');
    }
    if (!options.publicKeyId && !options.publicKey && !allowEmbedded) {
      throw new Error('a trusted --key-id or --public-key is required (use --allow-embedded-key only for integrity checks without identity validation)');
    }
    const result = verify(JSON.parse(fs.readFileSync(filename, 'utf8')), options);
    if (!result.ok) { console.error(`INVALID: ${result.reason}`); process.exit(1); }
    console.log(`VALID: ${result.entries} entries; Ed25519 key ${result.keyId}`);
  } catch (error) { console.error(`INVALID: ${error.message}`); process.exit(1); }
}

module.exports = { verify };
