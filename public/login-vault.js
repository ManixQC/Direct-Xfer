'use strict';
/*
 * Direct-Xfer encrypted browser credential vault.
 *
 * Normal deployments may opt in to "remember password". The reusable password is
 * encrypted with AES-256-GCM using a non-extractable WebCrypto key stored as a
 * CryptoKey object in IndexedDB; plaintext passwords are never written to browser
 * storage. The server remains authoritative for whether this feature is permitted.
 * ASVS L3 advertises loginPasswordStorageAllowed=false and the vault then fails
 * closed, deletes any legacy/browser-managed Direct-Xfer vault, and returns no
 * credential.
 */
(function (global) {
  var DB_NAME = 'direct-xfer-login-vault';
  var DB_VERSION = 2;
  var STORE = 'vault';
  var KEY_ID = 'aes-key-v2';
  var RECORD_ID = 'credential-v2';
  var MAX_USERNAME = 512;
  var MAX_PASSWORD = 4096;
  var POLICY_TTL_MS = 30000;
  var policyCache = null;
  var policyCacheAt = 0;

  function browserAvailable() {
    return !!(global.isSecureContext && global.indexedDB && global.crypto && global.crypto.subtle && global.TextEncoder && global.TextDecoder);
  }

  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('indexeddb-request-failed')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('indexeddb-transaction-failed')); };
      tx.onabort = function () { reject(tx.error || new Error('indexeddb-transaction-aborted')); };
    });
  }

  function openDb() {
    if (!global.indexedDB) return Promise.reject(new Error('indexeddb-unavailable'));
    return new Promise(function (resolve, reject) {
      var request;
      try { request = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('indexeddb-open-failed')); };
      request.onblocked = function () { reject(new Error('indexeddb-open-blocked')); };
    });
  }

  function deleteDatabase() {
    if (!global.indexedDB) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var request;
      try { request = global.indexedDB.deleteDatabase(DB_NAME); }
      catch (_) { resolve(false); return; }
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; resolve(false); } }, 2500);
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(!!ok);
      }
      request.onsuccess = function () { finish(true); };
      request.onerror = function () { finish(false); };
      request.onblocked = function () { finish(false); };
    });
  }

  async function policyStatus(force) {
    var now = Date.now();
    if (!force && policyCache && now - policyCacheAt < POLICY_TTL_MS) return policyCache;
    var result = { available:browserAvailable(), allowed:false };
    if (!result.available || typeof global.fetch !== 'function') {
      policyCache = result; policyCacheAt = now; return result;
    }
    try {
      var response = await global.fetch('/api/meta', { credentials:'same-origin', cache:'no-store', headers:{ Accept:'application/json' } });
      var meta = response && response.ok ? await response.json() : null;
      result.allowed = !!(meta && meta.loginPasswordStorageAllowed === true);
    } catch (_) {
      result.allowed = false;
    }
    policyCache = result; policyCacheAt = now;
    if (!result.allowed) await deleteDatabase();
    return result;
  }

  function aadBytes() {
    return new TextEncoder().encode('Direct-Xfer login vault v2\n' + String(global.location && global.location.origin || ''));
  }

  async function readStore(db, id) {
    var tx = db.transaction(STORE, 'readonly');
    return requestPromise(tx.objectStore(STORE).get(id));
  }

  async function writeStore(db, id, value) {
    var tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, id);
    await txDone(tx);
  }

  async function deleteStore(db, id) {
    var tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await txDone(tx);
  }

  function validAesKey(key) {
    return !!(key && key.type === 'secret' && key.extractable === false && key.algorithm && key.algorithm.name === 'AES-GCM');
  }

  async function getOrCreateKey(db) {
    var key = await readStore(db, KEY_ID).catch(function () { return null; });
    if (validAesKey(key)) return key;
    key = await global.crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, false, ['encrypt', 'decrypt']);
    await writeStore(db, KEY_ID, key);
    return key;
  }

  async function save(username, password) {
    var policy = await policyStatus(true);
    if (!policy.available || !policy.allowed) return false;
    username = String(username || '');
    password = String(password || '');
    if (!username || !password || username.length > MAX_USERNAME || password.length > MAX_PASSWORD) return false;
    var db;
    try {
      db = await openDb();
      var key = await getOrCreateKey(db);
      var iv = global.crypto.getRandomValues(new Uint8Array(12));
      var plain = new TextEncoder().encode(JSON.stringify({ v:2, username:username, password:password }));
      var ciphertext = await global.crypto.subtle.encrypt({ name:'AES-GCM', iv:iv, additionalData:aadBytes(), tagLength:128 }, key, plain);
      await writeStore(db, RECORD_ID, {
        v:2,
        iv:Array.from(iv),
        ciphertext:Array.from(new Uint8Array(ciphertext)),
        updatedAt:Date.now()
      });
      return true;
    } catch (_) {
      return false;
    } finally {
      if (db) try { db.close(); } catch (_) {}
    }
  }

  async function load() {
    var policy = await policyStatus(true);
    if (!policy.available || !policy.allowed) return null;
    var db;
    try {
      db = await openDb();
      var key = await readStore(db, KEY_ID);
      var record = await readStore(db, RECORD_ID);
      if (!validAesKey(key) || !record || record.v !== 2 || !Array.isArray(record.iv) || !Array.isArray(record.ciphertext)) return null;
      if (record.iv.length !== 12 || record.ciphertext.length < 17 || record.ciphertext.length > 16384) return null;
      var plain = await global.crypto.subtle.decrypt({ name:'AES-GCM', iv:new Uint8Array(record.iv), additionalData:aadBytes(), tagLength:128 }, key, new Uint8Array(record.ciphertext));
      var parsed = JSON.parse(new TextDecoder().decode(plain));
      if (!parsed || parsed.v !== 2) return null;
      var username = String(parsed.username || '');
      var password = String(parsed.password || '');
      if (!username || !password || username.length > MAX_USERNAME || password.length > MAX_PASSWORD) return null;
      return { username:username, password:password };
    } catch (_) {
      // Corruption/key loss must never expose stale data or create a retry loop.
      await deleteDatabase();
      return null;
    } finally {
      if (db) try { db.close(); } catch (_) {}
    }
  }

  async function clear() {
    var policy = await policyStatus(false);
    if (!policy.allowed) return deleteDatabase();
    var db;
    try {
      db = await openDb();
      await deleteStore(db, RECORD_ID);
      return true;
    } catch (_) {
      return deleteDatabase();
    } finally {
      if (db) try { db.close(); } catch (_) {}
    }
  }

  global.DXLoginVault = Object.freeze({
    available: browserAvailable,
    status: policyStatus,
    save: save,
    load: load,
    clear: clear
  });
})(window);
