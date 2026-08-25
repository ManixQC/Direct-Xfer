'use strict';

/**
 * Core/state composition boundary for Direct-Xfer.
 *
 * Owns the long-lived root-state cell plus construction of the infrastructure
 * services that must observe that cell lazily across transactional restores:
 * TLS/settings, account bootstrap, host-path policy, network/public projection,
 * activity/audit, persistent state-store and restore/startup coordination.
 *
 * Persistence is initialized explicitly after notification/PWA composition to
 * preserve the historical startup order. State restore/bootstrap is a second
 * explicit phase once share/photo/search/transfer services exist.
 */
const { createTlsManager } = require('./tls-manager');
const { createSettingsService } = require('./settings-service');
const { createAccountService } = require('./account-service');
const { createHostPathService } = require('./host-path-service');
const { createNetworkServices } = require('./network-services');
const { createSharePresentationService } = require('./share-presentation-service');
const { createActivityPresenceService } = require('./activity-presence-service');
const { createAuditService } = require('./audit-service');
const { createStateStore } = require('./state-store');
const { createRestoreService } = require('./restore-service');
const { createStateBootstrapService } = require('./state-bootstrap-service');

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`core-state application requires ${name}()`);
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`core-state application requires ${name}`);
  }
  return value;
}

function initialState(defaultSettings) {
  return {
    version:1,
    shares:[],
    trash:[],
    settings:{ ...defaultSettings },
    history:[],
    photoHistory:[],
    stats:{},
    meta:{},
    audit:[],
    ipNames:{},
    undoLog:[],
    activityLog:[],
  };
}

function createCoreStateApplication(options = {}) {
  const platform = requiredObject(options.platform, 'platform');
  const config = requiredObject(options.config, 'config');
  const runtimeBootstrap = requiredObject(options.runtimeBootstrap, 'runtimeBootstrap');
  const utils = requiredObject(options.utils, 'utils');
  const bridges = requiredObject(options.bridges, 'bridges');

  const { fs, path, crypto, os, net, tls, forge, nodemailer, webpush } = platform;
  if (!fs || !path || !crypto || !os || !net || !tls) throw new TypeError('core-state application requires platform primitives');
  requiredFunction(runtimeBootstrap.ensureBaseDirectories, 'runtimeBootstrap.ensureBaseDirectories');

  const getServerScheme = requiredFunction(bridges.getServerScheme, 'bridges.getServerScheme');
  const clientIp = requiredFunction(bridges.clientIp, 'bridges.clientIp');
  const scheduleSearchReindex = requiredFunction(bridges.scheduleSearchReindex, 'bridges.scheduleSearchReindex');
  const resetMailerCache = requiredFunction(bridges.resetMailerCache, 'bridges.resetMailerCache');

  let state;
  let stateStore = null;
  let persistence = null;
  let persistencePhase = 'idle';
  let stateLifecycle = null;
  let stateLifecyclePhase = 'idle';
  let stateLifecycleFailure = null;

  const getState = () => {
    if (!state) throw new Error('core-state root state is not initialized yet');
    return state;
  };
  const replaceState = (nextState) => {
    if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
      throw new TypeError('core-state application refuses an invalid root state');
    }
    state = nextState;
    return state;
  };
  const liveState = Object.freeze({
    get state() { return getState(); },
  });

  function requireStateStore() {
    if (!stateStore) throw new Error('core-state persistence is not initialized yet');
    return stateStore;
  }
  const persist = (...args) => requireStateStore().persist(...args);
  const persistNow = (...args) => requireStateStore().persistNow(...args);
  const scheduleFlush = (...args) => requireStateStore().scheduleFlush(...args);

  const tlsManager = createTlsManager({
    fs, path, crypto, os, net, tls, forge,
    bool:utils.bool,
    isPrivateIp:utils.isPrivateIp,
    BIND:config.BIND,
    DATA_DIR:config.DATA_DIR,
    PUBLIC_HOST:config.PUBLIC_HOST,
    PUBLIC_URL:config.PUBLIC_URL,
    LOCAL_IP:config.LOCAL_IP,
    ASVS_L3_MODE:config.ASVS_L3_MODE === true,
    getState,
  });
  const { TLS_CERT, TLS_KEY, TLS_DAY_MS } = tlsManager.config;

  const settingsService = createSettingsService({
    APP_NAME:config.APP_NAME,
    shutdownAfterDownload:config.SHUTDOWN_AFTER_DOWNLOAD,
    googleOAuthBrokerUrlEnv:config.GOOGLE_OAUTH_BROKER_URL_ENV,
    webhookUrl:config.WEBHOOK_URL,
    dataKey:config.DATA_KEY,
    smtpUrl:config.SMTP_URL,
    adminAllowedIps:config.ADMIN_ALLOWED_IPS,
    updateCheck:config.UPDATE_CHECK,
    publicIpDiscovery:config.PUBLIC_IP_DISCOVERY,
    maxUploadBytes:config.MAX_UPLOAD_BYTES,
    asvsL3Mode:config.ASVS_L3_MODE === true,
    asvsL3EgressAllowlist:config.ASVS_L3_EGRESS_ALLOWLIST,
    tlsCert:TLS_CERT,
    tlsKey:TLS_KEY,
    tlsDayMs:TLS_DAY_MS,
    nodemailer,
    webpush,
    tlsManager,
    getState,
    persist,
    persistNow,
    onSettingsChanged:() => {
      tlsManager.invalidateLocalCaStatusUiCache();
      resetMailerCache();
    },
    getServerScheme,
    emailSendable:requiredFunction(bridges.emailSendable, 'bridges.emailSendable'),
    pushSubs:requiredFunction(bridges.pushSubs, 'bridges.pushSubs'),
    tlsManagedByEnvironment:tlsManager.tlsManagedByEnvironment,
    configuredSelfSignedTls:tlsManager.configuredSelfSignedTls,
    configuredHttpsEnabled:tlsManager.configuredHttpsEnabled,
    localCaStatusForClient:tlsManager.localCaStatusForClient,
    normalizeLinkBase:requiredFunction(bridges.normalizeLinkBase, 'bridges.normalizeLinkBase'),
    cleanBrokerUrl:requiredFunction(bridges.cleanBrokerUrl, 'bridges.cleanBrokerUrl'),
    parseHotlinkHosts:requiredFunction(bridges.parseHotlinkHosts, 'bridges.parseHotlinkHosts'),
    normalizeShareColor:requiredFunction(bridges.normalizeShareColor, 'bridges.normalizeShareColor'),
    normalizeTags:requiredFunction(bridges.normalizeTags, 'bridges.normalizeTags'),
    normalizeDescriptionMd:requiredFunction(bridges.normalizeDescriptionMd, 'bridges.normalizeDescriptionMd'),
    normExtList:requiredFunction(bridges.normExtList, 'bridges.normExtList'),
    ipToInt:utils.ipToInt,
  });
  const {
    DEFAULT_SETTINGS, getSettings, setSettings, setSettingsDurable,
    updateCheckEnabled, publicIpDiscoveryEnabled,
  } = settingsService;

  runtimeBootstrap.ensureBaseDirectories();

  const accountService = createAccountService({
    fs,
    path,
    crypto,
    dataDir:config.DATA_DIR,
    getState,
    getSettings,
    persistNow,
    ASVS_L3_MODE:config.ASVS_L3_MODE === true,
  });

  const hostPathService = createHostPathService({ fs, path, hostRoot:config.HOST_ROOT });

  const networkServices = createNetworkServices({
    net,
    os,
    LOCAL_IP:config.LOCAL_IP,
    APP_VERSION:config.APP_VERSION,
    UPDATE_REPO:config.UPDATE_REPO,
    UPDATE_TAG:config.UPDATE_TAG,
    compareSemver:utils.compareSemver,
    updateCheckEnabled,
    publicIpDiscoveryEnabled,
    addAdminCenterNotification:requiredFunction(bridges.addAdminCenterNotification, 'bridges.addAdminCenterNotification'),
    getState,
    persist,
    maskToPrefix:utils.maskToPrefix,
    ipToInt:utils.ipToInt,
    intToIp:utils.intToIp,
    isPrivateIp:utils.isPrivateIp,
    getSettings,
    flagFromCode:utils.flagFromCode,
    noteCenterServiceState:requiredFunction(bridges.noteCenterServiceState, 'bridges.noteCenterServiceState'),
    ASVS_L3_MODE:config.ASVS_L3_MODE === true,
    ASVS_L3_EGRESS_ALLOWLIST:config.ASVS_L3_EGRESS_ALLOWLIST,
  });

  // Activity owns the IP privacy projection used by share presentation. Compose it
  // first so the core boundary can wire pubIp directly instead of round-tripping
  // through a server.js closure that only exists to bridge two core-owned services.
  const activityPresenceService = createActivityPresenceService({
    crypto,
    getState,
    getSettings,
    scheduleFlush,
    getShareById:requiredFunction(bridges.getShareById, 'bridges.getShareById'),
    getTrashItems:requiredFunction(bridges.getTrashItems, 'bridges.getTrashItems'),
    getPwaDevices:requiredFunction(bridges.getPwaDevices, 'bridges.getPwaDevices'),
    isSessionActive:requiredFunction(bridges.isSessionActive, 'bridges.isSessionActive'),
    getActiveTransfers:requiredFunction(bridges.getActiveTransfers, 'bridges.getActiveTransfers'),
  });

  const sharePresentationService = createSharePresentationService({
    config:{
      PUBLIC_URL:config.PUBLIC_URL,
      PUBLIC_HOST:config.PUBLIC_HOST,
      PORT:config.PORT,
      TRUST_PROXY:config.TRUST_PROXY,
    },
    getSettings,
    getState,
    getPublicIPCached:networkServices.getPublicIPCached,
    getLocalIPv4s:networkServices.getLocalIPv4s,
    getShareService:requiredFunction(bridges.getShareService, 'bridges.getShareService'),
    getPhotoService:requiredFunction(bridges.getPhotoService, 'bridges.getPhotoService'),
    getPwaDeviceService:requiredFunction(bridges.getPwaDeviceService, 'bridges.getPwaDeviceService'),
    pubIp:activityPresenceService.pubIp,
  });

  const auditService = createAuditService({
    fs,
    path,
    crypto,
    DATA_DIR:config.DATA_DIR,
    DATA_KEY:config.DATA_KEY,
    APP_NAME:config.APP_NAME,
    APP_VERSION:config.APP_VERSION,
    AUDIT_MAX:config.AUDIT_MAX,
    timingSafeEqualStr:utils.timingSafeEqualStr,
    getState,
    persistNow,
    scheduleFlush,
    emitLiveActivity:activityPresenceService.emitLiveActivity,
    pubIp:activityPresenceService.pubIp,
    scheduleSearchReindex,
    getAccountById:accountService.getAccountById,
    clientIp,
    isActivityIgnored:activityPresenceService.isActivityIgnored,
    env:options.env || process.env,
    ASVS_L3_MODE:config.ASVS_L3_MODE === true,
    ASVS_L3_EGRESS_ALLOWLIST:config.ASVS_L3_EGRESS_ALLOWLIST,
  });

  function initializePersistence() {
    if (persistencePhase === 'ready') return persistence;
    if (persistencePhase === 'initializing') {
      throw new Error('core-state persistence initialization is already in progress');
    }
    if (persistencePhase === 'failed') {
      throw new Error('core-state persistence initialization previously failed; restart is required');
    }
    if (stateStore || persistence) throw new Error('core-state persistence entered an inconsistent initialization state');

    persistencePhase = 'initializing';
    try {
      replaceState(initialState(DEFAULT_SETTINGS));
      const candidateStore = createStateStore({
        fs,
        crypto,
        dataDir:config.DATA_DIR,
        dataKey:config.DATA_KEY,
        getState,
      });
      const candidatePersistence = Object.freeze({
        stateStore:candidateStore,
        storeFile:candidateStore.storeFile,
        encryptStore:candidateStore.encryptStore,
        decryptStore:candidateStore.decryptStore,
        deserializeStore:candidateStore.deserializeStore,
        flushNow:candidateStore.flushNow,
      });
      stateStore = candidateStore;
      persistence = candidatePersistence;
      persistencePhase = 'ready';
      return persistence;
    } catch (error) {
      stateStore = null;
      persistence = null;
      state = undefined;
      persistencePhase = 'failed';
      throw error;
    }
  }

  function initializeStateLifecycle(deps = {}) {
    if (stateLifecyclePhase === 'ready') return stateLifecycle;
    if (stateLifecyclePhase === 'initializing') {
      throw new Error('core-state lifecycle initialization is already in progress');
    }
    if (stateLifecyclePhase === 'failed') {
      const error = new Error('core-state lifecycle initialization previously failed; restart is required');
      if (stateLifecycleFailure) error.cause = stateLifecycleFailure;
      throw error;
    }
    if (!stateStore || !state) throw new Error('core-state persistence must be initialized before state lifecycle');

    // Preflight every late callback before constructing either lifecycle service.
    // This keeps a typo/missing adapter side-effect free and retryable, while any
    // failure after service construction becomes one-shot because bootstrap can
    // already have replaced state, migrated files or initialized audit/account data.
    const replacementCoordinator = requiredObject(
      deps.stateReplacementCoordinator,
      'stateLifecycle.stateReplacementCoordinator'
    );
    const lifecycleDeps = Object.freeze({
      stateReplacementCoordinator:Object.freeze({
        isBusyForStateReplacement:requiredFunction(
          replacementCoordinator.isBusyForStateReplacement,
          'stateLifecycle.stateReplacementCoordinator.isBusyForStateReplacement'
        ).bind(replacementCoordinator),
        clearRuntimeAfterRestore:requiredFunction(
          replacementCoordinator.clearRuntimeAfterRestore,
          'stateLifecycle.stateReplacementCoordinator.clearRuntimeAfterRestore'
        ).bind(replacementCoordinator),
      }),
      normalizePhotoHistory:requiredFunction(deps.normalizePhotoHistory, 'stateLifecycle.normalizePhotoHistory'),
      sanitizeUndoLog:requiredFunction(deps.sanitizeUndoLog, 'stateLifecycle.sanitizeUndoLog'),
      sanitizeDlpQuarantineState:requiredFunction(deps.sanitizeDlpQuarantineState, 'stateLifecycle.sanitizeDlpQuarantineState'),
      reconcileDlpQuarantineFiles:requiredFunction(deps.reconcileDlpQuarantineFiles, 'stateLifecycle.reconcileDlpQuarantineFiles'),
      migrateLegacyFirstUseExpiryState:requiredFunction(deps.migrateLegacyFirstUseExpiryState, 'stateLifecycle.migrateLegacyFirstUseExpiryState'),
      clearShareRuntimeState:requiredFunction(deps.clearShareRuntimeState, 'stateLifecycle.clearShareRuntimeState'),
      cleanupDlpQuarantineOrphans:requiredFunction(deps.cleanupDlpQuarantineOrphans, 'stateLifecycle.cleanupDlpQuarantineOrphans'),
      migrateLegacyPhotoStorage:requiredFunction(deps.migrateLegacyPhotoStorage, 'stateLifecycle.migrateLegacyPhotoStorage'),
      reindex:requiredFunction(deps.reindex, 'stateLifecycle.reindex'),
      trimLogIfNeeded:requiredFunction(deps.trimLogIfNeeded, 'stateLifecycle.trimLogIfNeeded'),
      pruneHistory:requiredFunction(deps.pruneHistory, 'stateLifecycle.pruneHistory'),
      exit:requiredFunction(deps.exit, 'stateLifecycle.exit'),
      defer:deps.defer == null ? setImmediate : requiredFunction(deps.defer, 'stateLifecycle.defer'),
      logger:deps.logger || console,
    });

    stateLifecyclePhase = 'initializing';
    try {
      const restoreService = createRestoreService({
      fs, path, crypto, forge,
      DATA_DIR:config.DATA_DIR,
      SECRETS_DIR:config.SECRETS_DIR,
      LOG_FILE:deps.LOG_FILE,
      AUDIT_CHAIN_FILE:auditService.paths.chainFile,
      AUDIT_HEAD_FILE:auditService.paths.headFile,
      DEFAULT_SETTINGS,
      HISTORY_MAX:config.HISTORY_MAX,
      AUDIT_MAX:config.AUDIT_MAX,
      getState,
      replaceState,
      getHistoryViewRevision:activityPresenceService.getHistoryViewRevision,
      setHistoryViewRevision:activityPresenceService.setHistoryViewRevision,
      parseAuditChainText:auditService.parseAuditChainText,
      validateAuditRestoreEntries:auditService.validateAuditRestoreEntries,
      ensureAuditChainKey:auditService.ensureAuditChainKey,
      auditKeyId:auditService.auditKeyId,
      timingSafeEqualStr:utils.timingSafeEqualStr,
      verifyAuditSnapshot:auditService.verifyAuditSnapshot,
      verifyAuditChain:auditService.verifyAuditChain,
      parseAuditChainFile:auditService.parseAuditChainFile,
      replaceChainForRestore:auditService.replaceChainForRestore,
      stateReplacementCoordinator:lifecycleDeps.stateReplacementCoordinator,
      tlsDirPath:tlsManager.tlsDirPath,
      validateLocalCaCertificate:tlsManager.validateLocalCaCertificate,
      validateLeafCertificate:tlsManager.validateLeafCertificate,
      markTlsRestartRequired:() => { tlsManager.tlsCertificateRestartRequired = true; },
      normalizePhotoHistory:lifecycleDeps.normalizePhotoHistory,
      sanitizeUndoLog:lifecycleDeps.sanitizeUndoLog,
      sanitizeActivityLog:activityPresenceService.sanitizeActivityLog,
      sanitizeDlpQuarantineState:lifecycleDeps.sanitizeDlpQuarantineState,
      reconcileDlpQuarantineFiles:lifecycleDeps.reconcileDlpQuarantineFiles,
      syncLiveActivityCache:activityPresenceService.syncLiveActivityCache,
      buildLegacyActivityLog:activityPresenceService.buildLegacyActivityLog,
      migrateLegacyFirstUseExpiryState:lifecycleDeps.migrateLegacyFirstUseExpiryState,
      prepareAccountState:accountService.prepareRestoredState,
      clearShareRuntimeState:lifecycleDeps.clearShareRuntimeState,
      persistNow,
      cleanupDlpQuarantineOrphans:lifecycleDeps.cleanupDlpQuarantineOrphans,
      migrateLegacyPhotoStorage:lifecycleDeps.migrateLegacyPhotoStorage,
    });

    const stateBootstrapService = createStateBootstrapService({
      fs,
      stateStore,
      getState,
      replaceState,
      DEFAULT_SETTINGS,
      HISTORY_MAX:config.HISTORY_MAX,
      AUDIT_MAX:config.AUDIT_MAX,
      normalizePhotoHistory:lifecycleDeps.normalizePhotoHistory,
      sanitizeUndoLog:lifecycleDeps.sanitizeUndoLog,
      sanitizeActivityLog:activityPresenceService.sanitizeActivityLog,
      buildLegacyActivityLog:activityPresenceService.buildLegacyActivityLog,
      syncLiveActivityCache:activityPresenceService.syncLiveActivityCache,
      migrateLegacyFirstUseExpiryState:lifecycleDeps.migrateLegacyFirstUseExpiryState,
      sanitizeDlpQuarantineState:lifecycleDeps.sanitizeDlpQuarantineState,
      reconcileDlpQuarantineFiles:lifecycleDeps.reconcileDlpQuarantineFiles,
      cleanupDlpQuarantineOrphans:lifecycleDeps.cleanupDlpQuarantineOrphans,
      reindex:lifecycleDeps.reindex,
      persistNow,
      recoverInterruptedCoreRestore:restoreService.recoverInterruptedCoreRestore,
      recoverInterruptedSecretRestore:restoreService.recoverInterruptedSecretRestore,
      recoverInterruptedTlsRestore:restoreService.recoverInterruptedTlsRestore,
      initAuditChain:auditService.initAuditChain,
      ensureAuditProofKeys:auditService.ensureAuditProofKeys,
      initAccounts:accountService.initialize,
      trimLogIfNeeded:lifecycleDeps.trimLogIfNeeded,
      pruneHistory:lifecycleDeps.pruneHistory,
      migrateLegacyPhotoStorage:lifecycleDeps.migrateLegacyPhotoStorage,
      env:options.env || process.env,
      exit:lifecycleDeps.exit,
      defer:lifecycleDeps.defer,
      logger:lifecycleDeps.logger,
    });

      // Keep startup behavior transactional: publish the lifecycle pair only after
      // both services are fully composed and startup initialization has completed.
      const candidate = Object.freeze({
        stateReplacementCoordinator:lifecycleDeps.stateReplacementCoordinator,
        restoreService,
        stateBootstrapService,
      });
      const initialization = stateBootstrapService.initialize();
      if (!initialization || initialization.initialized !== true) {
        const error = new Error('core-state bootstrap did not complete successfully');
        error.code = 'CORE_STATE_BOOTSTRAP_INCOMPLETE';
        throw error;
      }
      stateLifecycle = candidate;
      stateLifecyclePhase = 'ready';
      return stateLifecycle;
    } catch (error) {
      stateLifecycle = null;
      stateLifecycleFailure = error;
      stateLifecyclePhase = 'failed';
      throw error;
    }
  }

  return Object.freeze({
    getState,
    replaceState,
    liveState,
    persist,
    persistNow,
    scheduleFlush,
    initializePersistence,
    initializeStateLifecycle,
    tlsManager,
    settingsService,
    accountService,
    hostPathService,
    networkServices,
    sharePresentationService,
    activityPresenceService,
    auditService,
  });
}

module.exports = { createCoreStateApplication, initialState };
