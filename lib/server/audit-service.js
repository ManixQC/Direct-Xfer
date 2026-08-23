'use strict';

/**
 * Tamper-evident security audit journal.
 *
 * Owns the HMAC chain, signed head, Ed25519 export proofs, audit-key migration,
 * durable writes and the user-facing audit tail. Runtime state is resolved through
 * getState() so backup restore may replace the root object without leaving stale
 * references inside the service.
 */
function createAuditService(deps) {
  const {
    fs, path, crypto, DATA_DIR, DATA_KEY, APP_NAME, APP_VERSION, AUDIT_MAX,
    timingSafeEqualStr, getState, persistNow, scheduleFlush,
    emitLiveActivity, pubIp, scheduleSearchReindex, getAccountById, clientIp,
    isActivityIgnored = () => false,
    env = process.env,
  } = deps;

  if (!fs || !path || !crypto || !DATA_DIR || typeof getState !== 'function') {
    throw new Error('audit-service-missing-dependencies');
  }

  const currentState = () => getState();
  let securityAlertHandler = () => {};

  const AUDIT_CHAIN_FILE = path.join(DATA_DIR, 'audit-chain.log');
  const AUDIT_KEY_FILE = path.join(DATA_DIR, 'audit-chain.key');
  const AUDIT_HEAD_FILE = path.join(DATA_DIR, 'audit-chain-head.json');
  const AUDIT_KEY_MIGRATION_FILE = path.join(DATA_DIR, 'audit-key-migration.json');
  const AUDIT_KEY_MIGRATION_CHAIN_BACKUP = path.join(DATA_DIR, 'audit-chain.log.pre-key-migration');
  const AUDIT_KEY_MIGRATION_HEAD_BACKUP = path.join(DATA_DIR, 'audit-chain-head.json.pre-key-migration');
  const AUDIT_SIGNING_PRIVATE_FILE = path.join(DATA_DIR, 'audit-signing-private.pem');
  const AUDIT_SIGNING_PUBLIC_FILE = path.join(DATA_DIR, 'audit-signing-public.pem');
  const AUDIT_SIGNING_PRIVATE_ENV = String(env.AUDIT_SIGNING_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  const AUDIT_SIGNING_PRIVATE_PATH = String(env.AUDIT_SIGNING_PRIVATE_KEY_FILE || '').trim();
  const AUDIT_HMAC_ENV_SECRET = String(env.AUDIT_HMAC_KEY || '').trim();
  const AUDIT_HMAC_SECRET = String(AUDIT_HMAC_ENV_SECRET || DATA_KEY || '').trim();
  const AUDIT_KEY_MODE = AUDIT_HMAC_SECRET ? (AUDIT_HMAC_ENV_SECRET ? 'env' : 'data-key') : 'local-file';

  let auditActiveKeyMode = AUDIT_KEY_MODE;
  let auditChainKey = null;
  let auditKeyMigrationStatus = null;
  let auditChainHead = { seq: 0, hash: '' };
  let auditIntegrityStatus = { ok: true, reason: null, entries: 0, headSeq: 0, headHash: '', checkedAt: 0 };
  let auditProofPrivateKey = null;
  let auditProofPublicKey = null;

function deriveAuditChainKey(secret) {
  return crypto.createHash('sha256').update('direct-xfer:audit-chain:v1\0' + String(secret || '')).digest();
}
function auditKeyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}
function auditServiceError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
function readLocalAuditChainKey() {
  let raw;
  try { raw = fs.readFileSync(AUDIT_KEY_FILE); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw auditServiceError('audit-key-unreadable', error);
  }
  // This file has always been written as exactly 32 raw random bytes. Treat a
  // short/extended file as corruption instead of silently changing the key that
  // protects the journal.
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw auditServiceError('audit-key-invalid');
  return Buffer.from(raw);
}
function ensureAuditChainKey() {
  if (auditChainKey) return auditChainKey;
  if (AUDIT_HMAC_SECRET) {
    auditChainKey = deriveAuditChainKey(AUDIT_HMAC_SECRET);
    return auditChainKey;
  }
  const existing = readLocalAuditChainKey();
  if (existing) { auditChainKey = existing; return auditChainKey; }

  const candidate = crypto.randomBytes(32);
  try {
    durableAuditCreateSync(AUDIT_KEY_FILE, candidate, 0o600);
    syncAuditDataDir();
    auditChainKey = candidate;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // Another process may have won the exclusive create. Never continue with
      // our in-memory candidate: doing so would create a journal that cannot be
      // verified after restart.
      const concurrent = readLocalAuditChainKey();
      if (!concurrent) throw auditServiceError('audit-key-race-lost', error);
      auditChainKey = concurrent;
    } else {
      auditChainKey = null;
      console.error('[audit] could not durably persist audit-chain key:', error && error.message);
      throw auditServiceError('audit-key-persist-failed', error);
    }
  }
  return auditChainKey;
}

// Detached Ed25519 proof key. The live journal remains HMAC-chained for fast
// append/verification, while exported proof bundles are signed asymmetrically so
// a third party can verify them without receiving a secret capable of forgery.
function ensureAuditProofKeys() {
  if (auditProofPrivateKey && auditProofPublicKey) return { privateKey:auditProofPrivateKey, publicKey:auditProofPublicKey };
  const externalKeyConfigured = !!(AUDIT_SIGNING_PRIVATE_ENV || AUDIT_SIGNING_PRIVATE_PATH);
  let privatePem = AUDIT_SIGNING_PRIVATE_ENV;
  let localKeyLoaded = false;
  if (!privatePem && AUDIT_SIGNING_PRIVATE_PATH) {
    try { privatePem = fs.readFileSync(path.resolve(AUDIT_SIGNING_PRIVATE_PATH), 'utf8'); }
    catch (error) {
      console.error('[audit] could not read AUDIT_SIGNING_PRIVATE_KEY_FILE:', error.message);
      throw Object.assign(new Error('audit-signing-key-unreadable'), { code:'audit-signing-key-invalid' });
    }
  }
  if (!privatePem) {
    try { privatePem = fs.readFileSync(AUDIT_SIGNING_PRIVATE_FILE, 'utf8'); localKeyLoaded = true; } catch (_) {}
  }
  try {
    if (privatePem) auditProofPrivateKey = crypto.createPrivateKey(privatePem);
  } catch (error) {
    console.error('[audit] invalid Ed25519 signing key:', error.message);
    auditProofPrivateKey = null;
    if (externalKeyConfigured || localKeyLoaded) throw Object.assign(new Error('audit-signing-key-invalid'), { code:'audit-signing-key-invalid' });
  }
  if (auditProofPrivateKey && auditProofPrivateKey.asymmetricKeyType !== 'ed25519') {
    auditProofPrivateKey = null;
    if (externalKeyConfigured || localKeyLoaded) throw Object.assign(new Error('audit-signing-key-not-ed25519'), { code:'audit-signing-key-invalid' });
  }
  if (!auditProofPrivateKey) {
    const pair = crypto.generateKeyPairSync('ed25519');
    auditProofPrivateKey = pair.privateKey;
    privatePem = pair.privateKey.export({ type:'pkcs8', format:'pem' });
    if (!AUDIT_SIGNING_PRIVATE_ENV && !AUDIT_SIGNING_PRIVATE_PATH) {
      try {
        // Exclusive creation prevents two containers sharing /data from silently
        // replacing one another's proof identity during their first export.
        durableAuditCreateSync(AUDIT_SIGNING_PRIVATE_FILE, privatePem, 0o600);
        syncAuditDataDir();
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          try {
            auditProofPrivateKey = crypto.createPrivateKey(fs.readFileSync(AUDIT_SIGNING_PRIVATE_FILE, 'utf8'));
            if (auditProofPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('not-ed25519');
          } catch (readError) {
            auditProofPrivateKey = null;
            throw Object.assign(new Error('audit-signing-key-invalid'), { code:'audit-signing-key-invalid', cause:readError });
          }
        } else {
          console.error('[audit] could not persist Ed25519 signing key:', error.message);
          auditProofPrivateKey = null;
          throw Object.assign(new Error('audit-signing-key-persist-failed'), { code:'audit-signing-key-persist-failed' });
        }
      }
    }
  }
  auditProofPublicKey = crypto.createPublicKey(auditProofPrivateKey);
  const publicPem = auditProofPublicKey.export({ type:'spki', format:'pem' });
  try {
    durableAuditWriteSync(AUDIT_SIGNING_PUBLIC_FILE, publicPem, 0o644);
    syncAuditDataDir();
  } catch (_) { /* public key is derivable from the private key; persistence is best-effort */ }
  return { privateKey:auditProofPrivateKey, publicKey:auditProofPublicKey };
}
function auditProofKeyId(publicKey) {
  const der = publicKey.export({ type:'spki', format:'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}
function auditProofEntryDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries || []) hash.update(JSON.stringify(entry) + '\n');
  return hash.digest('hex');
}
function auditProofPayload(proof) {
  return JSON.stringify([
    Number(proof.proofVersion) || 0, String(proof.app || ''), String(proof.appVersion || ''),
    Number(proof.exportedAt) || 0, Number(proof.entryCount) || 0, String(proof.entriesSha256 || ''),
    Number(proof.head && proof.head.seq) || 0, String(proof.head && proof.head.hash || ''),
    String(proof.hmacKeyId || ''), String(proof.publicKeyId || ''),
  ]);
}
function buildAuditProof(entries, integrity) {
  const keys = ensureAuditProofKeys();
  const publicKeyPem = keys.publicKey.export({ type:'spki', format:'pem' }).toString();
  const proof = {
    proofVersion:1, app:APP_NAME, appVersion:APP_VERSION, exportedAt:Date.now(),
    entryCount:entries.length, entriesSha256:auditProofEntryDigest(entries),
    head:{ seq:Number(integrity.headSeq) || 0, hash:String(integrity.headHash || '') },
    hmacKeyId:integrity.keyId || null, publicKeyId:auditProofKeyId(keys.publicKey),
    publicKey:publicKeyPem, algorithm:'Ed25519', entries,
  };
  proof.signature = crypto.sign(null, Buffer.from(auditProofPayload(proof)), keys.privateKey).toString('base64');
  return proof;
}
function verifyAuditProofBundle(proof) {
  try {
    if (!proof || proof.proofVersion !== 1 || proof.algorithm !== 'Ed25519' || !Array.isArray(proof.entries) || proof.entryCount !== proof.entries.length) return { ok:false, reason:'malformed-proof' };
    if (!timingSafeEqualStr(String(proof.entriesSha256 || ''), auditProofEntryDigest(proof.entries))) return { ok:false, reason:'entry-digest-mismatch' };
    const publicKey = crypto.createPublicKey(String(proof.publicKey || ''));
    if (publicKey.asymmetricKeyType !== 'ed25519') return { ok:false, reason:'public-key-not-ed25519' };
    if (auditProofKeyId(publicKey) !== proof.publicKeyId) return { ok:false, reason:'public-key-id-mismatch' };
    let previous = '', sequence = 0;
    for (const entry of proof.entries) {
      if (!entry || entry.seq !== sequence + 1 || String(entry.prevHash || '') !== previous || !/^[a-f0-9]{64}$/.test(String(entry.hash || ''))) {
        return { ok:false, reason:'chain-structure-invalid' };
      }
      sequence = entry.seq; previous = entry.hash;
    }
    if (Number(proof.head && proof.head.seq) !== sequence || String(proof.head && proof.head.hash || '') !== previous) return { ok:false, reason:'signed-head-mismatch' };
    const ok = crypto.verify(null, Buffer.from(auditProofPayload(proof)), publicKey, Buffer.from(String(proof.signature || ''), 'base64'));
    return { ok, reason:ok ? null : 'signature-invalid', keyId:proof.publicKeyId, entries:proof.entries.length };
  } catch (error) { return { ok:false, reason:'unreadable-proof', error:error.message }; }
}

const AUDIT_ENTRY_ALLOWED_FIELDS = new Set(['seq','at','action','actor','actorId','role','ip','detail','prevHash','hash']);
function auditEntryShapeReason(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'entry-shape-invalid';
  for (const key of Object.keys(entry)) if (!AUDIT_ENTRY_ALLOWED_FIELDS.has(key)) return 'entry-extra-field';
  if (!Number.isInteger(entry.seq) || entry.seq < 1) return 'sequence-break';
  if (!Number.isFinite(entry.at) || entry.at < 0) return 'entry-shape-invalid';
  if (typeof entry.action !== 'string') return 'entry-shape-invalid';
  for (const key of ['actor','actorId','role','ip','detail']) {
    if (entry[key] != null && typeof entry[key] !== 'string') return 'entry-shape-invalid';
  }
  if (typeof entry.prevHash !== 'string' || typeof entry.hash !== 'string') return 'entry-shape-invalid';
  if (!/^[a-f0-9]{64}$/.test(entry.hash)) return 'entry-hash-malformed';
  if (entry.prevHash && !/^[a-f0-9]{64}$/.test(entry.prevHash)) return 'previous-hash-malformed';
  return null;
}
function canonicalAuditEntry(old, seq, prevHash) {
  return {
    seq,
    at: Number(old && old.at) || 0,
    action: String(old && old.action || ''),
    actor: old && old.actor != null ? String(old.actor) : null,
    actorId: old && old.actorId != null ? String(old.actorId) : null,
    role: old && old.role != null ? String(old.role) : null,
    ip: old && old.ip != null ? String(old.ip) : null,
    detail: old && old.detail != null ? String(old.detail) : null,
    prevHash: String(prevHash || ''),
  };
}
function validateAuditRestoreEntries(entries, expectedHead) {
  if (!Array.isArray(entries)) return { ok:false, reason:'restore-chain-not-array', entries:0, headSeq:0, headHash:'' };
  let previous = '', sequence = 0;
  for (const entry of entries) {
    const shapeReason = auditEntryShapeReason(entry);
    if (shapeReason) return { ok:false, reason:shapeReason, entries:entries.length, validEntries:sequence, headSeq:sequence, headHash:previous };
    if (entry.seq !== sequence + 1) return { ok:false, reason:'sequence-break', entries:entries.length, validEntries:sequence, headSeq:sequence, headHash:previous };
    if (entry.prevHash !== previous) return { ok:false, reason:'previous-hash-mismatch', entries:entries.length, validEntries:sequence, headSeq:sequence, headHash:previous };
    sequence = entry.seq;
    previous = entry.hash;
  }
  if (expectedHead != null) {
    if (!expectedHead || typeof expectedHead !== 'object' || Array.isArray(expectedHead)
        || expectedHead.version !== 1 || !Number.isInteger(expectedHead.seq) || expectedHead.seq < 0
        || typeof expectedHead.hash !== 'string' || typeof expectedHead.seal !== 'string'
        || !/^[a-f0-9]{64}$/.test(expectedHead.seal)
        || !Number.isFinite(expectedHead.at) || expectedHead.at < 0
        || (expectedHead.hash && !/^[a-f0-9]{64}$/.test(expectedHead.hash))) {
      return { ok:false, reason:'restore-head-malformed', entries:entries.length, validEntries:sequence, headSeq:sequence, headHash:previous };
    }
    if (expectedHead.seq !== sequence || expectedHead.hash !== previous) {
      return { ok:false, reason:'restore-head-mismatch', entries:entries.length, validEntries:sequence, headSeq:sequence, headHash:previous };
    }
  }
  return { ok:true, reason:null, entries:entries.length, validEntries:sequence, headSeq:sequence, headHash:previous };
}

function auditChainPayload(entry) {
  return JSON.stringify([
    Number(entry.seq) || 0, Number(entry.at) || 0, String(entry.action || ''),
    entry.actor == null ? null : String(entry.actor), entry.actorId == null ? null : String(entry.actorId),
    entry.role == null ? null : String(entry.role), entry.ip == null ? null : String(entry.ip),
    entry.detail == null ? null : String(entry.detail), String(entry.prevHash || ''),
  ]);
}
function auditChainHashWithKey(entry, key) {
  return crypto.createHmac('sha256', key).update(auditChainPayload(entry)).digest('hex');
}
function auditChainHash(entry) {
  return auditChainHashWithKey(entry, ensureAuditChainKey());
}
function auditHeadSealWithKey(seq, hash, key) {
  return crypto.createHmac('sha256', key).update('head|' + String(seq) + '|' + String(hash || '')).digest('hex');
}
function auditHeadSeal(seq, hash) {
  return auditHeadSealWithKey(seq, hash, ensureAuditChainKey());
}
function writeAuditHeadSync(seq, hash) {
  const obj = { version: 1, seq, hash, seal: auditHeadSeal(seq, hash), at: Date.now() };
  const tmp = AUDIT_HEAD_FILE + '.tmp-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  try {
    // fsync the temporary head before rename. Without this, a power loss could
    // leave a durable chain entry with a vanished/old head after restart.
    durableAuditWriteSync(tmp, JSON.stringify(obj), 0o600);
    fs.renameSync(tmp, AUDIT_HEAD_FILE);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}
function parseAuditHeadText(raw, key) {
  try {
    const h = JSON.parse(raw);
    if (!h || !Number.isInteger(h.seq) || typeof h.hash !== 'string' || typeof h.seal !== 'string') return { invalid: true, reason: 'malformed' };
    if (!timingSafeEqualStr(h.seal, auditHeadSealWithKey(h.seq, h.hash, key))) return { invalid: true, reason: 'signature' };
    return h;
  } catch (_) { return { invalid: true, reason: 'unreadable' }; }
}
function readAuditHeadWithKey(key) {
  try { return parseAuditHeadText(fs.readFileSync(AUDIT_HEAD_FILE, 'utf8'), key); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true };
    return { invalid: true, reason: 'unreadable' };
  }
}
function readAuditHead() { return readAuditHeadWithKey(ensureAuditChainKey()); }
function parseAuditChainText(raw) {
  const lines = String(raw || '').split('\n').filter((line) => line.trim());
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try { entries.push(JSON.parse(lines[i])); }
    catch (_) { return { entries, malformed: true, line: i + 1 }; }
  }
  return { entries, malformed: false };
}
function parseAuditChainFile() {
  try { return parseAuditChainText(fs.readFileSync(AUDIT_CHAIN_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { entries: [], malformed: false }; throw e; }
}
function verifyParsedAuditChain(parsed, signedHead, key, opts) {
  opts = opts || {};
  let prev = '', seq = 0, validCount = 0;
  let reason = parsed.malformed ? 'malformed-line' : null;
  for (const e of parsed.entries) {
    if (reason) break;
    const shapeReason = auditEntryShapeReason(e);
    if (shapeReason) { reason = shapeReason; break; }
    if (e.seq !== seq + 1) { reason = 'sequence-break'; break; }
    if (e.prevHash !== prev) { reason = 'previous-hash-mismatch'; break; }
    const expected = auditChainHashWithKey(e, key);
    if (!timingSafeEqualStr(e.hash, expected)) { reason = 'entry-hash-mismatch'; break; }
    prev = e.hash; seq = e.seq; validCount += 1;
  }
  if (!reason && opts.checkRemembered !== false) {
    const remembered = (Array.isArray(currentState().audit) ? currentState().audit : []).find((e) => e && Number.isInteger(e.seq) && typeof e.hash === 'string');
    if (remembered) {
      if (remembered.seq > seq) reason = 'chain-rollback-detected';
      else if (remembered.seq === seq && !timingSafeEqualStr(String(remembered.hash), String(prev))) reason = 'state-audit-head-mismatch';
    }
  }
  if (!reason && signedHead && signedHead.missing) reason = 'head-missing';
  if (!reason && signedHead && signedHead.invalid) reason = signedHead.reason === 'signature' ? 'head-signature-invalid' : 'head-unreadable';
  if (!reason && signedHead && !signedHead.missing && !signedHead.invalid && (signedHead.seq !== seq || signedHead.hash !== prev)) reason = 'chain-truncated-or-head-mismatch';
  return {
    ok: !reason, reason, entries: parsed.entries.length, validEntries: validCount,
    headSeq: seq, headHash: prev, checkedAt: Date.now(), keyId: auditKeyId(key),
  };
}
function verifyAuditChainWithKey(key, opts) {
  let parsed;
  try { parsed = parseAuditChainFile(); }
  catch (e) { return { ok: false, reason: 'chain-unreadable', error: e.message, entries: 0, headSeq: 0, headHash: '', checkedAt: Date.now(), keyId: auditKeyId(key) }; }
  return verifyParsedAuditChain(parsed, readAuditHeadWithKey(key), key, opts);
}
function verifyAuditBackupWithKey(key) {
  try {
    const parsed = parseAuditChainText(fs.readFileSync(AUDIT_KEY_MIGRATION_CHAIN_BACKUP, 'utf8'));
    const head = parseAuditHeadText(fs.readFileSync(AUDIT_KEY_MIGRATION_HEAD_BACKUP, 'utf8'), key);
    return verifyParsedAuditChain(parsed, head, key, { checkRemembered: false });
  } catch (e) {
    return { ok: false, reason: 'migration-backup-unreadable', error: e.message, entries: 0, headSeq: 0, headHash: '', checkedAt: Date.now(), keyId: auditKeyId(key) };
  }
}
function verifyAuditSnapshot(chainRaw, headRaw, key) {
  try {
    const parsed = parseAuditChainText(Buffer.isBuffer(chainRaw) ? chainRaw.toString('utf8') : String(chainRaw || ''));
    const headText = Buffer.isBuffer(headRaw) ? headRaw.toString('utf8') : String(headRaw || '');
    const head = headText ? parseAuditHeadText(headText, key) : { missing:true };
    return verifyParsedAuditChain(parsed, head, key, { checkRemembered:false });
  } catch (error) {
    return { ok:false, reason:'snapshot-unreadable', error:error.message, entries:0, headSeq:0, headHash:'', checkedAt:Date.now(), keyId:auditKeyId(key) };
  }
}
function durableAuditWriteSync(file, data, mode = 0o600) {
  const fd = fs.openSync(file, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function durableAuditCreateSync(file, data, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncAuditDataDir() {
  // fsync(directory) is supported on Unix; some platforms/filesystems reject it.
  // The file fsyncs above are still useful there, so directory syncing is best-effort.
  let fd = null;
  try { fd = fs.openSync(DATA_DIR, 'r'); fs.fsyncSync(fd); } catch (_) {}
  finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
}

function cleanupAuditKeyMigrationFiles(removeLocalKey) {
  let changed = false;
  for (const file of [AUDIT_KEY_MIGRATION_FILE, AUDIT_KEY_MIGRATION_CHAIN_BACKUP, AUDIT_KEY_MIGRATION_HEAD_BACKUP]) {
    try { fs.unlinkSync(file); changed = true; } catch (e) { if (e.code !== 'ENOENT') console.warn('[audit] migration cleanup:', e.message); }
  }
  if (removeLocalKey) {
    try { fs.unlinkSync(AUDIT_KEY_FILE); changed = true; }
    catch (e) { if (e.code !== 'ENOENT') console.warn('[audit] could not remove retired local key:', e.message); }
  }
  if (changed) syncAuditDataDir();
}
function restoreAuditMigrationBackup(localKey) {
  const status = verifyAuditBackupWithKey(localKey);
  if (!status.ok) throw new Error('pre-migration backup failed verification: ' + (status.reason || 'unknown'));
  const chainTmp = AUDIT_CHAIN_FILE + '.restore-' + process.pid;
  const headTmp = AUDIT_HEAD_FILE + '.restore-' + process.pid;
  durableAuditWriteSync(chainTmp, fs.readFileSync(AUDIT_KEY_MIGRATION_CHAIN_BACKUP));
  durableAuditWriteSync(headTmp, fs.readFileSync(AUDIT_KEY_MIGRATION_HEAD_BACKUP));
  fs.renameSync(chainTmp, AUDIT_CHAIN_FILE);
  fs.renameSync(headTmp, AUDIT_HEAD_FILE);
  syncAuditDataDir();
}
function resignAuditEntries(entries, key) {
  let prev = '';
  return (Array.isArray(entries) ? entries : []).map((old, index) => {
    // Keep the on-disk schema canonical. Extra properties are not part of the
    // historical v1 HMAC payload and must not survive a migration/restore as
    // mutable, unsigned metadata.
    const e = canonicalAuditEntry(old, index + 1, prev);
    e.hash = auditChainHashWithKey(e, key);
    prev = e.hash;
    return e;
  });
}
function replaceChainForRestore(entries) {
  const restoreValidation = validateAuditRestoreEntries(entries, null);
  if (!restoreValidation.ok) throw auditServiceError('invalid-audit-backup:' + restoreValidation.reason);
  const key = ensureAuditChainKey();
  const resigned = resignAuditEntries(entries, key);
  const chainText = resigned.length ? resigned.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  const seq = resigned.length ? resigned[resigned.length - 1].seq : 0;
  const hash = resigned.length ? resigned[resigned.length - 1].hash : '';
  const head = { version:1, seq, hash, seal:auditHeadSealWithKey(seq, hash, key), at:Date.now() };
  const chainTmp = AUDIT_CHAIN_FILE + '.restore-' + process.pid;
  const headTmp = AUDIT_HEAD_FILE + '.restore-' + process.pid;
  durableAuditWriteSync(chainTmp, chainText);
  durableAuditWriteSync(headTmp, JSON.stringify(head));
  fs.renameSync(chainTmp, AUDIT_CHAIN_FILE);
  fs.renameSync(headTmp, AUDIT_HEAD_FILE);
  syncAuditDataDir();
  auditChainHead = { seq, hash };
  auditIntegrityStatus = {
    ok:true, reason:null, entries:resigned.length, validEntries:resigned.length,
    headSeq:seq, headHash:hash, checkedAt:Date.now(), keyId:auditKeyId(key),
    keyMode:auditActiveKeyMode, migration:auditKeyMigrationStatus,
  };
  return resigned;
}

function migrateLocalAuditKeyToExternalIfNeeded() {
  if (!AUDIT_HMAC_ENV_SECRET) return { attempted:false, reason:'no-audit-hmac-env' };
  const externalKey = deriveAuditChainKey(AUDIT_HMAC_ENV_SECRET);
  const markerExists = fs.existsSync(AUDIT_KEY_MIGRATION_FILE);
  const hasExistingJournal = fs.existsSync(AUDIT_CHAIN_FILE) || fs.existsSync(AUDIT_HEAD_FILE);

  let marker = null;
  if (markerExists) {
    try { marker = JSON.parse(fs.readFileSync(AUDIT_KEY_MIGRATION_FILE, 'utf8')); }
    catch (_) { marker = null; }
  }

  let localKey = null, localKeyError = null;
  try { localKey = readLocalAuditChainKey(); } catch (error) { localKeyError = error; }

  // Before AUDIT_HMAC_KEY is introduced, DATA_KEY has precedence over the local
  // audit-chain.key. Migrate from the key that actually signed the old journal,
  // not merely from whichever key file happens to exist on disk.
  const dataKeyPredecessor = DATA_KEY ? deriveAuditChainKey(DATA_KEY) : null;
  const predecessorKey = dataKeyPredecessor || localKey;
  const predecessorMode = dataKeyPredecessor ? 'data-key' : (localKey ? 'local-file' : null);
  const predecessorKeyId = predecessorKey ? auditKeyId(predecessorKey) : null;
  const fallbackMode = predecessorMode ? predecessorMode + '-fallback' : 'env';

  if (!hasExistingJournal && !markerExists) {
    if (localKeyError && !DATA_KEY) throw localKeyError;
    auditChainKey = externalKey;
    auditActiveKeyMode = 'env';
    return { attempted:false, reason:'no-existing-chain' };
  }

  // First check whether a previous attempt already committed the new chain. This
  // also makes a stale/corrupt local key harmless when the journal is already on
  // the external key.
  const alreadyExternal = verifyAuditChainWithKey(externalKey, { checkRemembered:false });
  if (alreadyExternal.ok) {
    auditChainKey = externalKey;
    auditActiveKeyMode = 'env';
    const all = parseAuditChainFile().entries;
    currentState().audit = all.slice(-AUDIT_MAX).reverse();
    if (!persistNow()) throw new Error('could not persist audit state while finalizing external audit key');
    cleanupAuditKeyMigrationFiles(true);
    auditKeyMigrationStatus = {
      ok:true, migrated:!!markerExists, recovered:!!markerExists,
      retiredStaleLocalKey:!!localKey && !markerExists,
      from:(marker && marker.fromKeyId) || predecessorKeyId,
      fromMode:(marker && marker.fromMode) || predecessorMode,
      to:auditKeyId(externalKey), at:Date.now(),
    };
    return auditKeyMigrationStatus;
  }

  if (localKeyError && !dataKeyPredecessor) throw localKeyError;
  if (!predecessorKey) {
    auditChainKey = externalKey;
    auditActiveKeyMode = 'env';
    return { attempted:false, reason:'no-predecessor-key' };
  }

  // Recovery path for a process/container interruption in the middle of migration.
  if (markerExists) {
    // A previous attempt may already have rolled back successfully and then kept
    // serving traffic on the predecessor key. If that current chain is valid, it
    // can contain newer audit events than the pre-migration backup. Never overwrite
    // those events with the stale backup; retire the stale marker and start a fresh
    // transaction from the current valid chain instead.
    const currentPredecessor = verifyAuditChainWithKey(predecessorKey, { checkRemembered:true });
    if (currentPredecessor.ok) {
      cleanupAuditKeyMigrationFiles(false);
    } else {
      restoreAuditMigrationBackup(predecessorKey);
    }
    auditChainKey = predecessorKey;
    auditActiveKeyMode = fallbackMode;
  }

  // Never rewrite a damaged/rolled-back chain. The predecessor key must validate
  // the complete chain + signed head + shares.json rollback anchor first.
  const oldStatus = verifyAuditChainWithKey(predecessorKey, { checkRemembered:true });
  if (!oldStatus.ok) {
    auditChainKey = predecessorKey;
    auditActiveKeyMode = fallbackMode;
    const reason = predecessorMode === 'data-key' ? 'data-key-chain-invalid' : 'local-chain-invalid';
    auditKeyMigrationStatus = {
      ok:false, migrated:false, reason, integrityReason:oldStatus.reason,
      from:predecessorKeyId, fromMode:predecessorMode,
      to:auditKeyId(externalKey), at:Date.now(),
    };
    console.error(`[audit] refusing AUDIT_HMAC_KEY migration: existing ${predecessorMode || 'previous'} chain is not valid (${oldStatus.reason || 'unknown'})`);
    return auditKeyMigrationStatus;
  }

  const oldStateAudit = Array.isArray(currentState().audit) ? currentState().audit.map((e) => ({ ...e })) : [];
  const chainRaw = fs.existsSync(AUDIT_CHAIN_FILE) ? fs.readFileSync(AUDIT_CHAIN_FILE) : Buffer.alloc(0);
  const headRaw = fs.existsSync(AUDIT_HEAD_FILE) ? fs.readFileSync(AUDIT_HEAD_FILE) : Buffer.alloc(0);
  const parsed = parseAuditChainText(chainRaw.toString('utf8'));
  const resigned = resignAuditEntries(parsed.entries, externalKey);
  const migrationEntry = {
    seq:resigned.length + 1, at:Date.now(), action:'audit-key-migrated', actor:'system', actorId:null, role:null, ip:null,
    detail:`${predecessorMode} ${predecessorKeyId} -> AUDIT_HMAC_KEY ${auditKeyId(externalKey)}`,
    prevHash:resigned.length ? resigned[resigned.length - 1].hash : '',
  };
  migrationEntry.hash = auditChainHashWithKey(migrationEntry, externalKey);
  resigned.push(migrationEntry);
  const newHeadSeq = resigned.length;
  const newHeadHash = resigned.length ? resigned[resigned.length - 1].hash : '';
  const newHead = { version:1, seq:newHeadSeq, hash:newHeadHash, seal:auditHeadSealWithKey(newHeadSeq, newHeadHash, externalKey), at:Date.now() };
  const markerPayload = {
    version:2, createdAt:Date.now(), fromKeyId:predecessorKeyId, fromMode:predecessorMode,
    toKeyId:auditKeyId(externalKey), entries:resigned.length,
  };
  const chainTmp = AUDIT_CHAIN_FILE + '.migrate-' + process.pid;
  const headTmp = AUDIT_HEAD_FILE + '.migrate-' + process.pid;

  try {
    durableAuditWriteSync(AUDIT_KEY_MIGRATION_CHAIN_BACKUP, chainRaw);
    durableAuditWriteSync(AUDIT_KEY_MIGRATION_HEAD_BACKUP, headRaw);
    durableAuditWriteSync(AUDIT_KEY_MIGRATION_FILE, JSON.stringify(markerPayload));
    syncAuditDataDir();
    durableAuditWriteSync(chainTmp, resigned.map((e) => JSON.stringify(e)).join('\n') + (resigned.length ? '\n' : ''));
    durableAuditWriteSync(headTmp, JSON.stringify(newHead));
    fs.renameSync(chainTmp, AUDIT_CHAIN_FILE);
    fs.renameSync(headTmp, AUDIT_HEAD_FILE);
    syncAuditDataDir();

    auditChainKey = externalKey;
    auditActiveKeyMode = 'env';
    const candidate = verifyAuditChainWithKey(externalKey, { checkRemembered:false });
    if (!candidate.ok) throw new Error('new audit chain failed verification: ' + (candidate.reason || 'unknown'));
    currentState().audit = resigned.slice(-AUDIT_MAX).reverse();
    if (!persistNow()) throw new Error('could not persist re-signed audit state');
    const finalStatus = verifyAuditChainWithKey(externalKey, { checkRemembered:true });
    if (!finalStatus.ok) throw new Error('migrated audit state failed final verification: ' + (finalStatus.reason || 'unknown'));
    cleanupAuditKeyMigrationFiles(true);
    auditKeyMigrationStatus = {
      ok:true, migrated:true, from:predecessorKeyId, fromMode:predecessorMode,
      to:auditKeyId(externalKey), entries:resigned.length, at:Date.now(),
    };
    console.log(`[audit] migrated audit chain signing key from ${predecessorMode} ${predecessorKeyId} to AUDIT_HMAC_KEY ${auditKeyId(externalKey)} (${resigned.length} entries)`);
    return auditKeyMigrationStatus;
  } catch (error) {
    let rollbackRestored = false;
    try {
      if (fs.existsSync(AUDIT_KEY_MIGRATION_CHAIN_BACKUP) && fs.existsSync(AUDIT_KEY_MIGRATION_HEAD_BACKUP)) {
        restoreAuditMigrationBackup(predecessorKey);
        rollbackRestored = true;
      }
    } catch (restoreError) { console.error('[audit] migration rollback failed:', restoreError.message); }
    currentState().audit = oldStateAudit;
    auditChainKey = predecessorKey;
    auditActiveKeyMode = fallbackMode;
    try { persistNow(); } catch (_) {}
    try { fs.unlinkSync(chainTmp); } catch (_) {}
    try { fs.unlinkSync(headTmp); } catch (_) {}
    // Once rollback is fully restored, the marker/backups are no longer recovery
    // state. Leaving them behind would let a future restart roll the journal back
    // over events recorded after this failed migration.
    if (rollbackRestored) cleanupAuditKeyMigrationFiles(false);
    auditKeyMigrationStatus = {
      ok:false, migrated:false, reason:'migration-failed', error:error.message,
      from:predecessorKeyId, fromMode:predecessorMode,
      to:auditKeyId(externalKey), at:Date.now(),
    };
    console.error(`[audit] AUDIT_HMAC_KEY migration failed; ${predecessorMode || 'previous'} key retained:`, error.message);
    return auditKeyMigrationStatus;
  }
}

function verifyAuditChain() {
  ensureAuditChainKey();
  const result = verifyAuditChainWithKey(ensureAuditChainKey(), { checkRemembered: true });
  auditChainHead = { seq: result.headSeq || 0, hash: result.headHash || '' };
  auditIntegrityStatus = { ...result, keyMode: auditActiveKeyMode, migration: auditKeyMigrationStatus };
  return auditIntegrityStatus;
}
function appendAuditChainEntry(entry) {
  // Once the journal is known to be corrupt, appending to the last valid prefix
  // would create a fork and destroy forensic evidence. Remain fail-closed until a
  // successful explicit verification/repair re-establishes integrity.
  if (auditIntegrityStatus.checkedAt && !auditIntegrityStatus.ok) {
    console.error('[audit] append refused while journal integrity is invalid:', auditIntegrityStatus.reason || 'unknown');
    return null;
  }

  // Do not overwrite evidence that the signed head was deleted/modified after the
  // last verification. The old implementation would simply write a fresh head on
  // the next event, masking head-file tampering while the process remained alive.
  const diskHead = readAuditHead();
  if (diskHead.missing || diskHead.invalid || diskHead.seq !== auditChainHead.seq || diskHead.hash !== auditChainHead.hash) {
    const reason = diskHead.missing ? 'head-missing'
      : diskHead.invalid ? (diskHead.reason === 'signature' ? 'head-signature-invalid' : 'head-unreadable')
        : 'head-changed-since-verification';
    auditIntegrityStatus = { ...auditIntegrityStatus, ok:false, reason, checkedAt:Date.now() };
    console.error('[audit] append refused because signed head changed:', reason);
    return null;
  }

  const previousHead = { ...auditChainHead };
  entry.seq = auditChainHead.seq + 1;
  entry.prevHash = auditChainHead.hash || '';
  entry.hash = auditChainHash(entry);
  let originalSize = 0;
  try { originalSize = fs.statSync(AUDIT_CHAIN_FILE).size; }
  catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.error('[audit] could not inspect append-only chain:', error.message);
      auditIntegrityStatus = { ...auditIntegrityStatus, ok:false, reason:'chain-unreadable', error:error.message, checkedAt:Date.now() };
      return null;
    }
  }
  try {
    const fd = fs.openSync(AUDIT_CHAIN_FILE, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(entry) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    writeAuditHeadSync(entry.seq, entry.hash);
    syncAuditDataDir();
    auditChainHead = { seq: entry.seq, hash: entry.hash };
    auditIntegrityStatus = { ok: true, reason: null, entries: entry.seq, validEntries: entry.seq, headSeq: entry.seq, headHash: entry.hash, checkedAt: Date.now(), keyId: auditKeyId(ensureAuditChainKey()), keyMode: auditActiveKeyMode, migration: auditKeyMigrationStatus };
  } catch (e) {
    console.error('[audit] append-only chain write failed:', e.message);
    let rollbackOk = false;
    try {
      fs.truncateSync(AUDIT_CHAIN_FILE, originalSize);
      const fd = fs.openSync(AUDIT_CHAIN_FILE, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const verified = verifyAuditChainWithKey(ensureAuditChainKey(), { checkRemembered:false });
      rollbackOk = !!verified.ok;
      if (rollbackOk) {
        auditChainHead = previousHead;
        auditIntegrityStatus = { ...verified, keyMode:auditActiveKeyMode, migration:auditKeyMigrationStatus, writeError:e.message };
      }
    } catch (rollbackError) {
      console.error('[audit] failed to roll back partial append:', rollbackError.message);
    }
    if (!rollbackOk) auditIntegrityStatus = { ...auditIntegrityStatus, ok:false, reason:'chain-write-failed', error:e.message, checkedAt:Date.now() };
    return null;
  }
  return entry;
}
function initAuditChain() {
  // When a dedicated AUDIT_HMAC_KEY is introduced, verify the key that signed
  // the existing journal (DATA_KEY first, otherwise /data/audit-chain.key) and
  // transactionally re-sign it before normal appends use the external key.
  if (AUDIT_HMAC_ENV_SECRET && (
      fs.existsSync(AUDIT_KEY_FILE) || fs.existsSync(AUDIT_KEY_MIGRATION_FILE)
      || (DATA_KEY && (fs.existsSync(AUDIT_CHAIN_FILE) || fs.existsSync(AUDIT_HEAD_FILE)))
    )) {
    try { migrateLocalAuditKeyToExternalIfNeeded(); }
    catch (e) {
      console.error('[audit] key migration recovery failed:', e.message);
      auditKeyMigrationStatus = { ok: false, migrated: false, reason: 'migration-recovery-failed', error: e.message, at: Date.now() };
      // If recovery could not prove the new external chain, prefer the key that
      // would have signed the pre-migration journal for forensic diagnostics.
      if (!auditChainKey && DATA_KEY) {
        auditChainKey = deriveAuditChainKey(DATA_KEY);
        auditActiveKeyMode = 'data-key-fallback';
      } else if (!auditChainKey) {
        try {
          const fallback = readLocalAuditChainKey();
          if (fallback) { auditChainKey = fallback; auditActiveKeyMode = 'local-file-fallback'; }
        } catch (_) {}
      }
    }
  }
  ensureAuditChainKey();
  let parsed;
  try { parsed = parseAuditChainFile(); } catch (_) { parsed = { entries: [], malformed: false }; }
  if (!parsed.entries.length && !parsed.malformed) {
    const rememberedAudit = Array.isArray(currentState().audit) ? currentState().audit : [];
    const hadChainedAudit = rememberedAudit.some((e) => e && (Number.isInteger(e.seq) || typeof e.hash === 'string' || typeof e.prevHash === 'string'));
    if (hadChainedAudit) {
      console.error('[audit] INTEGRITY WARNING: chained audit state exists but audit-chain.log is empty or missing');
    } else {
      let prev = '', seq = 0;
      const sealed = [];
      for (const old of [...rememberedAudit].reverse()) {
        const e = {
          at: Number(old.at) || Date.now(), action: String(old.action || 'legacy'), actor: old.actor || null,
          actorId: old.actorId || null, role: old.role || null, ip: old.ip || null,
          detail: old.detail != null ? String(old.detail).slice(0, 300) : null,
          seq: ++seq, prevHash: prev,
        };
        e.hash = auditChainHash(e); prev = e.hash; sealed.push(e);
      }
      try {
        // Persist both pieces before considering legacy sealing complete. The
        // chain data and head are individually fsynced; the directory sync makes
        // their names durable across an abrupt power loss where supported.
        durableAuditWriteSync(AUDIT_CHAIN_FILE, sealed.map((e) => JSON.stringify(e)).join('\n') + (sealed.length ? '\n' : ''), 0o600);
        writeAuditHeadSync(seq, prev);
        syncAuditDataDir();
        currentState().audit = sealed.slice(-AUDIT_MAX).reverse();
        if (sealed.length && !persistNow()) throw new Error('could not persist initially sealed audit state');
      } catch (e) { console.error('[audit] initial chain seal failed:', e.message); }
    }
  }
  const status = verifyAuditChain();
  if (status.ok) {
    try {
      const all = parseAuditChainFile().entries;
      currentState().audit = all.slice(-AUDIT_MAX).reverse();
    } catch (_) {}
  } else {
    console.error('[audit] INTEGRITY WARNING:', status.reason || 'verification failed');
  }
}

function auditStructuredDetail(code, params, fallback) {
  const clean = {};
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(String(key))) continue;
      if (value == null) clean[key] = null;
      else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
      else clean[key] = String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 120);
    }
  }
  const payload = { code:String(code || '').slice(0,80), params:clean };
  if (fallback) payload.fallback = String(fallback).replace(/[\r\n\t]+/g, ' ').slice(0,120);
  const encode = () => '@dxlog:' + JSON.stringify(payload);
  let encoded = encode();
  if (encoded.length <= 300) return encoded;

  // Never truncate the serialized JSON itself: an invalid @dxlog record cannot
  // be translated by either UI even though its HMAC is still valid. Progressively
  // reduce optional prose/string parameters, then drop least-important parameters
  // until the record is both bounded and valid JSON.
  delete payload.fallback;
  payload.truncated = true;
  for (const maxLen of [80, 48, 24, 12]) {
    for (const key of Object.keys(payload.params)) {
      if (typeof payload.params[key] === 'string') payload.params[key] = payload.params[key].slice(0, maxLen);
    }
    encoded = encode();
    if (encoded.length <= 300) return encoded;
  }
  const keys = Object.keys(payload.params);
  while (keys.length && encoded.length > 300) {
    delete payload.params[keys.pop()];
    encoded = encode();
  }
  // code + an empty params object always fits the bound, but keep a defensive
  // fallback that is still valid structured JSON if this format changes later.
  if (encoded.length > 300) return '@dxlog:' + JSON.stringify({ code:String(code || '').slice(0,48), params:{}, truncated:true });
  return encoded;
}
function logAudit(action, opts) {
  opts = opts || {};
  const acc = opts.account || null;
  const detailValue = opts.detail && typeof opts.detail === 'object' && opts.detail.code
    ? auditStructuredDetail(opts.detail.code, opts.detail.params, opts.detail.fallback)
    : (opts.detail != null ? String(opts.detail).slice(0, 300) : null);
  const entry = {
    at: Date.now(),
    action: action,
    actor: acc ? acc.username : (opts.username || null),
    actorId: acc ? acc.id : null,
    role: acc ? acc.role : null,
    ip: opts.ip || null,
    detail: detailValue,
  };
  if (!appendAuditChainEntry(entry)) return null;
  if (!Array.isArray(currentState().audit)) currentState().audit = [];
  currentState().audit.unshift(entry);
  if (currentState().audit.length > AUDIT_MAX) currentState().audit.length = AUDIT_MAX;
  scheduleFlush();
  if (!opts.suppressSecurityAlert) securityAlertHandler(entry); // notify on sensitive events (opt-in)
  // Keep automatic Push subscription bookkeeping in the security audit, but do
  // not surface it as Activity. sanitizeActivityLog() also removes historical
  // copies from installations upgraded from <= 1.53.1.
  if (!isActivityIgnored(String(entry.action || ''))) {
    emitLiveActivity('audit', { name:entry.action, detail:entry.detail, ip:entry.ip ? pubIp(entry.ip) : null, status:entry.action, actor:entry.actor, accountId:entry.actorId });
  }
  if (/share|inbox|collab|photo|upload|delete|revok|restore/i.test(String(action || ''))) { try { scheduleSearchReindex(); } catch (_) {} }
  return entry;
}

// Audit an action performed by the currently-authenticated account (from req).
function auditReq(req, action, detail) {
  const s = (req && req.session) || {};
  return logAudit(action, {
    account: s.accountId ? getAccountById(s.accountId) : null,
    username: s.username,
    ip: clientIp(req),
    detail: detail,
  });
}


  function setSecurityAlertHandler(handler) {
    securityAlertHandler = typeof handler === 'function' ? handler : () => {};
  }
  function getIntegrityStatus() { return { ...auditIntegrityStatus }; }
  function getKeyMigrationStatus() { return auditKeyMigrationStatus ? { ...auditKeyMigrationStatus } : null; }
  function getActiveKeyMode() { return auditActiveKeyMode; }
  function getChainHead() { return { ...auditChainHead }; }

  return {
    paths: Object.freeze({
      chainFile:AUDIT_CHAIN_FILE,
      keyFile:AUDIT_KEY_FILE,
      headFile:AUDIT_HEAD_FILE,
      migrationFile:AUDIT_KEY_MIGRATION_FILE,
      migrationChainBackup:AUDIT_KEY_MIGRATION_CHAIN_BACKUP,
      migrationHeadBackup:AUDIT_KEY_MIGRATION_HEAD_BACKUP,
      signingPrivateFile:AUDIT_SIGNING_PRIVATE_FILE,
      signingPublicFile:AUDIT_SIGNING_PUBLIC_FILE,
    }),
    setSecurityAlertHandler,
    getIntegrityStatus, getKeyMigrationStatus, getActiveKeyMode, getChainHead,
    initAuditChain, verifyAuditChain, ensureAuditChainKey, auditKeyId,
    ensureAuditProofKeys, auditProofKeyId, buildAuditProof, verifyAuditProofBundle,
    parseAuditChainText, parseAuditChainFile, validateAuditRestoreEntries, verifyAuditSnapshot,
    resignAuditEntries, replaceChainForRestore,
    auditHeadSealWithKey, durableAuditWriteSync, syncAuditDataDir,
    auditStructuredDetail, logAudit, auditReq,
  };
}

module.exports = { createAuditService };
