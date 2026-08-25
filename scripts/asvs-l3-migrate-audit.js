'use strict';

// Offline one-shot migration for Direct-Xfer <=1.70.25 L3 audit journals.
// The legacy AUDIT_HMAC_KEY is accepted only by this offline command. The
// existing chain + signed head are fully verified before any file is replaced.
// The journal is then re-signed through the isolated external provider and the
// encrypted shares.json audit anchor is updated to the new hashes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExternalCryptoProvider } = require('../lib/server/external-crypto-provider');

function fail(message, code = 1) { console.error(message); process.exit(code); }
function timingSafeHex(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function deriveLegacyAuditKey(secret) {
  return crypto.createHash('sha256').update('direct-xfer:audit-chain:v1\0' + String(secret || '')).digest();
}
function payload(entry) {
  const base = [
    Number(entry.seq) || 0, Number(entry.at) || 0, String(entry.action || ''),
    entry.actor == null ? null : String(entry.actor), entry.actorId == null ? null : String(entry.actorId),
    entry.role == null ? null : String(entry.role), entry.ip == null ? null : String(entry.ip),
    entry.detail == null ? null : String(entry.detail), String(entry.prevHash || ''),
  ];
  if (entry && entry.version === 2) {
    return JSON.stringify([2, ...base, entry.authMethod == null ? null : String(entry.authMethod), entry.authResult == null ? null : String(entry.authResult)]);
  }
  return JSON.stringify(base);
}
function canonical(old, seq, prevHash) {
  const out = {
    seq, at:Number(old && old.at) || 0, action:String(old && old.action || ''),
    actor:old && old.actor != null ? String(old.actor) : null,
    actorId:old && old.actorId != null ? String(old.actorId) : null,
    role:old && old.role != null ? String(old.role) : null,
    ip:old && old.ip != null ? String(old.ip) : null,
    detail:old && old.detail != null ? String(old.detail) : null,
    prevHash:String(prevHash || ''),
  };
  if (old && old.version === 2) {
    out.version = 2;
    out.authMethod = old.authMethod != null ? String(old.authMethod).slice(0,64) : null;
    out.authResult = ['success','failure'].includes(old.authResult) ? old.authResult : null;
  }
  return out;
}
function durableWrite(file, data, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (_) {}
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (_) {} }
}

const dataDir = path.resolve(process.argv[2] || process.env.DATA_DIR || '/data');
const chainFile = path.join(dataDir, 'audit-chain.log');
const headFile = path.join(dataDir, 'audit-chain-head.json');
const stateFile = path.join(dataDir, 'shares.json');
const legacySecret = String(process.env.ASVS_L3_LEGACY_AUDIT_HMAC_KEY || process.env.AUDIT_HMAC_KEY || '');
const providerCommand = String(process.env.ASVS_L3_CRYPTO_COMMAND || '').trim();
if (!legacySecret) fail('ASVS_L3_LEGACY_AUDIT_HMAC_KEY (or AUDIT_HMAC_KEY for this offline command only) is required.');
if (!providerCommand) fail('ASVS_L3_CRYPTO_COMMAND is required.');
for (const file of [chainFile, headFile, stateFile]) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { fail(`Could not inspect ${file}: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${file} must be a regular non-symlink file.`);
  if (stat.size > 256 * 1024 * 1024) fail(`${file} is unexpectedly large.`);
}

let external;
try { external = createExternalCryptoProvider({ command:providerCommand }); }
catch (error) { fail(`External crypto provider failed self-test: ${error.message}`); }

let entries, head, stateEnvelope, state;
try {
  const raw = fs.readFileSync(chainFile, 'utf8');
  entries = raw.split('\n').filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch (_) { throw new Error(`malformed audit line ${index + 1}`); }
  });
  head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
  stateEnvelope = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!stateEnvelope || stateEnvelope.dxenc !== 2 || typeof stateEnvelope.data !== 'string') {
    throw new Error('shares.json must first be migrated to dxenc:2 with npm run asvs:l3:migrate-state');
  }
  state = JSON.parse(external.decrypt(stateEnvelope.data, 'direct-xfer-state-v2', stateEnvelope.keyId));
} catch (error) { fail(`Could not load migration inputs: ${error.message}`); }

const legacyKey = deriveLegacyAuditKey(legacySecret);
try {
  let prev = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.seq !== i + 1 || typeof e.hash !== 'string' || !/^[a-f0-9]{64}$/.test(e.hash)
        || String(e.prevHash || '') !== prev) fail(`Legacy audit chain failed structural verification at sequence ${i + 1}.`);
    const expected = crypto.createHmac('sha256', legacyKey).update(payload(e)).digest('hex');
    if (!timingSafeHex(e.hash, expected)) fail(`Legacy AUDIT_HMAC_KEY does not verify audit sequence ${i + 1}.`);
    prev = e.hash;
  }
  if (!head || head.version !== 1 || head.seq !== entries.length || String(head.hash || '') !== prev || typeof head.seal !== 'string') {
    fail('Legacy audit head does not match the verified chain.');
  }
  const expectedSeal = crypto.createHmac('sha256', legacyKey).update(`head|${head.seq}|${head.hash || ''}`).digest('hex');
  if (!timingSafeHex(head.seal, expectedSeal)) fail('Legacy audit head seal is invalid.');
} finally { legacyKey.fill(0); }

let prev = '';
const resigned = entries.map((old, index) => {
  const e = canonical(old, index + 1, prev);
  e.hash = external.hmac(payload(e), 'audit-hmac');
  prev = e.hash;
  return e;
});
const migration = {
  seq:resigned.length + 1, at:Date.now(), action:'audit-key-migrated', actor:'system', actorId:null,
  role:null, ip:null, detail:'legacy AUDIT_HMAC_KEY -> isolated external audit-hmac handle', prevHash:prev,
};
migration.hash = external.hmac(payload(migration), 'audit-hmac');
resigned.push(migration);
prev = migration.hash;
const newHead = {
  version:1, seq:resigned.length, hash:prev,
  seal:external.hmac(`head|${resigned.length}|${prev}`, 'audit-hmac'), at:Date.now(),
};
if (!state || typeof state !== 'object' || !Array.isArray(state.shares)) fail('Decrypted shares.json is not a valid Direct-Xfer state.');
state.audit = resigned.slice(-500).reverse();
const stateEncrypted = external.encrypt(JSON.stringify(state), 'direct-xfer-state-v2');
const newStateRaw = JSON.stringify({ dxenc:2, provider:'external', keyId:stateEncrypted.keyId, data:stateEncrypted.ciphertext });

// Verify the freshly generated journal before touching disk.
prev = '';
for (const e of resigned) {
  if (e.prevHash !== prev || !timingSafeHex(e.hash, external.hmac(payload(e), 'audit-hmac'))) fail('Generated external audit chain failed self-verification.');
  prev = e.hash;
}
if (!timingSafeHex(newHead.seal, external.hmac(`head|${newHead.seq}|${newHead.hash}`, 'audit-hmac'))) fail('Generated external audit head failed self-verification.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backups = [chainFile, headFile, stateFile].map((file) => [file, `${file}.pre-external-audit-${stamp}`]);
const temps = [
  [chainFile, `${chainFile}.migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}`, resigned.map((e) => JSON.stringify(e)).join('\n') + '\n'],
  [headFile, `${headFile}.migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}`, JSON.stringify(newHead)],
  [stateFile, `${stateFile}.migrate-${process.pid}-${crypto.randomBytes(4).toString('hex')}`, newStateRaw],
];
try {
  for (const [source, backup] of backups) { fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL); try { fs.chmodSync(backup, 0o600); } catch (_) {} }
  for (const [, temp, data] of temps) durableWrite(temp, data);
  // State is replaced last so it never points at new audit hashes before the
  // corresponding chain/head have been durably published.
  fs.renameSync(temps[0][1], chainFile);
  fs.renameSync(temps[1][1], headFile);
  fs.renameSync(temps[2][1], stateFile);
  for (const file of [chainFile, headFile, stateFile]) try { fs.chmodSync(file, 0o600); } catch (_) {}
  syncDir(dataDir);
} catch (error) {
  for (const [, temp] of temps) try { fs.unlinkSync(temp); } catch (_) {}
  let rollbackError = null;
  for (const [target, backup] of backups) {
    try {
      if (fs.existsSync(backup)) {
        const restore = `${target}.rollback-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
        fs.copyFileSync(backup, restore);
        try { fs.chmodSync(restore, 0o600); } catch (_) {}
        fs.renameSync(restore, target);
      }
    } catch (restoreError) { rollbackError = rollbackError || restoreError; }
  }
  syncDir(dataDir);
  fail(`Audit migration could not be committed: ${error.message}.${rollbackError ? ` Automatic rollback also failed: ${rollbackError.message}` : ' Original files were restored from backups.'}`);
}

console.log(`Migrated ${resigned.length - 1} legacy audit entries and appended one migration event.`);
console.log(`External audit key id: ${external.keyId('audit-hmac')}.`);
console.log('Backups retained with .pre-external-audit-* suffixes.');
console.log('Remove AUDIT_HMAC_KEY/ASVS_L3_LEGACY_AUDIT_HMAC_KEY from the Direct-Xfer runtime before enabling ASVS_L3_MODE.');
