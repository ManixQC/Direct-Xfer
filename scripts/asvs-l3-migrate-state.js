'use strict';

// Offline one-shot migration for Direct-Xfer <=1.70.25 L3 stores. It decrypts
// the legacy local DATA_KEY envelope (dxenc:1) and immediately re-encrypts the
// exact JSON payload with the isolated provider (dxenc:2). Do not run while the
// Direct-Xfer server is writing the same DATA_DIR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExternalCryptoProvider } = require('../lib/server/external-crypto-provider');

const SCRYPT_OPTIONS = Object.freeze({ N:16384, r:8, p:1, maxmem:64 * 1024 * 1024 });

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const storeFile = path.resolve(process.argv[2] || path.join(process.env.DATA_DIR || '/data', 'shares.json'));
const legacyKey = String(process.env.ASVS_L3_LEGACY_DATA_KEY || process.env.DATA_KEY || '');
const providerCommand = String(process.env.ASVS_L3_CRYPTO_COMMAND || '').trim();
if (!legacyKey) fail('ASVS_L3_LEGACY_DATA_KEY (or DATA_KEY for this offline command only) is required.');
if (!providerCommand) fail('ASVS_L3_CRYPTO_COMMAND is required.');

let raw;
try {
  const stat = fs.lstatSync(storeFile);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('The state path must be a regular non-symlink file.');
  if (stat.size <= 0 || stat.size > 256 * 1024 * 1024) fail('The state file has an invalid size.');
  raw = fs.readFileSync(storeFile, 'utf8');
} catch (error) {
  fail(`Could not read ${storeFile}: ${error.message}`);
}

let envelope;
try { envelope = JSON.parse(raw); }
catch (_) { fail('The state file is not valid JSON.'); }
if (envelope && envelope.dxenc === 2) {
  console.log('State is already using external encryption (dxenc:2); no migration needed.');
  process.exit(0);
}
if (!envelope || envelope.dxenc !== 1) fail('Expected a legacy encrypted Direct-Xfer state envelope (dxenc:1).');
if (!/^[a-f0-9]{32}$/i.test(String(envelope.salt || '')) || !/^[a-f0-9]{24}$/i.test(String(envelope.iv || '')) || !/^[a-f0-9]{32}$/i.test(String(envelope.tag || '')) || typeof envelope.data !== 'string') {
  fail('The legacy state encryption envelope is malformed.');
}

let plaintext;
try {
  const salt = Buffer.from(envelope.salt, 'hex');
  const key = crypto.scryptSync(legacyKey, salt, 32, SCRYPT_OPTIONS);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  } finally {
    key.fill(0);
  }
} catch (_) {
  fail('Legacy DATA_KEY is invalid or the state envelope failed authentication.');
}

try {
  const parsed = JSON.parse(plaintext.toString('utf8'));
  if (!parsed || !Array.isArray(parsed.shares)) throw new Error('missing shares[]');
} catch (error) {
  plaintext.fill(0);
  fail(`Decrypted state is invalid: ${error.message}`);
}

let external;
try { external = createExternalCryptoProvider({ command:providerCommand }); }
catch (error) { plaintext.fill(0); fail(`External crypto provider failed self-test: ${error.message}`); }

let migrated;
try {
  const encrypted = external.encrypt(plaintext.toString('utf8'), 'direct-xfer-state-v2');
  migrated = JSON.stringify({ dxenc:2, provider:'external', keyId:encrypted.keyId, data:encrypted.ciphertext });
} finally {
  plaintext.fill(0);
}

const dir = path.dirname(storeFile);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${storeFile}.pre-external-crypto-${stamp}`;
const temp = `${storeFile}.migrate-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
try {
  fs.copyFileSync(storeFile, backup, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backup, 0o600); } catch (_) {}
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, migrated); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, storeFile);
  try { fs.chmodSync(storeFile, 0o600); } catch (_) {}
  if (process.platform !== 'win32') {
    let dfd = null;
    try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); } catch (_) {} finally { if (dfd !== null) try { fs.closeSync(dfd); } catch (_) {} }
  }
} catch (error) {
  try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  fail(`State migration could not be committed: ${error.message}`);
}

console.log(`Migrated ${storeFile} from dxenc:1 to dxenc:2.`);
console.log(`Backup retained at ${backup}.`);
console.log('Remove DATA_KEY/ASVS_L3_LEGACY_DATA_KEY from the Direct-Xfer runtime before enabling ASVS_L3_MODE.');
