'use strict';
/*
 * Direct-Xfer login vault.
 *
 * The password is encrypted with an origin-bound, non-extractable AES-GCM key
 * stored by IndexedDB. This gives the login pages a reliable "remember
 * password" option even when the browser's Credential Management API declines
 * to return a saved credential. The browser password manager is still used as
 * a secondary integration by the page scripts.
 *
 * This protects against accidental plaintext disclosure in localStorage. As
 * with every browser password vault, JavaScript running in the same origin and
 * an unlocked browser profile can use the saved credential, so Direct-Xfer's
 * CSP and XSS protections remain important.
 */
(function (global) {
  var DB_NAME = 'direct-xfer-login-vault';
  var DB_VERSION = 1;
  var STORE = 'entries';
  var KEY_ID = 'aes-key';
  var CREDENTIAL_ID = 'admin-credential';

  function available() {
    return !!(global.indexedDB && global.crypto && global.crypto.subtle && global.TextEncoder && global.TextDecoder);
  }

  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
    });
  }

  function openDb() {
    if (!available()) return Promise.reject(new Error('Secure browser storage unavailable'));
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('Could not open login vault')); };
      request.onblocked = function () { reject(new Error('Login vault upgrade blocked')); };
    });
  }

  async function withStore(mode, callback) {
    var db = await openDb();
    try {
      var tx = db.transaction(STORE, mode);
      var store = tx.objectStore(STORE);
      var completion = new Promise(function (resolve, reject) {
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error || new Error('Login vault transaction failed')); };
        tx.onabort = function () { reject(tx.error || new Error('Login vault transaction aborted')); };
      });
      var result = await callback(store);
      await completion;
      return result;
    } finally {
      db.close();
    }
  }

  async function readEntry(id) {
    return withStore('readonly', function (store) { return requestPromise(store.get(id)); });
  }

  async function writeEntry(entry) {
    return withStore('readwrite', function (store) { return requestPromise(store.put(entry)); });
  }

  async function deleteEntry(id) {
    return withStore('readwrite', function (store) { return requestPromise(store.delete(id)); });
  }

  async function getOrCreateKey() {
    var existing = await readEntry(KEY_ID);
    if (existing && existing.key) return existing.key;
    var key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    await writeEntry({ id: KEY_ID, key: key, createdAt: Date.now() });
    return key;
  }

  async function save(username, password) {
    if (!available()) return false;
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) return false;
    var key = await getOrCreateKey();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var payload = new TextEncoder().encode(JSON.stringify({
      version: 1,
      username: username,
      password: password,
      savedAt: Date.now()
    }));
    var cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, payload);
    await writeEntry({
      id: CREDENTIAL_ID,
      iv: iv,
      cipher: cipher,
      updatedAt: Date.now()
    });
    return true;
  }

  async function load() {
    if (!available()) return null;
    var keyEntry = await readEntry(KEY_ID);
    var record = await readEntry(CREDENTIAL_ID);
    if (!keyEntry || !keyEntry.key || !record || !record.iv || !record.cipher) return null;
    try {
      var plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
        keyEntry.key,
        record.cipher
      );
      var value = JSON.parse(new TextDecoder().decode(plain));
      if (!value || value.version !== 1 || !value.username || !value.password) return null;
      return { username: String(value.username), password: String(value.password), savedAt: Number(value.savedAt) || 0 };
    } catch (_) {
      await deleteEntry(CREDENTIAL_ID).catch(function () {});
      return null;
    }
  }

  async function clear() {
    if (!available()) return false;
    await deleteEntry(CREDENTIAL_ID).catch(function () {});
    return true;
  }

  global.DXLoginVault = Object.freeze({
    available: available,
    save: save,
    load: load,
    clear: clear
  });
})(window);
