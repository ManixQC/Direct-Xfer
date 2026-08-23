'use strict';

/**
 * Persistent root-state lifecycle composition boundary for Direct-Xfer.
 *
 * Owns the cross-domain state-replacement coordinator and the second-phase
 * restore/startup lifecycle initialization. The server composition root only
 * supplies the applications that own the relevant runtime state; this module
 * derives the individual busy/reset/migration callbacks from those boundaries.
 *
 * Several providers are intentionally late because restore/bootstrap services
 * are initialized before security, public HTTP, runtime, admin and PWA
 * applications are fully composed. Provider functions are validated eagerly,
 * while their returned applications are resolved only when a restore actually
 * asks for a busy check or runtime reset.
 */
const { createStateReplacementCoordinator } = require('./state-replacement-coordinator');

function requiredObject(value, label) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Array.isArray(value)) {
    throw new TypeError(`state-lifecycle application requires ${label}`);
  }
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`state-lifecycle application requires ${label}()`);
  return value;
}

function ownFunction(source, name, label) {
  requiredObject(source, label);
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`state-lifecycle application requires ${label}.${name}() as an own function`);
  }
  return descriptor.value;
}

function boundMethod(source, name, label) {
  return ownFunction(source, name, label).bind(source);
}

function dynamicMethod(source, name, label) {
  requiredObject(source, label);
  return (...args) => ownFunction(source, name, label).apply(source, args);
}

function requiredProperty(source, name, label) {
  requiredObject(source, label);
  if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] === undefined) {
    throw new TypeError(`state-lifecycle application requires ${label}.${name}`);
  }
  return source[name];
}

function requiredMethods(source, label, names) {
  requiredObject(source, label);
  for (const name of names) requiredFunction(source[name], `${label}.${name}`);
  return source;
}

function lateProvider(source, name) {
  return boundMethod(source, name, 'late');
}

function resolveLate(provider, label) {
  return requiredObject(provider(), `late provider ${label}`);
}

function callLate(provider, label, methodName, args = []) {
  const application = resolveLate(provider, label);
  return ownFunction(application, methodName, `late provider ${label}`).apply(application, args);
}

function requiredLogger(value) {
  const logger = requiredObject(value, 'process.logger');
  requiredFunction(logger.error, 'process.logger.error');
  requiredFunction(logger.warn, 'process.logger.warn');
  return logger;
}

function createStateLifecycleApplication(options = {}) {
  const coreStateApplication = requiredMethods(options.coreStateApplication, 'coreStateApplication', [
    'initializeStateLifecycle',
  ]);

  const config = requiredObject(options.config, 'config');
  const LOG_FILE = requiredProperty(config, 'LOG_FILE', 'config');
  if (typeof LOG_FILE !== 'string' || !LOG_FILE) {
    throw new TypeError('state-lifecycle application requires config.LOG_FILE');
  }

  const services = requiredObject(options.services, 'services');
  const shareMediaTransferApplication = requiredMethods(
    services.shareMediaTransferApplication,
    'services.shareMediaTransferApplication',
    ['isBusyForStateReplacement', 'clearMediaRuntimeState']
  );
  const notificationApplication = requiredMethods(
    services.notificationApplication,
    'services.notificationApplication',
    [
      'isBusyForStateReplacement',
      'clearNotificationRuntimeState',
      'clearNotificationCenterRuntimeState',
      'clearPwaNotificationRuntimeState',
    ]
  );
  const activityPresenceService = requiredMethods(
    services.activityPresenceService,
    'services.activityPresenceService',
    ['closeActivityPresenceStreams']
  );
  const accountService = requiredMethods(
    services.accountService,
    'services.accountService',
    ['clearInitialPassword']
  );

  const shareService = requiredMethods(
    shareMediaTransferApplication.shareService,
    'share-media application.shareService',
    ['clearRuntimeState']
  );
  const photoService = requiredMethods(
    shareMediaTransferApplication.photoService,
    'share-media application.photoService',
    ['normalizePhotoHistory', 'migrateLegacyPhotoStorage']
  );
  const dlpService = requiredMethods(
    shareMediaTransferApplication.dlpService,
    'share-media application.dlpService',
    ['sanitizeDlpQuarantineState', 'reconcileDlpQuarantineFiles', 'cleanupDlpQuarantineOrphans']
  );
  const transferService = requiredMethods(
    shareMediaTransferApplication.transferService,
    'share-media application.transferService',
    ['clearRuntimeState', 'trimLogIfNeeded', 'pruneHistory']
  );
  const shareFacade = requiredMethods(
    shareMediaTransferApplication.shareFacade,
    'share-media application.shareFacade',
    ['sanitizeUndoLog', 'migrateLegacyFirstUseExpiryState', 'reindex']
  );
  const activeTransfers = requiredProperty(transferService, 'activeTransfers', 'share-media application.transferService');
  if (!activeTransfers || typeof activeTransfers.size !== 'number') {
    throw new TypeError('state-lifecycle application requires transferService.activeTransfers Map-like value');
  }
  const searchService = requiredMethods(
    shareMediaTransferApplication.searchService,
    'share-media application.searchService',
    ['resetAfterRestore']
  );

  const late = requiredObject(options.late, 'late providers');
  const securityProvider = lateProvider(late, 'securityAuthApplication');
  const publicHttpProvider = lateProvider(late, 'publicHttpApplication');
  const runtimeProvider = lateProvider(late, 'runtimeServicesApplication');
  const adminProvider = lateProvider(late, 'adminApplication');
  const httpPwaProvider = lateProvider(late, 'httpPwaLifecycleApplication');

  const processAdapters = options.process == null ? {} : requiredObject(options.process, 'process adapters');
  const exit = processAdapters.exit == null
    ? ((code) => process.exit(code))
    : requiredFunction(processAdapters.exit, 'process.exit');
  const defer = processAdapters.defer == null
    ? setImmediate
    : requiredFunction(processAdapters.defer, 'process.defer');
  const logger = processAdapters.logger == null ? console : requiredLogger(processAdapters.logger);

  function runtimeApplication() {
    return resolveLate(runtimeProvider, 'runtimeServicesApplication');
  }

  function adminApplication() {
    return resolveLate(adminProvider, 'adminApplication');
  }

  function httpPwaApplication() {
    return resolveLate(httpPwaProvider, 'httpPwaLifecycleApplication');
  }

  const stateReplacementCoordinator = createStateReplacementCoordinator({
    busyChecks:[
      ['backup', () => callLate(runtimeProvider, 'runtimeServicesApplication', 'isBackupInFlight')],
      ['transfers', () => activeTransfers.size > 0],
      ['uploads', () => callLate(runtimeProvider, 'runtimeServicesApplication', 'hasActiveUploads')],
      ['share-http', () => shareMediaTransferApplication.isBusyForStateReplacement()
        || callLate(publicHttpProvider, 'publicHttpApplication', 'isBusyForStateReplacement')],
      ['maintenance', () => callLate(runtimeProvider, 'runtimeServicesApplication', 'isMaintenanceStateReplacementBusy')],
      ['connector-jobs', () => {
        const application = adminApplication();
        const service = requiredObject(
          application.storageConnectorJobService,
          'late provider adminApplication.storageConnectorJobService'
        );
        return ownFunction(
          service,
          'isBusyForStateReplacement',
          'late provider adminApplication.storageConnectorJobService'
        ).call(service);
      }],
      ['security', () => callLate(securityProvider, 'securityAuthApplication', 'isBusyForStateReplacement')],
      ['notifications', () => notificationApplication.isBusyForStateReplacement()],
    ],
    resetSteps:[
      ['security', () => callLate(securityProvider, 'securityAuthApplication', 'clearRuntimeState')],
      ['transfers', () => transferService.clearRuntimeState()],
      ['downloads', () => callLate(publicHttpProvider, 'publicHttpApplication', 'clearRuntimeState')],
      ['media', () => shareMediaTransferApplication.clearMediaRuntimeState()],
      ['uploads', () => callLate(runtimeProvider, 'runtimeServicesApplication', 'clearUploadRuntimeAfterRestore')],
      ['pwa-pair-tickets', () => {
        const application = httpPwaApplication();
        const tickets = requiredObject(application.pairTickets, 'late provider httpPwaLifecycleApplication.pairTickets');
        const clear = requiredFunction(tickets.clear, 'late provider httpPwaLifecycleApplication.pairTickets.clear');
        return clear.call(tickets);
      }],
      ['webauthn', () => {
        const application = httpPwaApplication();
        const service = requiredObject(application.webauthn, 'late provider httpPwaLifecycleApplication.webauthn');
        return ownFunction(service, 'clearRuntimeState', 'late provider httpPwaLifecycleApplication.webauthn').call(service);
      }],
      ['notifications', () => notificationApplication.clearNotificationRuntimeState()],
      ['pwa-events', () => {
        const application = httpPwaApplication();
        const service = requiredObject(application.event, 'late provider httpPwaLifecycleApplication.event');
        return ownFunction(service, 'clearRuntimeState', 'late provider httpPwaLifecycleApplication.event').call(service);
      }],
      ['activity-presence', () => activityPresenceService.closeActivityPresenceStreams()],
      ['notification-center', () => notificationApplication.clearNotificationCenterRuntimeState()],
      ['pwa-notifications', () => notificationApplication.clearPwaNotificationRuntimeState()],
      ['maintenance', () => callLate(runtimeProvider, 'runtimeServicesApplication', 'clearMaintenanceRuntimeState')],
      ['connector-jobs', () => {
        const application = adminApplication();
        const service = requiredObject(
          application.storageConnectorJobService,
          'late provider adminApplication.storageConnectorJobService'
        );
        return ownFunction(
          service,
          'clearRuntimeAfterRestore',
          'late provider adminApplication.storageConnectorJobService'
        ).call(service);
      }],
      ['system-health', () => {
        const application = adminApplication();
        const service = requiredObject(
          application.systemHealthService,
          'late provider adminApplication.systemHealthService'
        );
        return ownFunction(
          service,
          'clearRuntimeState',
          'late provider adminApplication.systemHealthService'
        ).call(service);
      }],
      ['account-bootstrap', () => accountService.clearInitialPassword()],
      ['search', () => searchService.resetAfterRestore(1000)],
    ],
  });

  const stateLifecycle = coreStateApplication.initializeStateLifecycle({
    LOG_FILE,
    stateReplacementCoordinator,
    normalizePhotoHistory:boundMethod(photoService, 'normalizePhotoHistory', 'share-media application.photoService'),
    sanitizeUndoLog:boundMethod(shareFacade, 'sanitizeUndoLog', 'share-media application.shareFacade'),
    sanitizeDlpQuarantineState:boundMethod(dlpService, 'sanitizeDlpQuarantineState', 'share-media application.dlpService'),
    reconcileDlpQuarantineFiles:boundMethod(dlpService, 'reconcileDlpQuarantineFiles', 'share-media application.dlpService'),
    migrateLegacyFirstUseExpiryState:boundMethod(shareFacade, 'migrateLegacyFirstUseExpiryState', 'share-media application.shareFacade'),
    // Preserve the historical bridge semantics: restore must call the current
    // share-service method with its owning receiver instead of freezing a bare
    // function at application-composition time.
    clearShareRuntimeState:dynamicMethod(shareService, 'clearRuntimeState', 'share-media application.shareService'),
    cleanupDlpQuarantineOrphans:boundMethod(dlpService, 'cleanupDlpQuarantineOrphans', 'share-media application.dlpService'),
    migrateLegacyPhotoStorage:boundMethod(photoService, 'migrateLegacyPhotoStorage', 'share-media application.photoService'),
    reindex:boundMethod(shareFacade, 'reindex', 'share-media application.shareFacade'),
    trimLogIfNeeded:boundMethod(transferService, 'trimLogIfNeeded', 'share-media application.transferService'),
    pruneHistory:boundMethod(transferService, 'pruneHistory', 'share-media application.transferService'),
    exit,
    defer,
    logger,
  });

  requiredObject(stateLifecycle, 'core state lifecycle result');
  // The core lifecycle is idempotent and may already be initialized. Publish the
  // exact coordinator facade owned by that lifecycle instead of the fresh local
  // candidate, otherwise a repeated composition could expose a coordinator that
  // is not the one used by restoreService.
  const activeCoordinator = requiredObject(
    stateLifecycle.stateReplacementCoordinator,
    'core state lifecycle result.stateReplacementCoordinator'
  );
  const restoreService = requiredObject(stateLifecycle.restoreService, 'core state lifecycle result.restoreService');
  const stateBootstrapService = requiredObject(
    stateLifecycle.stateBootstrapService,
    'core state lifecycle result.stateBootstrapService'
  );

  return Object.freeze({
    stateReplacementCoordinator:activeCoordinator,
    restoreService,
    stateBootstrapService,
  });
}

module.exports = { createStateLifecycleApplication };
