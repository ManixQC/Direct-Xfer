'use strict';

/**
 * Transactional backup restore boundary.
 *
 * The service owns validation, staging, filesystem swaps, rollback and interrupted
 * TLS recovery. Direct-Xfer's composition root supplies a live state bridge and
 * one state-replacement coordinator so replacing the root object never leaves a
 * service holding stale maps or caches.
 */
function createRestoreService(deps = {}) {
  const {
    fs, path, crypto, forge,
    DATA_DIR, SECRETS_DIR, LOG_FILE, AUDIT_CHAIN_FILE, AUDIT_HEAD_FILE,
    DEFAULT_SETTINGS, HISTORY_MAX, AUDIT_MAX, ASVS_L3_MODE = false,
    getState, replaceState, getHistoryViewRevision, setHistoryViewRevision,
    parseAuditChainText, validateAuditRestoreEntries, ensureAuditChainKey,
    auditKeyId, timingSafeEqualStr, verifyAuditSnapshot, verifyAuditChain,
    parseAuditChainFile, replaceChainForRestore,
    stateReplacementCoordinator,
    tlsDirPath, validateLocalCaCertificate, validateLeafCertificate,
    markTlsRestartRequired,
    normalizePhotoHistory, sanitizeUndoLog, sanitizeActivityLog,
    sanitizeDlpQuarantineState, reconcileDlpQuarantineFiles,
    syncLiveActivityCache, buildLegacyActivityLog,
    migrateLegacyFirstUseExpiryState, clearShareRuntimeState,
    persistNow, cleanupDlpQuarantineOrphans, migrateLegacyPhotoStorage,
    prepareAccountState = (candidate) => candidate,
    defer = setImmediate,
    logger = console,
  } = deps;

  function validBackupBase64(value) {
    const raw = String(value == null ? '' : value);
    return !!raw && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw);
  }

  // Re-sign a trusted backup audit journal with the currently active key. This
  // preserves the complete append-only history without importing signing secrets.
  function restoredAuditEntries(bundle) {
    const audit = bundle && bundle.audit && typeof bundle.audit === 'object' ? bundle.audit : null;
    const b64 = audit && String(audit.chain || '');
    if (b64) {
      if (!validBackupBase64(b64)) throw new Error('invalid-audit-backup');
      const chainRaw = Buffer.from(b64, 'base64');
      const parsed = parseAuditChainText(chainRaw.toString('utf8'));
      if (parsed.malformed) throw new Error('invalid-audit-backup');

      const headB64 = String(audit.head || '');
      if (Number(bundle && bundle.v) >= 3 && !headB64) throw new Error('invalid-audit-backup');
      let sourceHead = null;
      let headRaw = null;
      if (headB64) {
        if (!validBackupBase64(headB64)) throw new Error('invalid-audit-backup');
        headRaw = Buffer.from(headB64, 'base64');
        try { sourceHead = JSON.parse(headRaw.toString('utf8')); }
        catch (_) { throw new Error('invalid-audit-backup'); }
      }

      const structural = validateAuditRestoreEntries(parsed.entries, sourceHead);
      if (!structural.ok) throw new Error('invalid-audit-backup:' + structural.reason);

      const sourceKeyId = String(audit.keyId || '');
      const currentKey = ensureAuditChainKey();
      const currentKeyId = auditKeyId(currentKey);
      if (sourceKeyId && timingSafeEqualStr(sourceKeyId, currentKeyId)) {
        if (!headRaw) throw new Error('invalid-audit-backup');
        const verified = verifyAuditSnapshot(chainRaw, headRaw, currentKey);
        if (!verified.ok) throw new Error('invalid-audit-backup:' + (verified.reason || 'audit-authentication-failed'));
      }
      return parsed.entries;
    }

    // v1 did not contain the external audit chain. Keep the current complete
    // chain, but authenticate it before it can participate in a restore.
    const currentIntegrity = verifyAuditChain();
    if (!currentIntegrity.ok) throw new Error('invalid-audit-backup:' + (currentIntegrity.reason || 'current-audit-invalid'));
    try { return parseAuditChainFile().entries; }
    catch (_) { throw new Error('invalid-audit-backup'); }
  }

  if (!stateReplacementCoordinator || typeof stateReplacementCoordinator !== 'object') {
    throw new TypeError('restore-service requires stateReplacementCoordinator');
  }
  if (typeof stateReplacementCoordinator.isBusyForStateReplacement !== 'function') {
    throw new TypeError('restore-service requires stateReplacementCoordinator.isBusyForStateReplacement()');
  }
  if (typeof stateReplacementCoordinator.clearRuntimeAfterRestore !== 'function') {
    throw new TypeError('restore-service requires stateReplacementCoordinator.clearRuntimeAfterRestore()');
  }

  function restoreIsBusy() {
    try {
      return !!stateReplacementCoordinator.isBusyForStateReplacement();
    } catch (error) {
      // Restore readiness is a safety boundary. In particular, the final busy
      // check runs from req.on('end'), outside Express' synchronous handler guard.
      // A broken/late probe must therefore fail closed instead of escaping as an
      // uncaught exception while a destructive state replacement is being armed.
      try {
        logger.error('[restore] state replacement readiness check failed; refusing restore:', error && error.message);
      } catch (_) {}
      return true;
    }
  }

  function clearRuntimeAfterRestore() {
    return stateReplacementCoordinator.clearRuntimeAfterRestore();
  }

  function snapshotRestoreFile(file) {
    try { return { exists:true, data:fs.readFileSync(file) }; }
    catch (error) {
      if (error && error.code === 'ENOENT') return { exists:false, data:null };
      throw error;
    }
  }

  function replaceFileSync(source, destination) {
    // Node replaces an existing file destination on every supported platform.
    // Never unlink first: a crash between unlink and rename would lose the
    // durable state or rollback marker that makes restore recovery possible.
    fs.renameSync(source, destination);
  }

  function restoreFileSnapshot(file, snapshot) {
    if (!snapshot || !snapshot.exists) {
      try { fs.unlinkSync(file); }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      return;
    }
    const tmp = file + '.rollback-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    writeDurableSnapshot(tmp, snapshot.data);
    replaceFileSync(tmp, file);
    fsyncDirectoryQuietly(path.dirname(file));
  }

  function removeFileStrict(file) {
    try { fs.unlinkSync(file); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }

  function writeDurableSnapshot(file, data, mode = 0o600) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', mode);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
    }
  }

  function fsyncDirectoryQuietly(directory) {
    if (process.platform === 'win32') return;
    let fd = null;
    try {
      fd = fs.openSync(directory, 'r');
      fs.fsyncSync(fd);
    } catch (_) {
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
    }
  }

  function coreRestoreTransactionFile() {
    return path.join(DATA_DIR, '.restore-transaction.json');
  }

  function coreRestoreSnapshotPath(kind, id) {
    return path.join(DATA_DIR, `.restore-snapshot-${kind}-${id}`);
  }

  function validGeneratedRestoreSibling(file, directory, prefix) {
    const resolved = path.resolve(String(file || ''));
    const basename = path.basename(resolved);
    return path.dirname(resolved) === path.resolve(directory)
      && basename.startsWith(prefix)
      && /^\d+-[a-f0-9]{10}$/i.test(basename.slice(prefix.length));
  }

  function validCoreRestoreSnapshot(file, kind, id) {
    return path.resolve(String(file || '')) === path.resolve(coreRestoreSnapshotPath(kind, id));
  }

  function clearCoreRestoreTransaction() {
    try { fs.unlinkSync(coreRestoreTransactionFile()); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') logger.warn('[restore] core transaction marker cleanup failed:', error.message);
    }
  }

  function beginCoreRestoreTransaction(snapshots, journalStage) {
    if (fs.existsSync(coreRestoreTransactionFile())) throw new Error('restore-recovery-required');
    const id = crypto.randomBytes(12).toString('hex');
    const transaction = {
      v:1,
      id,
      journalStage:path.resolve(journalStage),
      files:{},
      phase:'prepared',
    };
    const entries = [
      ['journal', snapshots.journal],
      ['audit-chain', snapshots.auditChain],
      ['audit-head', snapshots.auditHead],
    ];
    try {
      for (const [kind, snapshot] of entries) {
        const backup = coreRestoreSnapshotPath(kind, id);
        transaction.files[kind] = { backup:path.resolve(backup), exists:!!(snapshot && snapshot.exists) };
        if (snapshot && snapshot.exists) writeDurableSnapshot(backup, snapshot.data);
      }
      writeDurableRestoreTransaction(coreRestoreTransactionFile(), transaction);
      return transaction;
    } catch (error) {
      for (const entry of Object.values(transaction.files)) {
        try { removeFileStrict(entry.backup); } catch (_) {}
      }
      clearCoreRestoreTransaction();
      throw error;
    }
  }

  function readCoreRestoreTransaction() {
    const file = coreRestoreTransactionFile();
    if (!fs.existsSync(file)) return null;
    try {
      const transaction = JSON.parse(fs.readFileSync(file, 'utf8'));
      const files = transaction && transaction.files;
      const fileKinds = files && typeof files === 'object' && !Array.isArray(files) ? Object.keys(files).sort() : [];
      if (!transaction || transaction.v !== 1 || !/^[a-f0-9]{16,64}$/i.test(String(transaction.id || ''))
          || !['prepared', 'rolled-back'].includes(String(transaction.phase || ''))
          || !files || typeof files !== 'object' || Array.isArray(files)
          || fileKinds.join(',') !== 'audit-chain,audit-head,journal'
          || !validGeneratedRestoreSibling(transaction.journalStage, DATA_DIR, path.basename(LOG_FILE) + '.restore-stage-')) {
        throw new Error('invalid core restore transaction marker');
      }
      for (const kind of ['journal', 'audit-chain', 'audit-head']) {
        const entry = files[kind];
        if (!entry || typeof entry.exists !== 'boolean'
            || !validCoreRestoreSnapshot(entry.backup, kind, transaction.id)) {
          throw new Error('invalid core restore snapshot marker');
        }
      }
      return transaction;
    } catch (error) {
      logger.error('[restore] core transaction marker is invalid; refusing automatic path operations:', error.message);
      return null;
    }
  }

  function cleanupCoreRestoreTransaction(transaction) {
    if (!transaction) return true;
    try {
      for (const kind of ['journal', 'audit-chain', 'audit-head']) {
        const entry = transaction.files && transaction.files[kind];
        if (entry) removeFileStrict(entry.backup);
      }
      removeFileStrict(transaction.journalStage);
      removeFileStrict(coreRestoreTransactionFile());
      return true;
    } catch (error) {
      logger.error('[restore] core transaction cleanup failed; recovery marker retained:', error.message);
      return false;
    }
  }

  function restoreCoreSnapshot(file, entry) {
    if (!entry.exists) {
      removeFileStrict(file);
      return;
    }
    const data = fs.readFileSync(entry.backup);
    restoreFileSnapshot(file, { exists:true, data });
  }

  function markCoreRestoreRolledBack(transaction) {
    transaction.phase = 'rolled-back';
    writeDurableRestoreTransaction(coreRestoreTransactionFile(), transaction);
  }

  function recoverInterruptedCoreRestore() {
    const markerFile = coreRestoreTransactionFile();
    if (!fs.existsSync(markerFile)) return;
    const transaction = readCoreRestoreTransaction();
    if (!transaction) throw new Error('invalid core restore transaction marker');
    const root = getState();
    const committed = !!(root && root.meta && root.meta.restoreCommitId === transaction.id);
    try {
      if (transaction.phase === 'rolled-back') {
        logger.warn('[restore] completed cleanup of an interrupted rolled-back core restore.');
      } else if (!committed) {
        restoreCoreSnapshot(LOG_FILE, transaction.files.journal);
        restoreCoreSnapshot(AUDIT_CHAIN_FILE, transaction.files['audit-chain']);
        restoreCoreSnapshot(AUDIT_HEAD_FILE, transaction.files['audit-head']);
        logger.warn('[restore] rolled back an interrupted uncommitted core restore.');
      } else {
        logger.warn('[restore] completed cleanup of an interrupted committed core restore.');
      }
      if (!cleanupCoreRestoreTransaction(transaction)) throw new Error('core restore cleanup incomplete');
    } catch (error) {
      logger.error('[restore] interrupted core restore recovery failed:', error.message);
      throw error;
    }
  }

  function removeTreeQuietly(target) {
    if (!target) return;
    try { fs.rmSync(target, { recursive:true, force:true }); } catch (_) {}
  }

  function removeTreeStrict(target) {
    if (!target) return;
    fs.rmSync(target, { recursive:true, force:true });
    if (fs.existsSync(target)) throw new Error('restore-tree-cleanup-failed: ' + path.basename(target));
  }

  function stageRestoreSecrets(bundle, store) {
    const metaSecrets = store && store.meta && store.meta.secrets
      && typeof store.meta.secrets === 'object' && !Array.isArray(store.meta.secrets)
      ? store.meta.secrets : {};
    const supplied = bundle && bundle.secrets;
    if ((!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
        && Object.keys(metaSecrets).length) {
      throw new Error('restore-secrets-missing');
    }
    const stage = SECRETS_DIR + '.restore-stage-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
    removeTreeQuietly(stage);
    fs.mkdirSync(stage, { recursive:true, mode:0o700 });
    try {
      for (const token of Object.keys(metaSecrets)) {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(token))) throw new Error('restore-secret-token-invalid');
        const name = token + '.dxe';
        if (!supplied || !Object.prototype.hasOwnProperty.call(supplied, name) || !validBackupBase64(supplied[name])) {
          throw new Error('restore-secret-ciphertext-missing');
        }
        writeDurableSnapshot(path.join(stage, name), Buffer.from(String(supplied[name]), 'base64'));
      }
      fsyncDirectoryQuietly(stage);
      return stage;
    } catch (error) {
      removeTreeQuietly(stage);
      throw error;
    }
  }

  function swapRestoreSecrets(stage) {
    if (fs.existsSync(secretRestoreTransactionFile())) throw new Error('restore-secret-recovery-required');
    const old = SECRETS_DIR + '.restore-old-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
    const transactionId = crypto.randomBytes(12).toString('hex');
    const hadOld = fs.existsSync(SECRETS_DIR);
    const transaction = {
      v:1,
      id:transactionId,
      stage:path.resolve(stage),
      old:path.resolve(old),
      hadOld,
      phase:'prepared',
    };
    writeSecretRestoreTransaction(transaction);
    try {
      if (hadOld) fs.renameSync(SECRETS_DIR, old);
      transaction.phase = 'old-moved';
      writeSecretRestoreTransaction(transaction);
      fs.renameSync(stage, SECRETS_DIR);
      transaction.phase = 'swapped';
      writeSecretRestoreTransaction(transaction);
    }
    catch (error) {
      let rollbackSafe = false;
      try {
        if (hadOld && fs.existsSync(old)) {
          removeTreeStrict(SECRETS_DIR);
          fs.renameSync(old, SECRETS_DIR);
        } else if (!hadOld) {
          removeTreeStrict(SECRETS_DIR);
          fs.mkdirSync(SECRETS_DIR, { recursive:true, mode:0o700 });
        }
        rollbackSafe = true;
      } catch (rollbackError) {
        logger.error('[restore] secret swap rollback failed:', rollbackError.message);
      }
      let stageClean = false;
      try { removeTreeStrict(stage); stageClean = true; }
      catch (cleanupError) { logger.error('[restore] secret stage cleanup failed:', cleanupError.message); }
      if (rollbackSafe && stageClean) clearSecretRestoreTransaction();
      throw error;
    }
    return { old, hadOld, txId:transactionId };
  }

  function rollbackRestoreSecrets(swap) {
    if (!swap) return;
    removeTreeStrict(SECRETS_DIR);
    if (swap.hadOld) fs.renameSync(swap.old, SECRETS_DIR);
    else fs.mkdirSync(SECRETS_DIR, { recursive:true, mode:0o700 });
    clearSecretRestoreTransaction();
  }

  function finalizeRestoreSecrets(swap) {
    if (swap && swap.hadOld) {
      try { removeTreeStrict(swap.old); }
      catch (error) {
        logger.error('[restore] old secret directory cleanup failed; recovery marker retained:', error.message);
        return;
      }
    }
    if (swap) clearSecretRestoreTransaction();
  }

  function secretRestoreTransactionFile() {
    return path.join(DATA_DIR, '.secrets-restore-transaction.json');
  }

  function writeSecretRestoreTransaction(transaction) {
    writeDurableRestoreTransaction(secretRestoreTransactionFile(), transaction);
  }

  function clearSecretRestoreTransaction() {
    try { fs.unlinkSync(secretRestoreTransactionFile()); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') logger.warn('[restore] secret transaction marker cleanup failed:', error.message);
    }
  }

  function validSecretRestoreSibling(file, suffix) {
    return validGeneratedRestoreSibling(
      file,
      path.dirname(SECRETS_DIR),
      path.basename(SECRETS_DIR) + suffix,
    );
  }

  function readSecretRestoreTransaction() {
    const file = secretRestoreTransactionFile();
    if (!fs.existsSync(file)) return null;
    try {
      const transaction = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!transaction || transaction.v !== 1 || !/^[a-f0-9]{16,64}$/i.test(String(transaction.id || ''))
          || typeof transaction.hadOld !== 'boolean'
          || !['prepared', 'old-moved', 'swapped'].includes(String(transaction.phase || ''))
          || !validSecretRestoreSibling(transaction.stage, '.restore-stage-')
          || !validSecretRestoreSibling(transaction.old, '.restore-old-')) {
        throw new Error('invalid secret restore transaction marker');
      }
      return transaction;
    } catch (error) {
      logger.error('[restore] secret transaction marker is invalid; refusing automatic path operations:', error.message);
      return null;
    }
  }

  function recoverInterruptedSecretRestore() {
    const markerFile = secretRestoreTransactionFile();
    if (!fs.existsSync(markerFile)) return;
    const transaction = readSecretRestoreTransaction();
    if (!transaction) throw new Error('invalid secret restore transaction marker');
    const root = getState();
    const committed = !!(root && root.meta && root.meta.secretsRestoreCommitId === transaction.id);
    try {
      if (committed) {
        removeTreeStrict(transaction.old);
        removeTreeStrict(transaction.stage);
        logger.warn('[restore] completed cleanup of an interrupted committed secret restore.');
      } else if (transaction.hadOld) {
        if (fs.existsSync(transaction.old)) {
          removeTreeStrict(SECRETS_DIR);
          fs.renameSync(transaction.old, SECRETS_DIR);
        }
        removeTreeStrict(transaction.stage);
        logger.warn('[restore] rolled back an interrupted uncommitted secret restore.');
      } else {
        if (transaction.phase === 'swapped') removeTreeStrict(SECRETS_DIR);
        removeTreeStrict(transaction.stage);
        removeTreeStrict(transaction.old);
        fs.mkdirSync(SECRETS_DIR, { recursive:true, mode:0o700 });
        logger.warn('[restore] discarded uncommitted secret restore material.');
      }
      clearSecretRestoreTransaction();
    } catch (error) {
      logger.error('[restore] interrupted secret restore recovery failed:', error.message);
      throw error;
    }
  }

  function validTlsBackupBase64(value) {
    const raw = String(value == null ? '' : value);
    return raw.length <= 3 * 1024 * 1024 && validBackupBase64(raw);
  }

  function stageRestoreTls(bundle) {
    const material = bundle && bundle.tls;
    if (!material) return null;
    // L3 has an external TLS trust/key boundary. Importing a legacy Local-CA
    // backup would re-introduce long-lived private keys into the Node process.
    if (ASVS_L3_MODE) throw new Error('asvs-l3-local-tls-restore-forbidden');
    if (!bundle._transportEncrypted) throw new Error('restore-tls-requires-encrypted-backup');
    if (!forge || !material || typeof material !== 'object' || Array.isArray(material)
        || !validTlsBackupBase64(material.localCaCert)) {
      throw new Error('restore-tls-invalid');
    }
    const stage = tlsDirPath() + '.restore-stage-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
    removeTreeQuietly(stage);
    fs.mkdirSync(stage, { recursive:true, mode:0o700 });
    try {
      const caCertPem = Buffer.from(String(material.localCaCert), 'base64').toString('utf8');
      const caCert = forge.pki.certificateFromPem(caCertPem);
      validateLocalCaCertificate(caCert, null);
      writeDurableSnapshot(path.join(stage, 'local-ca-cert.pem'), Buffer.from(caCertPem, 'utf8'), 0o644);

      let caKey = null;
      if (material.localCaKey) {
        if (!validTlsBackupBase64(material.localCaKey)) throw new Error('restore-tls-invalid-key');
        const caKeyPem = Buffer.from(String(material.localCaKey), 'base64').toString('utf8');
        caKey = forge.pki.privateKeyFromPem(caKeyPem);
        validateLocalCaCertificate(caCert, caKey);
        writeDurableSnapshot(path.join(stage, 'local-ca-key.pem'), Buffer.from(caKeyPem, 'utf8'));
      }

      const haveLeafCert = !!material.serverCert;
      const haveLeafKey = !!material.serverKey;
      if (haveLeafCert !== haveLeafKey) throw new Error('restore-tls-incomplete-leaf');
      if (haveLeafCert) {
        if (!validTlsBackupBase64(material.serverCert) || !validTlsBackupBase64(material.serverKey)) {
          throw new Error('restore-tls-invalid-leaf');
        }
        const leafCertPem = Buffer.from(String(material.serverCert), 'base64').toString('utf8');
        const leafKeyPem = Buffer.from(String(material.serverKey), 'base64').toString('utf8');
        const leafCert = forge.pki.certificateFromPem(leafCertPem);
        const leafKey = forge.pki.privateKeyFromPem(leafKeyPem);
        validateLeafCertificate(leafCert, leafKey, caCert, null, false);
        writeDurableSnapshot(path.join(stage, 'server-cert.pem'), Buffer.from(leafCertPem, 'utf8'), 0o644);
        writeDurableSnapshot(path.join(stage, 'server-key.pem'), Buffer.from(leafKeyPem, 'utf8'));
      }
      if (!caKey && !haveLeafCert) throw new Error('restore-tls-unusable');
      fsyncDirectoryQuietly(stage);
      return stage;
    } catch (error) {
      removeTreeQuietly(stage);
      throw error;
    }
  }

  function tlsRestoreTransactionFile() {
    return path.join(DATA_DIR, '.tls-restore-transaction.json');
  }

  function writeDurableRestoreTransaction(file, transaction) {
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(transaction));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      replaceFileSync(tmp, file);
      if (process.platform !== 'win32') {
        let directoryFd = null;
        try {
          directoryFd = fs.openSync(path.dirname(file), 'r');
          fs.fsyncSync(directoryFd);
        } catch (_) {
        } finally {
          if (directoryFd !== null) try { fs.closeSync(directoryFd); } catch (_) {}
        }
      }
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  function writeTlsRestoreTransaction(transaction) {
    writeDurableRestoreTransaction(tlsRestoreTransactionFile(), transaction);
  }

  function clearTlsRestoreTransaction() {
    try { fs.unlinkSync(tlsRestoreTransactionFile()); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') logger.warn('[restore] TLS transaction marker cleanup failed:', error.message);
    }
  }

  function validTlsRestoreSibling(file, prefix) {
    return validGeneratedRestoreSibling(file, DATA_DIR, prefix);
  }

  function readTlsRestoreTransaction() {
    const file = tlsRestoreTransactionFile();
    if (!fs.existsSync(file)) return null;
    try {
      const transaction = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!transaction || transaction.v !== 1 || !/^[a-f0-9]{16,64}$/i.test(String(transaction.id || ''))
          || typeof transaction.hadOld !== 'boolean'
          || !['prepared', 'old-moved', 'swapped'].includes(String(transaction.phase || ''))
          || !validTlsRestoreSibling(transaction.stage, 'tls.restore-stage-')
          || !validTlsRestoreSibling(transaction.old, 'tls.restore-old-')) {
        throw new Error('invalid TLS restore transaction marker');
      }
      return transaction;
    } catch (error) {
      logger.error('[restore] TLS transaction marker is invalid; refusing automatic path operations:', error.message);
      return null;
    }
  }

  function recoverInterruptedTlsRestore() {
    const markerFile = tlsRestoreTransactionFile();
    if (!fs.existsSync(markerFile)) return;
    const transaction = readTlsRestoreTransaction();
    if (!transaction) throw new Error('invalid TLS restore transaction marker');
    const liveTls = tlsDirPath();
    const root = getState();
    const committed = !!(root && root.meta && root.meta.tlsRestoreCommitId === transaction.id);
    try {
      if (committed) {
        removeTreeStrict(transaction.old);
        removeTreeStrict(transaction.stage);
        logger.warn('[restore] completed cleanup of an interrupted committed TLS restore.');
      } else if (transaction.hadOld) {
        if (fs.existsSync(transaction.old)) {
          removeTreeStrict(liveTls);
          fs.renameSync(transaction.old, liveTls);
        }
        removeTreeStrict(transaction.stage);
        logger.warn('[restore] rolled back an interrupted uncommitted TLS restore.');
      } else {
        if (transaction.phase === 'swapped') removeTreeStrict(liveTls);
        removeTreeStrict(transaction.stage);
        removeTreeStrict(transaction.old);
        logger.warn('[restore] discarded uncommitted TLS restore material.');
      }
      clearTlsRestoreTransaction();
    } catch (error) {
      logger.error('[restore] interrupted TLS restore recovery failed:', error.message);
      throw error;
    }
  }

  function swapRestoreTls(stage) {
    if (!stage) return null;
    if (fs.existsSync(tlsRestoreTransactionFile())) throw new Error('restore-tls-recovery-required');
    const liveTls = tlsDirPath();
    const old = liveTls + '.restore-old-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
    const transactionId = crypto.randomBytes(12).toString('hex');
    const hadOld = fs.existsSync(liveTls);
    const transaction = {
      v:1,
      id:transactionId,
      stage:path.resolve(stage),
      old:path.resolve(old),
      hadOld,
      phase:'prepared',
    };
    writeTlsRestoreTransaction(transaction);
    try {
      if (hadOld) fs.renameSync(liveTls, old);
      transaction.phase = 'old-moved';
      writeTlsRestoreTransaction(transaction);
      fs.renameSync(stage, liveTls);
      transaction.phase = 'swapped';
      writeTlsRestoreTransaction(transaction);
    } catch (error) {
      let rollbackSafe = false;
      try {
        if (hadOld && fs.existsSync(old)) {
          removeTreeStrict(liveTls);
          fs.renameSync(old, liveTls);
        } else if (!hadOld) {
          removeTreeStrict(liveTls);
        }
        rollbackSafe = true;
      } catch (rollbackError) {
        logger.error('[restore] TLS swap rollback failed:', rollbackError.message);
      }
      let stageClean = false;
      try { removeTreeStrict(stage); stageClean = true; }
      catch (cleanupError) { logger.error('[restore] TLS stage cleanup failed:', cleanupError.message); }
      if (rollbackSafe && stageClean) clearTlsRestoreTransaction();
      throw error;
    }
    return { old, hadOld, txId:transactionId };
  }

  function rollbackRestoreTls(swap) {
    if (!swap) return;
    const liveTls = tlsDirPath();
    removeTreeStrict(liveTls);
    if (swap.hadOld && fs.existsSync(swap.old)) fs.renameSync(swap.old, liveTls);
    clearTlsRestoreTransaction();
  }

  function finalizeRestoreTls(swap) {
    if (swap && swap.hadOld) {
      try { removeTreeStrict(swap.old); }
      catch (error) {
        logger.error('[restore] old TLS directory cleanup failed; recovery marker retained:', error.message);
        return;
      }
    }
    if (swap) clearTlsRestoreTransaction();
  }

  function restoredState(store) {
    const plainRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const restoredMeta = { ...plainRecord(store.meta) };
    if (Array.isArray(restoredMeta.accounts)) {
      restoredMeta.accounts = restoredMeta.accounts.map((account) => (
        account && typeof account === 'object' && !Array.isArray(account) ? { ...account } : account
      ));
    }
    return {
      version:1,
      shares:store.shares,
      trash:Array.isArray(store.trash) ? store.trash : [],
      settings:{ ...DEFAULT_SETTINGS, ...plainRecord(store.settings) },
      history:Array.isArray(store.history) ? store.history.slice(0, HISTORY_MAX) : [],
      photoHistory:normalizePhotoHistory(store.photoHistory),
      stats:plainRecord(store.stats),
      meta:restoredMeta,
      audit:[],
      ipNames:plainRecord(store.ipNames),
      undoLog:sanitizeUndoLog(store.undoLog),
      activityLog:sanitizeActivityLog(store.activityLog),
    };
  }

  // Replaces the complete store, journal, secret notes and audit history. Encrypted
  // v3 backups can also restore the managed Local CA. Every external artifact is
  // staged before the first live swap and rolled back on a failed commit.
  function applyRestore(bundle) {
    const store = bundle.store || {};
    if (!Array.isArray(store.shares) || typeof bundle.journal !== 'string') {
      const error = new Error('invalid-backup');
      error.code = 'INVALID_BACKUP';
      throw error;
    }

    // Validate account invariants before staging or swapping any filesystem
    // artifact. A malformed backup must have zero observable side effects.
    const nextState = restoredState(store);
    prepareAccountState(nextState);
    const auditEntries = restoredAuditEntries(bundle);
    const tlsStage = stageRestoreTls(bundle);
    let secretsStage = null;
    let journalStage = null;
    try {
      secretsStage = stageRestoreSecrets(bundle, store);
      journalStage = LOG_FILE + '.restore-stage-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
      writeDurableSnapshot(journalStage, Buffer.from(bundle.journal, 'utf8'));
    } catch (error) {
      removeTreeQuietly(secretsStage);
      removeTreeQuietly(tlsStage);
      if (journalStage) try { fs.unlinkSync(journalStage); } catch (_) {}
      throw error;
    }

    const previousState = getState();
    const previousHistoryRevision = getHistoryViewRevision();
    const auditChainSnapshot = snapshotRestoreFile(AUDIT_CHAIN_FILE);
    const auditHeadSnapshot = snapshotRestoreFile(AUDIT_HEAD_FILE);
    const journalSnapshot = snapshotRestoreFile(LOG_FILE);
    let coreTransaction = null;
    try {
      coreTransaction = beginCoreRestoreTransaction({
        journal:journalSnapshot,
        auditChain:auditChainSnapshot,
        auditHead:auditHeadSnapshot,
      }, journalStage);
    } catch (error) {
      removeTreeQuietly(secretsStage);
      removeTreeQuietly(tlsStage);
      try { removeFileStrict(journalStage); } catch (_) {}
      throw error;
    }
    let secretSwap = null;
    let tlsSwap = null;
    try {
      secretSwap = swapRestoreSecrets(secretsStage);
      tlsSwap = swapRestoreTls(tlsStage);
      nextState.meta.restoreCommitId = coreTransaction.id;
      if (secretSwap && secretSwap.txId) nextState.meta.secretsRestoreCommitId = secretSwap.txId;
      if (tlsSwap && tlsSwap.txId) nextState.meta.tlsRestoreCommitId = tlsSwap.txId;
      replaceState(nextState);
      sanitizeDlpQuarantineState();
      reconcileDlpQuarantineFiles();
      syncLiveActivityCache();
      const signedAudit = replaceChainForRestore(auditEntries);
      getState().audit = signedAudit.slice(-AUDIT_MAX).reverse();
      if (!Array.isArray(store.activityLog)) {
        getState().activityLog = buildLegacyActivityLog(getState().audit, getState().history);
        syncLiveActivityCache();
      }
      setHistoryViewRevision(previousHistoryRevision + 1);
      migrateLegacyFirstUseExpiryState();
      clearShareRuntimeState();
      replaceFileSync(journalStage, LOG_FILE);
      if (!persistNow()) throw new Error('restore-store-write-failed');
    } catch (error) {
      logger.error('[restore] commit failed, rolling back:', error && error.message);
      replaceState(previousState);
      syncLiveActivityCache();
      setHistoryViewRevision(previousHistoryRevision);
      clearShareRuntimeState();
      if (!persistNow()) {
        const fatal = new Error('restore-rollback-state-write-failed');
        fatal.code = 'RESTORE_ROLLBACK_FAILED';
        fatal.cause = error;
        logger.error('[restore] store rollback persistence failed; durable recovery required');
        throw fatal;
      }

      const rollbackFailures = [];
      const rollback = (name, callback) => {
        try { callback(); }
        catch (rollbackError) {
          rollbackFailures.push({ name, error:rollbackError });
          logger.error(`[restore] ${name} rollback failed:`, rollbackError.message);
        }
      };
      rollback('TLS', () => rollbackRestoreTls(tlsSwap));
      rollback('secret', () => rollbackRestoreSecrets(secretSwap));
      rollback('journal', () => restoreFileSnapshot(LOG_FILE, journalSnapshot));
      rollback('audit', () => {
        restoreFileSnapshot(AUDIT_CHAIN_FILE, auditChainSnapshot);
        restoreFileSnapshot(AUDIT_HEAD_FILE, auditHeadSnapshot);
        const verified = verifyAuditChain();
        if (!verified || verified.ok !== true) throw new Error('restored audit chain verification failed');
      });
      removeTreeQuietly(secretsStage);
      removeTreeQuietly(tlsStage);
      try { removeFileStrict(journalStage); } catch (_) {}
      if (!rollbackFailures.length) {
        try { markCoreRestoreRolledBack(coreTransaction); }
        catch (rollbackError) {
          rollbackFailures.push({ name:'core-marker', error:rollbackError });
          logger.error('[restore] core rollback marker update failed:', rollbackError.message);
        }
      }
      if (rollbackFailures.length || !cleanupCoreRestoreTransaction(coreTransaction)) {
        const fatal = new Error('restore-rollback-artifact-failed');
        fatal.code = 'RESTORE_ROLLBACK_FAILED';
        fatal.cause = error;
        fatal.failures = rollbackFailures;
        throw fatal;
      }
      throw error;
    }

    // The durable state write above is the transaction's commit point. Everything
    // below is best-effort finalization: a retained marker lets startup finish it,
    // and no non-critical cleanup is allowed to roll a committed restore backward.
    finalizeRestoreSecrets(secretSwap);
    finalizeRestoreTls(tlsSwap);
    if (tlsSwap) {
      try { markTlsRestartRequired(); }
      catch (error) { logger.error('[restore] TLS restart marker failed:', error.message); }
    }
    try { cleanupDlpQuarantineOrphans(); }
    catch (error) { logger.error('[restore] DLP orphan cleanup failed:', error.message); }
    cleanupCoreRestoreTransaction(coreTransaction);
    defer(() => Promise.resolve(migrateLegacyPhotoStorage())
      .catch((error) => logger.error('[images] restore migration failed:', error.message)));
    return true;
  }

  return {
    applyRestore,
    clearRuntimeAfterRestore,
    recoverInterruptedCoreRestore,
    recoverInterruptedSecretRestore,
    recoverInterruptedTlsRestore,
    restoreIsBusy,
  };
}

module.exports = { createRestoreService };
