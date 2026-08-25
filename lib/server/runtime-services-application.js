'use strict';

/**
 * Runtime services composition boundary for Direct-Xfer.
 *
 * Owns the late upload/reception, backup and maintenance service graph. These
 * services intentionally compose after public HTTP/security because maintenance
 * depends on their runtime maps, while upload keeps a lazy bridge back to the
 * maintenance-owned file-expiry index. HTTP route declarations remain outside
 * this boundary.
 */
const { createUploadReceptionService } = require('./upload-reception-service');
const { createBackupService } = require('./backup-service');
const { createMaintenanceService } = require('./maintenance-service');

const RUNTIME_CONTEXT_DOMAINS = Object.freeze(['upload', 'backup', 'maintenance']);

function requiredObject(value, label) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Array.isArray(value)) {
    throw new TypeError(`runtime-services application requires ${label}`);
  }
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`runtime-services application requires ${label}`);
  return value;
}

function requiredMethods(source, label, names) {
  requiredObject(source, label);
  for (const name of names) requiredFunction(source[name], `${label}.${name}()`);
  return source;
}

function requiredProperty(source, name, label) {
  requiredObject(source, label);
  if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] === undefined) {
    throw new TypeError(`runtime-services application requires ${label}.${name}`);
  }
  return source[name];
}

function method(source, name, label) {
  requiredObject(source, label);
  return requiredFunction(source[name], `${label}.${name}()`).bind(source);
}

function createRuntimeServicesApplication(options = {}) {
  const applicationContext = requiredObject(options.applicationContext, 'application context');
  for (const name of ['current', 'registerMany']) requiredFunction(applicationContext[name], `application context.${name}()`);

  const platform = requiredObject(options.platform, 'platform');
  const fs = requiredObject(platform.fs, 'platform.fs');
  const path = requiredObject(platform.path, 'platform.path');
  const crypto = requiredObject(platform.crypto, 'platform.crypto');
  const forge = platform.forge || null;
  const fd = requiredObject(options.fd, 'fd adapters');
  const openFd = method(fd, 'openFd', 'fd');
  const closeFd = method(fd, 'closeFd', 'fd');
  const readFd = method(fd, 'readFd', 'fd');

  const config = requiredObject(options.config, 'config');
  for (const name of [
    'APP_NAME', 'APP_VERSION', 'DATA_KEY', 'DATA_DIR', 'SECRETS_DIR', 'FULL_IMAGES_DIR',
    'INBOX_DIR', 'MAX_CONCURRENT_UPLOADS', 'QUARANTINE_DIR', 'UPLOAD_IDLE_TIMEOUT_MS',
    'CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_SOCKET', 'CLAMAV_TLS', 'CLAMAV_TLS_SERVERNAME', 'CLAMAV_TLS_CA_FILE', 'FAIL_WINDOW_MS',
  ]) requiredProperty(config, name, 'config');
  const clamavEnabled = method(config, 'clamavEnabled', 'config');
  const ASVS_L3_MODE = config.ASVS_L3_MODE === true;
  const ASVS_L3_MAX_FILES_PER_SENDER = Number.isSafeInteger(Number(config.ASVS_L3_MAX_FILES_PER_SENDER)) ? Number(config.ASVS_L3_MAX_FILES_PER_SENDER) : 1000;
  const ASVS_L3_MAX_BYTES_PER_SENDER = Number.isFinite(Number(config.ASVS_L3_MAX_BYTES_PER_SENDER)) ? Number(config.ASVS_L3_MAX_BYTES_PER_SENDER) : 20 * 1024 * 1024 * 1024;

  const constants = requiredObject(options.constants, 'constants');
  const DAY_MS = requiredProperty(constants, 'DAY_MS', 'constants');
  const LOG_FILE = requiredProperty(constants, 'LOG_FILE', 'constants');
  if (!Number.isFinite(Number(DAY_MS)) || Number(DAY_MS) <= 0) {
    throw new TypeError('runtime-services application requires a positive constants.DAY_MS');
  }
  if (typeof LOG_FILE !== 'string' || !LOG_FILE) {
    throw new TypeError('runtime-services application requires constants.LOG_FILE');
  }

  const state = requiredMethods(options.state, 'state adapters', [
    'getState', 'getSettings', 'persist', 'persistNow', 'scheduleFlush', 'encryptStore', 'decryptStore',
  ]);
  const request = requiredMethods(options.request, 'request adapters', ['clientIp']);
  const utils = requiredMethods(options.utils, 'utils', ['formatBytes', 'isLoopback']);
  const pwa = requiredMethods(options.pwa, 'PWA adapters', ['emitInboxEvent']);

  const services = requiredObject(options.services, 'services');
  const securityAuthApplication = requiredObject(services.securityAuthApplication, 'services.securityAuthApplication');
  const shareMediaTransferApplication = requiredObject(services.shareMediaTransferApplication, 'services.shareMediaTransferApplication');
  const publicHttpApplication = requiredObject(services.publicHttpApplication, 'services.publicHttpApplication');
  const notificationApplication = requiredObject(services.notificationApplication, 'services.notificationApplication');
  const tlsManager = requiredObject(services.tlsManager, 'services.tlsManager');
  const auditService = requiredObject(services.auditService, 'services.auditService');
  const activityPresenceService = requiredObject(services.activityPresenceService, 'services.activityPresenceService');
  const networkServices = requiredObject(services.networkServices, 'services.networkServices');
  const hostPathService = requiredObject(services.hostPathService, 'services.hostPathService');

  const sessionService = requiredMethods(securityAuthApplication.sessionService, 'session service', ['cleanup']);
  const authService = requiredMethods(securityAuthApplication.authService, 'auth service', ['cleanup']);
  const shareService = requiredMethods(shareMediaTransferApplication.shareService, 'share service', [
    'restorePlainObject', 'runExpiredLinkLifecycle', 'trashItems', 'purgeTrashRecordById', 'getById',
  ]);
  const photoService = requiredMethods(shareMediaTransferApplication.photoService, 'photo service', ['hashFileSha256']);
  const searchService = requiredMethods(shareMediaTransferApplication.searchService, 'search service', ['scheduleReindex']);
  const transferService = requiredMethods(shareMediaTransferApplication.transferService, 'transfer service', ['endTransfer']);
  const notificationService = requiredMethods(notificationApplication.notificationService, 'notification service', [
    'dispatch', 'checkExpiringShares', 'maybeSendDigest',
  ]);
  const notificationCenterService = requiredMethods(notificationApplication.notificationCenterService, 'notification-center service', [
    'addShareCenterNotification', 'evaluateCustomNotificationRulesForShare', 'maybeCenterReceptionQuota',
    'notificationAccountIdForShare', 'notificationAdminAccountIds', 'pruneCenterTrackers',
    'checkCenterLinkStates', 'noteCenterCleanup', 'addCenterNotification',
  ]);
  requiredMethods(publicHttpApplication, 'public-http application', []);
  const unlockFails = publicHttpApplication.unlockFails;
  if (!unlockFails || typeof unlockFails[Symbol.iterator] !== 'function' || typeof unlockFails.delete !== 'function') {
    throw new TypeError('runtime-services application requires public-http application.unlockFails Map-like value');
  }

  requiredMethods(tlsManager, 'TLS manager', [
    'readLocalCaCertificateOnly', 'localCaFeatureRelevant', 'readManagedTlsFile',
    'validateLocalCaCertificate', 'validateLeafCertificate',
  ]);
  const localCaPaths = method(tlsManager, 'localCaPaths', 'TLS manager');
  requiredMethods(auditService, 'audit service', ['auditKeyId', 'ensureAuditChainKey', 'logAudit']);
  const auditPaths = requiredObject(auditService.paths, 'audit service.paths');
  const AUDIT_CHAIN_FILE = requiredProperty(auditPaths, 'chainFile', 'audit service.paths');
  const AUDIT_HEAD_FILE = requiredProperty(auditPaths, 'headFile', 'audit service.paths');
  requiredMethods(activityPresenceService, 'activity service', ['emitLiveActivity', 'maskIp', 'pubIp']);
  const geoCache = networkServices.geoCache;
  if (!geoCache || typeof geoCache[Symbol.iterator] !== 'function' || typeof geoCache.delete !== 'function') {
    throw new TypeError('runtime-services application requires network services.geoCache Map-like value');
  }
  const GEO_TTL = requiredProperty(networkServices, 'GEO_TTL', 'network services');
  requiredMethods(hostPathService, 'host-path service', ['assertRealWithin', 'resolveWithin']);

  // Validate all constructor inputs before creating the first stateful service.
  // This keeps wiring errors retryable and avoids publishing half a runtime graph.
  const getState = method(state, 'getState', 'state adapters');
  const getSettings = method(state, 'getSettings', 'state adapters');
  const persist = method(state, 'persist', 'state adapters');
  const persistNow = method(state, 'persistNow', 'state adapters');
  const scheduleFlush = method(state, 'scheduleFlush', 'state adapters');
  const encryptStore = method(state, 'encryptStore', 'state adapters');
  const decryptStore = method(state, 'decryptStore', 'state adapters');
  const clientIp = method(request, 'clientIp', 'request adapters');
  const formatBytes = method(utils, 'formatBytes', 'utils');
  const isLoopback = method(utils, 'isLoopback', 'utils');
  const emitInboxEvent = method(pwa, 'emitInboxEvent', 'PWA adapters');
  const dispatch = method(notificationService, 'dispatch', 'notification service');
  const scheduleSearchReindex = method(searchService, 'scheduleReindex', 'search service');

  let maintenanceService = null;
  function requireMaintenanceService() {
    if (!maintenanceService) throw new Error('runtime-services maintenance service is not composed yet');
    return maintenanceService;
  }

  const uploadReceptionService = createUploadReceptionService({
    ASVS_L3_MODE,
    ASVS_L3_MAX_FILES_PER_SENDER,
    ASVS_L3_MAX_BYTES_PER_SENDER,
    APP_NAME:config.APP_NAME,
    CLAMAV_HOST:config.CLAMAV_HOST,
    CLAMAV_PORT:config.CLAMAV_PORT,
    CLAMAV_SOCKET:config.CLAMAV_SOCKET,
    CLAMAV_TLS:config.CLAMAV_TLS,
    CLAMAV_TLS_SERVERNAME:config.CLAMAV_TLS_SERVERNAME,
    CLAMAV_TLS_CA_FILE:config.CLAMAV_TLS_CA_FILE,
    DATA_DIR:config.DATA_DIR,
    FULL_IMAGES_DIR:config.FULL_IMAGES_DIR,
    INBOX_DIR:config.INBOX_DIR,
    MAX_CONCURRENT_UPLOADS:config.MAX_CONCURRENT_UPLOADS,
    RECEPTION_THREAD_MAX:200,
    QUARANTINE_DIR:config.QUARANTINE_DIR,
    UPLOAD_IDLE_TIMEOUT_MS:config.UPLOAD_IDLE_TIMEOUT_MS,
    addShareCenterNotification:method(notificationCenterService, 'addShareCenterNotification', 'notification-center service'),
    assertRealWithin:method(hostPathService, 'assertRealWithin', 'host-path service'),
    clamavEnabled,
    clientIp,
    closeFd,
    dispatch,
    emitInboxEvent,
    emitLiveActivity:method(activityPresenceService, 'emitLiveActivity', 'activity service'),
    endTransfer:method(transferService, 'endTransfer', 'transfer service'),
    evaluateCustomNotificationRulesForShare:method(notificationCenterService, 'evaluateCustomNotificationRulesForShare', 'notification-center service'),
    getSettings,
    hashFileSha256:method(photoService, 'hashFileSha256', 'photo service'),
    logAudit:method(auditService, 'logAudit', 'audit service'),
    maskIp:method(activityPresenceService, 'maskIp', 'activity service'),
    maybeCenterReceptionQuota:method(notificationCenterService, 'maybeCenterReceptionQuota', 'notification-center service'),
    notificationAccountIdForShare:method(notificationCenterService, 'notificationAccountIdForShare', 'notification-center service'),
    notificationAdminAccountIds:method(notificationCenterService, 'notificationAdminAccountIds', 'notification-center service'),
    openFd,
    persistNow,
    pubIp:method(activityPresenceService, 'pubIp', 'activity service'),
    readFd,
    resolveWithin:method(hostPathService, 'resolveWithin', 'host-path service'),
    restorePlainObject:method(shareService, 'restorePlainObject', 'share service'),
    scheduleFlush,
    scheduleSearchReindex,
    live:{
      get state() { return getState(); },
      get fileExpiryMap() { return method(requireMaintenanceService(), 'fileExpiryMap', 'maintenance service'); },
      get recordFileExpiry() { return method(requireMaintenanceService(), 'recordFileExpiry', 'maintenance service'); },
    },
  });
  requiredMethods(uploadReceptionService, 'upload-reception service', [
    'folderMetrics', 'acceptsUpload', 'normExtList', 'pendingUsageForShare',
    'releaseReceptionManagedBytes', 'safeManagedInboxFilePath', 'receptionMetadataPath',
    'scanFile', 'quarantineFile', 'maybeCleanupOrphanPendingFiles', 'hasActiveUploads',
    'clearRuntimeAfterRestore', 'receptionThreadEnabled',
  ]);

  const backupService = createBackupService({
    fs, path, crypto, forge,
    DATA_KEY:config.DATA_KEY,
    SECRETS_DIR:config.SECRETS_DIR,
    LOG_FILE,
    AUDIT_CHAIN_FILE,
    AUDIT_HEAD_FILE,
    APP_NAME:config.APP_NAME,
    APP_VERSION:config.APP_VERSION,
    getState,
    localCaPaths,
    readLocalCaCertificateOnly:method(tlsManager, 'readLocalCaCertificateOnly', 'TLS manager'),
    localCaFeatureRelevant:method(tlsManager, 'localCaFeatureRelevant', 'TLS manager'),
    readManagedTlsFile:method(tlsManager, 'readManagedTlsFile', 'TLS manager'),
    validateLocalCaCertificate:method(tlsManager, 'validateLocalCaCertificate', 'TLS manager'),
    validateLeafCertificate:method(tlsManager, 'validateLeafCertificate', 'TLS manager'),
    auditKeyId:method(auditService, 'auditKeyId', 'audit service'),
    ensureAuditChainKey:method(auditService, 'ensureAuditChainKey', 'audit service'),
    encryptStore,
    decryptStore,
    getSettings,
    scheduleFlush,
    dispatch,
    formatBytes,
    logAudit:method(auditService, 'logAudit', 'audit service'),
    DAY_MS:Number(DAY_MS),
    ASVS_L3_MODE,
    ASVS_L3_EGRESS_ALLOWLIST:config.ASVS_L3_EGRESS_ALLOWLIST,
  });
  requiredMethods(backupService, 'backup service', ['maybeRunScheduledBackup', 'isBackupInFlight']);

  maintenanceService = createMaintenanceService({
    fs, path, crypto,
    APP_NAME:config.APP_NAME,
    DAY_MS:Number(DAY_MS),
    ASVS_L3_MODE,
    ASVS_L3_EGRESS_ALLOWLIST:config.ASVS_L3_EGRESS_ALLOWLIST,
    INBOX_DIR:config.INBOX_DIR,
    LOG_FILE,
    SECRETS_DIR:config.SECRETS_DIR,
    FAIL_WINDOW_MS:config.FAIL_WINDOW_MS,
    GEO_TTL,
    getState,
    getSettings,
    persist,
    persistNow,
    scheduleFlush,
    sessionCleanup:(now) => sessionService.cleanup(now),
    authCleanup:(now) => authService.cleanup(now),
    unlockFails,
    geoCache,
    pruneCenterTrackers:method(notificationCenterService, 'pruneCenterTrackers', 'notification-center service'),
    runExpiredLinkLifecycle:method(shareService, 'runExpiredLinkLifecycle', 'share service'),
    maybeCleanupOrphanPendingFiles:method(uploadReceptionService, 'maybeCleanupOrphanPendingFiles', 'upload-reception service'),
    trashItems:method(shareService, 'trashItems', 'share service'),
    purgeTrashRecordById:method(shareService, 'purgeTrashRecordById', 'share service'),
    checkCenterLinkStates:method(notificationCenterService, 'checkCenterLinkStates', 'notification-center service'),
    checkExpiringShares:method(notificationService, 'checkExpiringShares', 'notification service'),
    maybeSendDigest:method(notificationService, 'maybeSendDigest', 'notification service'),
    maybeRunScheduledBackup:method(backupService, 'maybeRunScheduledBackup', 'backup service'),
    releaseReceptionManagedBytes:method(uploadReceptionService, 'releaseReceptionManagedBytes', 'upload-reception service'),
    addShareCenterNotification:method(notificationCenterService, 'addShareCenterNotification', 'notification-center service'),
    noteCenterCleanup:method(notificationCenterService, 'noteCenterCleanup', 'notification-center service'),
    scheduleSearchReindex,
    notificationAccountIdForShare:method(notificationCenterService, 'notificationAccountIdForShare', 'notification-center service'),
    receptionMetadataPath:method(uploadReceptionService, 'receptionMetadataPath', 'upload-reception service'),
    safeManagedInboxFilePath:method(uploadReceptionService, 'safeManagedInboxFilePath', 'upload-reception service'),
    addCenterNotification:method(notificationCenterService, 'addCenterNotification', 'notification-center service'),
    clientIp,
    isLoopback,
    getById:method(shareService, 'getById', 'share service'),
    acceptsUpload:method(uploadReceptionService, 'acceptsUpload', 'upload-reception service'),
    logAudit:method(auditService, 'logAudit', 'audit service'),
    dispatch,
  });
  requiredMethods(maintenanceService, 'maintenance service', [
    'fileExpiryMap', 'recordFileExpiry', 'isStateReplacementBusy', 'clearRuntimeAfterRestore', 'start', 'stop',
  ]);

  function applicationDomainEntries() {
    return Object.freeze([
      ['upload', uploadReceptionService],
      ['backup', backupService],
      ['maintenance', maintenanceService],
    ].map((entry) => Object.freeze(entry)));
  }

  let registrationPhase = 'idle';
  let registrationFailure = null;
  function registerApplicationDomains() {
    if (registrationPhase === 'ready') return;
    if (registrationPhase === 'registering') throw new Error('runtime-services domain registration is already in progress');
    if (registrationPhase === 'failed') {
      const error = new Error('runtime-services domain registration previously failed; restart is required');
      if (registrationFailure) error.cause = registrationFailure;
      throw error;
    }
    const applicationDomains = applicationDomainEntries();
    let published = 0;
    for (const [name, service] of applicationDomains) {
      const current = applicationContext.current(name);
      if (current === service) { published += 1; continue; }
      if (current != null) throw new Error(`runtime-services application domain is already registered: ${name}`);
    }
    if (published === applicationDomains.length) {
      registrationFailure = null;
      registrationPhase = 'ready';
      return;
    }
    if (published !== 0) {
      for (const [name] of applicationDomains) {
        if (applicationContext.current(name) != null) throw new Error(`runtime-services application domain is already registered: ${name}`);
      }
      throw new Error('runtime-services application domains are only partially published');
    }
    registrationPhase = 'registering';
    try {
      applicationContext.registerMany(applicationDomains);
      registrationFailure = null;
      registrationPhase = 'ready';
    } catch (error) {
      registrationFailure = error;
      registrationPhase = 'failed';
      throw error;
    }
  }

  return Object.freeze({
    uploadReceptionService,
    backupService,
    maintenanceService,
    folderMetrics:method(uploadReceptionService, 'folderMetrics', 'upload-reception service'),
    normExtList:method(uploadReceptionService, 'normExtList', 'upload-reception service'),
    receptionThreadEnabled:method(uploadReceptionService, 'receptionThreadEnabled', 'upload-reception service'),
    hasActiveUploads:method(uploadReceptionService, 'hasActiveUploads', 'upload-reception service'),
    isBackupInFlight:method(backupService, 'isBackupInFlight', 'backup service'),
    isMaintenanceStateReplacementBusy:method(maintenanceService, 'isStateReplacementBusy', 'maintenance service'),
    clearUploadRuntimeAfterRestore:method(uploadReceptionService, 'clearRuntimeAfterRestore', 'upload-reception service'),
    clearMaintenanceRuntimeState:method(maintenanceService, 'clearRuntimeAfterRestore', 'maintenance service'),
    applicationDomainEntries,
    registerApplicationDomains,
  });
}

module.exports = { RUNTIME_CONTEXT_DOMAINS, createRuntimeServicesApplication };
