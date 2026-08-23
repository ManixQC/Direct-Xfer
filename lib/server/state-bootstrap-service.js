'use strict';

const {
  applyWindowsInstallPreferences,
  consumeWindowsInstallPreferenceMarkers,
} = require('./windows-install-preferences');

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`state-bootstrap-service requires ${label}()`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`state-bootstrap-service requires ${label}`);
  }
  return value;
}

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Persistent-state startup coordinator.
 *
 * Owns the one-time sequence that used to live inline in server.js:
 *   1. load/normalize shares.json without ever replacing an unreadable store;
 *   2. apply startup migrations and one-shot Windows install preferences;
 *   3. persist migrations before consuming external marker files;
 *   4. recover interrupted restore transactions;
 *   5. initialize audit/account state and trim durable transfer history;
 *   6. defer the potentially expensive legacy photo migration.
 *
 * The state-store remains responsible for durable I/O and restore-service remains
 * responsible for transactional rollback. This service only coordinates startup
 * ordering and root-state replacement.
 */
function createStateBootstrapService(options = {}) {
  const {
    fs,
    stateStore,
    getState,
    replaceState,
    DEFAULT_SETTINGS,
    HISTORY_MAX,
    AUDIT_MAX,
    normalizePhotoHistory,
    sanitizeUndoLog,
    sanitizeActivityLog,
    buildLegacyActivityLog,
    syncLiveActivityCache,
    migrateLegacyFirstUseExpiryState,
    sanitizeDlpQuarantineState,
    reconcileDlpQuarantineFiles,
    cleanupDlpQuarantineOrphans,
    reindex,
    persistNow,
    recoverInterruptedCoreRestore,
    recoverInterruptedSecretRestore,
    recoverInterruptedTlsRestore,
    initAuditChain,
    ensureAuditProofKeys,
    initAccounts,
    trimLogIfNeeded,
    pruneHistory,
    migrateLegacyPhotoStorage,
    env = process.env,
    exit = (code) => process.exit(code),
    defer = setImmediate,
    logger = console,
  } = options;

  requireObject(fs, 'fs');
  requireFunction(fs.unlinkSync, 'fs.unlinkSync');
  requireObject(stateStore, 'stateStore');
  requireFunction(stateStore.load, 'stateStore.load');
  requireFunction(getState, 'getState');
  requireFunction(replaceState, 'replaceState');
  requireObject(DEFAULT_SETTINGS, 'DEFAULT_SETTINGS');
  requireFunction(normalizePhotoHistory, 'normalizePhotoHistory');
  requireFunction(sanitizeUndoLog, 'sanitizeUndoLog');
  requireFunction(sanitizeActivityLog, 'sanitizeActivityLog');
  requireFunction(buildLegacyActivityLog, 'buildLegacyActivityLog');
  requireFunction(syncLiveActivityCache, 'syncLiveActivityCache');
  requireFunction(migrateLegacyFirstUseExpiryState, 'migrateLegacyFirstUseExpiryState');
  requireFunction(sanitizeDlpQuarantineState, 'sanitizeDlpQuarantineState');
  requireFunction(reconcileDlpQuarantineFiles, 'reconcileDlpQuarantineFiles');
  requireFunction(cleanupDlpQuarantineOrphans, 'cleanupDlpQuarantineOrphans');
  requireFunction(reindex, 'reindex');
  requireFunction(persistNow, 'persistNow');
  requireFunction(recoverInterruptedCoreRestore, 'recoverInterruptedCoreRestore');
  requireFunction(recoverInterruptedSecretRestore, 'recoverInterruptedSecretRestore');
  requireFunction(recoverInterruptedTlsRestore, 'recoverInterruptedTlsRestore');
  requireFunction(initAuditChain, 'initAuditChain');
  requireFunction(ensureAuditProofKeys, 'ensureAuditProofKeys');
  requireFunction(initAccounts, 'initAccounts');
  requireFunction(trimLogIfNeeded, 'trimLogIfNeeded');
  requireFunction(pruneHistory, 'pruneHistory');
  requireFunction(migrateLegacyPhotoStorage, 'migrateLegacyPhotoStorage');
  requireFunction(exit, 'exit');
  requireFunction(defer, 'defer');

  const historyMax = Math.max(0, Number.isSafeInteger(HISTORY_MAX) ? HISTORY_MAX : 0);
  const auditMax = Math.max(0, Number.isSafeInteger(AUDIT_MAX) ? AUDIT_MAX : 0);

  function normalizeLoadedState(parsed) {
    requireObject(parsed, 'loaded state');
    if (!Array.isArray(parsed.shares)) throw new TypeError('state-bootstrap-service loaded state is missing shares');
    return {
      version: 1,
      shares: parsed.shares.slice(),
      trash: Array.isArray(parsed.trash) ? parsed.trash.slice() : [],
      settings: { ...DEFAULT_SETTINGS, ...plainRecord(parsed.settings) },
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, historyMax) : [],
      photoHistory: normalizePhotoHistory(parsed.photoHistory),
      stats: { ...plainRecord(parsed.stats) },
      meta: { ...plainRecord(parsed.meta) },
      audit: Array.isArray(parsed.audit) ? parsed.audit.slice(0, auditMax) : [],
      ipNames: { ...plainRecord(parsed.ipNames) },
      undoLog: sanitizeUndoLog(parsed.undoLog),
      activityLog: sanitizeActivityLog(parsed.activityLog),
    };
  }

  function failStoreLoad(error) {
    if (error && error.code === 'DATA_KEY_REQUIRED') {
      logger.error('[store] shares.json is encrypted but DATA_KEY is not set. Refusing to start (would overwrite your data). Set the DATA_KEY environment variable to the key used to encrypt it.');
    } else if (error && error.code === 'DATA_KEY_INVALID') {
      logger.error('[store] shares.json could not be decrypted — DATA_KEY is wrong or the file is corrupt. Refusing to start.');
    } else {
      logger.error('[store] shares.json exists but is unreadable/invalid. Refusing to start to avoid overwriting recoverable data:', error && error.message ? error.message : error);
    }
    exit(1);
    return { loaded:false, activityMigrated:false, fatal:true };
  }

  function loadPersistentState() {
    let parsed;
    let nextState;
    try {
      parsed = stateStore.load();
      nextState = normalizeLoadedState(parsed);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { loaded:false, activityMigrated:false, fatal:false };
      return failStoreLoad(error);
    }

    let activityMigrated = false;
    if (!Array.isArray(parsed.activityLog)) {
      nextState.activityLog = buildLegacyActivityLog(nextState.audit, nextState.history);
      activityMigrated = true;
    }
    replaceState(nextState);
    // Runtime projection failures are not evidence that shares.json is corrupt. Let
    // them surface with their real error instead of misreporting a data-key/store
    // failure and invoking the destructive-startup safety path.
    syncLiveActivityCache();
    return { loaded:true, activityMigrated, fatal:false };
  }

  function runStartupMigrations(activityMigrated) {
    const currentState = getState();
    if (!currentState || typeof currentState !== 'object' || Array.isArray(currentState)
        || !currentState.settings || typeof currentState.settings !== 'object' || Array.isArray(currentState.settings)) {
      throw new Error('state-bootstrap-invalid-live-state');
    }

    const installPreferences = applyWindowsInstallPreferences(currentState, env || {});
    const lifecycleMigrated = !!migrateLegacyFirstUseExpiryState();
    const quarantineStateMigrated = !!sanitizeDlpQuarantineState();
    const quarantineFilesMigrated = !!reconcileDlpQuarantineFiles();
    const quarantineMigrated = quarantineStateMigrated || quarantineFilesMigrated;

    // Indexes must reflect the normalized/migrated state before any HTTP route can
    // observe it. Keep this before the optional durable migration commit just as in
    // the historical bootstrap sequence.
    reindex();

    const changed = lifecycleMigrated || !!activityMigrated || quarantineMigrated || !!installPreferences.changed;
    const migrationsPersisted = !changed || !!persistNow();
    if (migrationsPersisted) {
      consumeWindowsInstallPreferenceMarkers(fs, installPreferences.markers);
      // Quarantine is an internal managed directory. Only clean orphan files after
      // all metadata migrations are known to be durably persisted.
      cleanupDlpQuarantineOrphans();
    }

    return {
      changed,
      migrationsPersisted,
      lifecycleMigrated,
      activityMigrated:!!activityMigrated,
      quarantineMigrated,
      installPreferencesChanged:!!installPreferences.changed,
    };
  }

  function recoverInterruptedRestores() {
    recoverInterruptedCoreRestore();
    recoverInterruptedSecretRestore();
    recoverInterruptedTlsRestore();
  }

  function initializeSecurityAndHistory() {
    initAuditChain();
    ensureAuditProofKeys();
    initAccounts();
    trimLogIfNeeded();
    pruneHistory();
  }

  function deferLegacyPhotoMigration() {
    defer(() => {
      Promise.resolve()
        .then(() => migrateLegacyPhotoStorage())
        .catch((error) => logger.error('[images] migration failed:', error && error.message ? error.message : error));
    });
  }

  function initialize() {
    const loadResult = loadPersistentState();
    if (loadResult.fatal) return { ...loadResult, initialized:false };

    const migrations = runStartupMigrations(loadResult.activityMigrated);
    recoverInterruptedRestores();
    initializeSecurityAndHistory();
    deferLegacyPhotoMigration();

    return {
      ...loadResult,
      ...migrations,
      initialized:true,
    };
  }

  return Object.freeze({
    normalizeLoadedState,
    loadPersistentState,
    runStartupMigrations,
    recoverInterruptedRestores,
    initializeSecurityAndHistory,
    deferLegacyPhotoMigration,
    initialize,
  });
}

module.exports = { createStateBootstrapService };
