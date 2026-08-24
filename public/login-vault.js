'use strict';
/*
 * Direct-Xfer credential-storage compatibility shim.
 *
 * ASVS 5.0 Level 3 does not permit a reusable account password to be retained in
 * browser storage, even when the record is encrypted with an origin-bound key.
 * Keep the old DXLoginVault API temporarily so existing login scripts do not
 * break, but never store or return credentials and aggressively delete the legacy
 * IndexedDB database when a login page is opened.
 *
 * Browsers may still offer their own password-manager/autofill facilities; those
 * are browser/user-agent functionality rather than application-managed storage.
 */
(function (global) {
  var DB_NAME = 'direct-xfer-login-vault';

  function purgeLegacyVault() {
    if (!global.indexedDB) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var request;
      try { request = global.indexedDB.deleteDatabase(DB_NAME); }
      catch (_) { resolve(false); return; }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(false);
      }, 3000);
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(!!ok);
      }
      request.onsuccess = function () { finish(true); };
      request.onerror = function () { finish(false); };
      // Another old tab may still have the database open. It cannot create new
      // records through this shim; deletion will complete after legacy handles close.
      request.onblocked = function () { finish(false); };
    });
  }

  function available() { return false; }
  async function save() { await purgeLegacyVault(); return false; }
  async function load() { await purgeLegacyVault(); return null; }
  async function clear() { return purgeLegacyVault(); }

  // Begin migration immediately instead of waiting for the first form action.
  void purgeLegacyVault();

  global.DXLoginVault = Object.freeze({
    available: available,
    save: save,
    load: load,
    clear: clear
  });
})(window);
