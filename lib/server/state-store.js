'use strict';

const path = require('path');

/**
 * Persistent state boundary for Direct-Xfer.
 *
 * Owns shares.json I/O, optional DATA_KEY encryption, atomic replacement,
 * debounced writes, retry scheduling and write-generation ordering. Domain
 * normalization/migrations intentionally stay in server.js so this service has
 * one responsibility: safely move the current root state to/from disk.
 */
function createStateStore(options = {}) {
  const {
    fs,
    crypto,
    dataDir,
    dataKey = '',
    getState,
    flushDelayMs = 3000,
    retryDelayMs = 15000,
    processId = process.pid,
    logger = console,
  } = options;

  if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFile !== 'function') {
    throw new TypeError('state-store requires fs');
  }
  if (!crypto || typeof crypto.scryptSync !== 'function' || typeof crypto.createCipheriv !== 'function') {
    throw new TypeError('state-store requires crypto');
  }
  if (typeof getState !== 'function') throw new TypeError('state-store requires getState()');
  if (!dataDir) throw new TypeError('state-store requires dataDir');

  const storeFile = path.join(String(dataDir), 'shares.json');
  const storeTmp = storeFile + '.tmp';
  const secret = String(dataKey || '');
  const flushDelay = Math.max(0, Number(flushDelayMs) || 0);
  const retryDelay = Math.max(1, Number(retryDelayMs) || 15000);

  let writeChain = Promise.resolve();
  let persistGeneration = 0;
  let dirty = false;
  let flushTimer = null;
  let persistRetryTimer = null;
  let encKeyCache = null; // { salt: Buffer, key: Buffer }
  let lastPersistError = null;

  function logError(prefix, error) {
    try { logger.error(prefix, error && error.message ? error.message : error); } catch (_) {}
  }

  function storeTempPath(generation, kind) {
    return `${storeTmp}.${processId}.${generation}.${kind}`;
  }

  function discardStoreTemp(file, done) {
    fs.unlink(file, () => { if (done) done(); });
  }

  function clearPersistRetry() {
    if (!persistRetryTimer) return;
    clearTimeout(persistRetryTimer);
    persistRetryTimer = null;
  }

  function schedulePersistRetry() {
    dirty = true;
    if (persistRetryTimer) return;
    persistRetryTimer = setTimeout(() => {
      persistRetryTimer = null;
      if (!dirty) return;
      dirty = false;
      persist();
    }, retryDelay);
    if (persistRetryTimer.unref) persistRetryTimer.unref();
  }

  function deriveDataKey(salt) {
    if (encKeyCache && encKeyCache.salt.equals(salt)) return encKeyCache.key;
    const key = crypto.scryptSync(secret, salt, 32);
    encKeyCache = { salt, key };
    return key;
  }

  function encryptStore(json) {
    const salt = (encKeyCache && encKeyCache.salt) || crypto.randomBytes(16);
    const key = deriveDataKey(salt);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(json), 'utf8'), cipher.final()]);
    return JSON.stringify({
      dxenc: 1,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: encrypted.toString('base64'),
    });
  }

  function decryptStore(envelope) {
    const key = deriveDataKey(Buffer.from(envelope.salt, 'hex'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  function serializeState() {
    const json = JSON.stringify(getState(), null, 2);
    return secret ? encryptStore(json) : json;
  }

  function deserializeStore(raw) {
    const obj = JSON.parse(raw);
    if (obj && obj.dxenc) {
      if (!secret) {
        const error = new Error('data-key-required');
        error.code = 'DATA_KEY_REQUIRED';
        throw error;
      }
      try {
        return JSON.parse(decryptStore(obj));
      } catch (_) {
        const error = new Error('data-key-invalid');
        error.code = 'DATA_KEY_INVALID';
        throw error;
      }
    }
    return obj;
  }

  function load() {
    const raw = fs.readFileSync(storeFile, 'utf8');
    const parsed = deserializeStore(raw);
    if (!parsed || !Array.isArray(parsed.shares)) {
      const error = new Error('invalid-store');
      error.code = 'INVALID_STORE';
      throw error;
    }
    return parsed;
  }

  function persist() {
    writeChain = writeChain
      .then(
        () => new Promise((resolve) => {
          // Capture the newest state only when this queued write reaches the
          // front of the chain. A generation check prevents an older async
          // snapshot from replacing a later critical persistNow() commit.
          const generation = ++persistGeneration;
          const tempFile = storeTempPath(generation, 'async');
          const snapshot = serializeState();
          fs.writeFile(tempFile, snapshot, { mode: 0o600 }, (error) => {
            if (error) {
              // A newer persistNow() may already have committed after this async
              // write began. Do not let a stale callback mark the store dirty or
              // schedule a redundant retry over that newer durable generation.
              if (generation === persistGeneration) {
                lastPersistError = error;
                logError('[store] temp write failed:', error);
                schedulePersistRetry();
              }
              return discardStoreTemp(tempFile, resolve);
            }
            if (generation !== persistGeneration) return discardStoreTemp(tempFile, resolve);
            try {
              fs.renameSync(tempFile, storeFile);
              lastPersistError = null;
              clearPersistRetry();
              resolve();
            } catch (renameError) {
              lastPersistError = renameError;
              logError('[store] rename failed:', renameError);
              schedulePersistRetry();
              discardStoreTemp(tempFile, resolve);
            }
          });
        })
      )
      .catch((error) => {
        lastPersistError = error;
        logError('[store] persistence error:', error);
        schedulePersistRetry();
      });
    return writeChain;
  }

  function persistNow() {
    dirty = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const generation = ++persistGeneration;
    const tempFile = storeTempPath(generation, 'sync');
    try {
      fs.writeFileSync(tempFile, serializeState(), { mode: 0o600 });
      fs.renameSync(tempFile, storeFile);
      lastPersistError = null;
      clearPersistRetry();
      return true;
    } catch (error) {
      lastPersistError = error;
      try { fs.unlinkSync(tempFile); } catch (_) {}
      logError('[store] durable write failed:', error);
      schedulePersistRetry();
      return false;
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      persist();
    }, flushDelay);
    if (flushTimer.unref) flushTimer.unref();
  }

  async function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (dirty) {
      dirty = false;
      persist();
    }
    await writeChain;

    // An async write can fail while flushNow() is awaiting the chain; persist()
    // records that failure and schedules a later retry. During controlled
    // shutdown there may be no "later", so make one immediate durable attempt
    // and reject if it also fails. The shutdown coordinator can then exit
    // non-zero instead of reporting an unpersisted state as clean.
    if (dirty || lastPersistError) {
      clearPersistRetry();
      dirty = false;
      if (!persistNow()) {
        const error = new Error('final-persistence-failed');
        error.code = 'FINAL_PERSISTENCE_FAILED';
        throw error;
      }
    }
    return true;
  }

  // Test/controlled-shutdown helper. Does not discard dirty state: callers that
  // need durability must await flushNow() first.
  function close() {
    if (flushTimer) clearTimeout(flushTimer);
    if (persistRetryTimer) clearTimeout(persistRetryTimer);
    flushTimer = null;
    persistRetryTimer = null;
  }

  return {
    storeFile,
    encryptStore,
    decryptStore,
    serializeState,
    deserializeStore,
    load,
    persist,
    persistNow,
    scheduleFlush,
    schedulePersistRetry,
    flushNow,
    close,
  };
}

module.exports = { createStateStore };
