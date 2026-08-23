'use strict';

const { createAdminRouter } = require('./admin-router');
const { attachAdminAccountRoutes } = require('./admin-account-routes');
const { attachAdminSecurityRoutes } = require('./admin-security-routes');
const { attachAdminStorageRoutes } = require('./admin-storage-routes');
const { attachAdminShareCoreRoutes, attachAdminShareRoutes, normalizeTags } = require('./admin-share-routes');
const { attachAdminPhotoRoutes } = require('./admin-photo-routes');
const { attachAdminSettingsRoutes } = require('./admin-settings-routes');
const { attachAdminDashboardRoutes } = require('./admin-dashboard-routes');
const { attachAdminDiagnosticsRoutes } = require('./admin-diagnostics-routes');
const { createStorageConnectorJobService } = require('./storage-connector-job-service');
const { createDiagnosticsService } = require('./diagnostics-service');
const { createSystemHealthService } = require('./system-health-service');
const { normalizeLinkBase } = require('./share-presentation-service');
const { GoogleOAuthProfileStore } = require('../google-oauth-profile');
const { GoogleOAuthBrokerClient } = require('../google-oauth-broker-client');

const ROUTE_DOMAINS = Object.freeze({
  account:Object.freeze([
    'platform', 'auth-utils', 'state-store', 'account', 'activity', 'audit',
    'notification', 'notification-center', 'share', 'session', 'public-access', 'admin-boundary',
    'service-refs', 'admin-adapters',
  ]),
  security:Object.freeze([
    'platform', 'core-utils', 'state-store', 'settings', 'audit', 'dlp', 'maintenance',
    'session', 'admin-boundary', 'service-refs', 'admin-adapters', 'early-adapters',
  ]),
  storage:Object.freeze([
    'platform', 'core-utils', 'storage-connectors', 'state-store', 'account', 'audit',
    'admin-boundary', 'storage-jobs', 'storage-adapters', 'early-adapters',
  ]),
  shareCore:Object.freeze([
    'config', 'platform', 'core-utils', 'photo-utils', 'state-store', 'settings',
    'activity', 'audit', 'notification', 'notification-center', 'share', 'photo',
    'search-compat', 'dlp', 'transfer', 'public-access', 'download', 'upload',
    'storage-jobs', 'share-presentation', 'admin-boundary', 'admin-adapters',
    'early-adapters', 'share-route-adapters',
  ]),
  share:Object.freeze([
    'config', 'platform', 'core-utils', 'photo-utils', 'state-store', 'settings',
    'activity', 'audit', 'notification', 'notification-center', 'share', 'photo',
    'search-compat', 'dlp', 'public-access', 'upload', 'share-presentation',
    'admin-boundary', 'admin-adapters', 'early-adapters', 'share-route-adapters',
    'share-core-output',
  ]),
  settings:Object.freeze([
    'config', 'platform', 'state-store', 'settings', 'activity', 'audit', 'notification',
    'notification-center', 'share', 'transfer', 'admin-boundary', 'late-adapters',
  ]),
  photo:Object.freeze([
    'config', 'platform', 'core-utils', 'photo-utils', 'dlp-utils', 'state-store', 'settings',
    'notification-center', 'share', 'photo', 'dlp', 'download', 'share-presentation', 'audit',
    'admin-boundary', 'early-adapters', 'share-route-adapters', 'share-core-output',
    'runtime-constants',
  ]),
  dashboard:Object.freeze([
    'config', 'platform', 'core-utils', 'state-store', 'account', 'activity', 'audit',
    'notification', 'share', 'transfer', 'auth', 'public-access', 'admin-boundary',
    'service-refs', 'share-route-adapters', 'late-service-refs', 'runtime-constants',
  ]),
  diagnostics:Object.freeze([
    'config', 'platform', 'core-utils', 'photo-utils', 'file-content-utils', 'text-render',
    'state-store', 'settings', 'network', 'share-presentation', 'audit', 'notification',
    'search-compat', 'restore', 'session', 'download', 'backup', 'admin-boundary',
    'early-adapters', 'late-service-refs', 'late-adapters', 'pwa-device', 'tls-manager',
  ]),
});

function requireContext(context) {
  if (!context || typeof context.current !== 'function' || typeof context.register !== 'function' || typeof context.route !== 'function') {
    throw new TypeError('admin-application requires an application context');
  }
  return context;
}

function requireDomain(context, name) {
  const value = context.current(name);
  if (!value) throw new TypeError(`admin-application requires context domain ${name}`);
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`admin-application requires ${name}()`);
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`admin-application requires ${name}`);
  return value;
}

function requirePromiseLike(value, name) {
  if (!value || typeof value.then !== 'function') throw new TypeError(`admin-application requires ${name}`);
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`admin-application requires ${name} to be a non-negative integer`);
  return value;
}

/**
 * Owns administrator-side service composition and the complete protected route
 * surface. server.js keeps only lifecycle-sensitive ordering: it builds the
 * domain services, invokes this factory once, creates the HTTP/PWA layers, then
 * calls attachLateRoutes() immediately before mounting /api.
 *
 * Route dependency profiles stay here beside their attach calls, so adding or
 * removing an admin route dependency no longer makes the process entrypoint grow.
 */
function createAdminApplication(options = {}) {
  const context = requireContext(options.context);
  const bootstrap = requireObject(options.bootstrap, 'bootstrap');
  const live = requireObject(options.live, 'live bindings');
  const pwa = requireObject(options.pwa, 'PWA adapters');
  const runtime = requireObject(options.runtime, 'runtime adapters');
  const rootRoutes = requireObject(options.rootRoutes, 'root routes');

  const getState = requireFunction(live.getState, 'live.getState');
  const setState = requireFunction(live.setState, 'live.setState');
  const getSearchIndexBuilding = requireFunction(live.getSearchIndexBuilding, 'live.getSearchIndexBuilding');
  const getSearchIndexError = requireFunction(live.getSearchIndexError, 'live.getSearchIndexError');
  const getUniversalSearchIndex = requireFunction(live.getUniversalSearchIndex, 'live.getUniversalSearchIndex');
  const getPwaPairTickets = requireFunction(live.getPwaPairTickets, 'live.getPwaPairTickets');
  const getServerScheme = requireFunction(runtime.getServerScheme, 'runtime.getServerScheme');
  const undoLogMax = requireNonNegativeInteger(runtime.undoLogMax, 'runtime.undoLogMax');
  const visitorFeedbackMax = requireNonNegativeInteger(runtime.visitorFeedbackMax, 'runtime.visitorFeedbackMax');
  const storageConnectorService = requireObject(bootstrap.storageConnectorService, 'bootstrap.storageConnectorService');
  const connectorStartupCleanup = requirePromiseLike(bootstrap.connectorStartupCleanup, 'bootstrap.connectorStartupCleanup');
  const storageSetup = requireObject(bootstrap.storageSetup, 'bootstrap.storageSetup');

  const config = requireDomain(context, 'config');
  const platform = requireDomain(context, 'platform');
  const stateStore = requireDomain(context, 'state-store');
  const settings = requireDomain(context, 'settings');
  const account = requireDomain(context, 'account');
  const network = requireDomain(context, 'network');
  const activity = requireDomain(context, 'activity');
  const audit = requireDomain(context, 'audit');
  const notification = requireDomain(context, 'notification');
  const notificationCenter = requireDomain(context, 'notification-center');
  const share = requireDomain(context, 'share');
  const ocr = requireDomain(context, 'ocr');
  const searchCompat = requireDomain(context, 'search-compat');
  const session = requireDomain(context, 'session');
  const auth = requireDomain(context, 'auth');
  const upload = requireDomain(context, 'upload');
  const backup = requireDomain(context, 'backup');
  const tlsManager = requireDomain(context, 'tls-manager');
  const early = requireDomain(context, 'early-adapters');
  const shareConstants = requireObject(share.constants, 'share.constants');

  const {
    fs, path, crypto, express, webpush,
  } = platform;
  for (const [name, value] of Object.entries({ fs, path, crypto })) requireObject(value, `platform.${name}`);
  if (typeof express !== 'function' || typeof express.Router !== 'function') throw new TypeError('admin-application requires platform.express');

  const accountNeedsPwChange = requireFunction(account.accountNeedsPasswordChange, 'account.accountNeedsPasswordChange');
  const getAccountById = requireFunction(account.getAccountById, 'account.getAccountById');
  const getById = requireFunction(share.getById, 'share.getById');
  const requireAuth = requireFunction(session.requireAuth, 'session.requireAuth');

  const adminBoundary = createAdminRouter({ express, requireAuth, getAccountById, accountNeedsPwChange, getById });
  const { adminRouter, ownsShare } = adminBoundary;
  context.register('admin-boundary', adminBoundary);
  context.register('service-refs', {
    authService:auth,
    sessionService:session,
    storageConnectorService,
    auditService:audit,
  });

  function currentAccount(req) {
    return getAccountById(req.session.accountId);
  }

  const loginHints = requireFunction(rootRoutes.loginHints, 'rootRoutes.loginHints');
  const sendLocalCaCertificate = requireFunction(rootRoutes.sendLocalCaCertificate, 'rootRoutes.sendLocalCaCertificate');

  context.register('admin-adapters', {
    accountNeedsPwChange,
    adminPwFromEnv:account.isEnvironmentPasswordManaged(),
    appName:config.APP_NAME,
    currentAccount,
    getNotificationMutableCategories:() => notificationCenter.NOTIFICATION_MUTABLE_CATEGORIES,
    getCustomNotificationRuleMetrics:() => notificationCenter.CUSTOM_NOTIFICATION_RULE_METRICS,
    getPwaPairTickets,
    pwaDeviceResolvedAccount:requireFunction(pwa.pwaDeviceResolvedAccount, 'pwa.pwaDeviceResolvedAccount'),
    cleanupPwaCapabilityScopes:requireFunction(pwa.cleanupPwaCapabilityScopes, 'pwa.cleanupPwaCapabilityScopes'),
    loginHints,
    publicIp:requireFunction(activity.pubIp, 'activity.pubIp'),
  });

  attachAdminAccountRoutes(context.route('adminAccount', ROUTE_DOMAINS.account, {
    getState,
    replaceState:setState,
  }));

  attachAdminSecurityRoutes(context.route('adminSecurity', ROUTE_DOMAINS.security, { getState }));

  // Storage connector jobs are administrator-owned orchestration. Connector
  // credentials continue to live exclusively in rclone.conf; this service only
  // keeps metadata, bounded probes and transfer job state in the application store.
  const storageConnectorJobService = createStorageConnectorJobService({
    storageConnectorService,
    connectorStartupCleanup,
    maxActiveJobs:config.MAX_ACTIVE_CONNECTOR_JOBS,
    INBOX_DIR:config.INBOX_DIR,
    IMAGE_STORE_DIR:config.IMAGE_STORE_DIR,
    HOST_ROOT:config.HOST_ROOT,
    getState,
    trashItems:share.trashItems,
    persist:stateStore.persist,
    persistNow:stateStore.persistNow,
    scheduleFlush:stateStore.scheduleFlush,
    crypto,
    path,
    withinRoot:early.withinRoot,
    assertRealWithin:early.assertRealWithin,
    hostToContainer:early.hostToContainer,
    clientIp:early.clientIp,
    cleanConnectorPath:early.cleanConnectorPath,
    clamavEnabled:config.clamavEnabled,
    scanFile:upload.scanFile,
    quarantineFile:upload.quarantineFile,
    connectorErrorCode:early.connectorErrorCode,
    logAudit:audit.logAudit,
    getAccountById,
    scheduleSearchReindex:searchCompat.scheduleSearchReindex,
  });
  const { connectorStore } = storageConnectorJobService;
  const googleOAuthProfileStore = new GoogleOAuthProfileStore({ dataDir:config.DATA_DIR, dataKey:config.DATA_KEY });
  const googleOAuthBrokerClient = new GoogleOAuthBrokerClient({
    baseUrl:config.GOOGLE_OAUTH_BROKER_URL_ENV,
    version:config.APP_VERSION,
  });

  context.register('storage-jobs', storageConnectorJobService);
  context.register('storage-adapters', {
    storageConnectorService,
    googleOAuthProfileStore,
    googleOAuthBrokerClient,
    connectorTypes:requireDomain(context, 'storage-connectors').CONNECTOR_TYPES,
    oauthConnectorTypes:requireDomain(context, 'storage-connectors').OAUTH_CONNECTOR_TYPES,
    googleOAuthPublicOrigin:() => normalizeLinkBase(settings.getSettings().linkBase || config.PUBLIC_URL || '') || '',
    googleOAuthBrokerUrl:() => config.GOOGLE_OAUTH_BROKER_URL_ENV || String(settings.getSettings().googleOAuthBrokerUrl || '').trim(),
    googleOAuthBrokerManaged:() => !!config.GOOGLE_OAUTH_BROKER_URL_ENV,
    cleanConnectorPath:early.cleanConnectorPath,
    maxStorageConnectors:config.MAX_STORAGE_CONNECTORS,
    connectorJobService:storageConnectorJobService,
  });

  attachAdminStorageRoutes(context.route('adminStorage', ROUTE_DOMAINS.storage, {
    storageConnectorService,
    cleanConnectorPath:early.cleanConnectorPath,
    connectorErrorCode:early.connectorErrorCode,
    connectorHttpStatus:early.connectorHttpStatus,
  }));

  const logFile = path.join(config.DATA_DIR, 'transfers.log');
  context.register('share-route-adapters', {
    LOG_FILE:logFile,
    SHARE_CHANGE_HISTORY_MAX:shareConstants.SHARE_CHANGE_HISTORY_MAX,
    UNDO_LOG_MAX:undoLogMax,
    VISITORS_MAX:shareConstants.VISITORS_MAX,
    VISITOR_FEEDBACK_MAX:visitorFeedbackMax,
    SHARE_BACKING_HEALTH_CACHE_MS:shareConstants.SHARE_BACKING_HEALTH_CACHE_MS,
    SHARE_LOGICAL_BYTES_CACHE_MS:shareConstants.SHARE_LOGICAL_BYTES_CACHE_MS,
    clearShareRuntimeState:() => share.clearRuntimeState(),
    inboxReceivedFiles:requireFunction(pwa.inboxReceivedFiles, 'pwa.inboxReceivedFiles'),
    stampPhotoUploadDevice:requireFunction(pwa.stampPhotoUploadDevice, 'pwa.stampPhotoUploadDevice'),
    photoUploadDeviceName:requireFunction(pwa.photoUploadDeviceName, 'pwa.photoUploadDeviceName'),
    normalizeTags,
  });

  const adminShareRouteLiveBindings = {
    get state() { return getState(); },
    set state(value) { setState(value); },
    get searchIndexBuilding() { return getSearchIndexBuilding(); },
    get searchIndexError() { return getSearchIndexError(); },
    get universalSearchIndex() { return getUniversalSearchIndex(); },
  };
  const shareCoreOutput = requireObject(
    attachAdminShareCoreRoutes(context.route('adminShareCore', ROUTE_DOMAINS.shareCore, {
      PENDING_DIR:config.PENDING_DIR,
      live:adminShareRouteLiveBindings,
    })),
    'admin share core output',
  );
  Object.freeze(shareCoreOutput);
  context.register('share-core-output', shareCoreOutput);

  // Preserve the historical registration order: core share routes are attached
  // first, then lifecycle/mutation routes, while photo routes are still deferred
  // to attachLateRoutes() near the final /api mount.
  attachAdminShareRoutes(context.route('adminShare', ROUTE_DOMAINS.share, {
    PENDING_DIR:config.PENDING_DIR,
    live:adminShareRouteLiveBindings,
  }));

  const tlsConfig = requireObject(tlsManager.config, 'tls-manager config');
  const diagnosticsService = createDiagnosticsService({
    tlsCert:tlsConfig.TLS_CERT,
    tlsKey:tlsConfig.TLS_KEY,
    tlsDayMs:tlsConfig.TLS_DAY_MS,
    tlsManager,
    localCaModeActive:tlsManager.localCaModeActive,
    readManagedTlsFile:tlsManager.readManagedTlsFile,
    localCaPaths:tlsManager.localCaPaths,
    localCaStatus:tlsManager.localCaStatus,
    validateProvidedTlsPair:tlsManager.validateProvidedTlsPair,
    certificateFingerprint256:tlsManager.certificateFingerprint256,
    tlsMaterialFingerprint:tlsManager.tlsMaterialFingerprint,
  });

  const ocrConfig = requireObject(ocr.getConfig(), 'OCR config');
  const auditPaths = requireObject(audit.paths, 'audit paths');
  const systemHealthService = createSystemHealthService({
    DATA_DIR:config.DATA_DIR,
    FULL_IMAGES_DIR:config.FULL_IMAGES_DIR,
    THUMBS_DIR:config.THUMBS_DIR,
    MICROS_DIR:config.MICROS_DIR,
    PHOTO_HISTORY_DIR:config.PHOTO_HISTORY_DIR,
    PHOTO_VERSIONS_DIR:config.PHOTO_VERSIONS_DIR,
    ADAPTIVE_IMAGES_DIR:config.ADAPTIVE_IMAGES_DIR,
    ENC_DIR:config.ENC_DIR,
    SECRETS_DIR:config.SECRETS_DIR,
    QUARANTINE_DIR:config.QUARANTINE_DIR,
    SEARCH_INDEX_FILE:path.join(config.DATA_DIR, 'search-index.json'),
    SEARCH_OCR_CACHE_FILE:path.join(config.DATA_DIR, 'search-ocr-cache.json'),
    LOG_FILE:logFile,
    AUDIT_CHAIN_FILE:auditPaths.chainFile,
    STORE_FILE:stateStore.storeFile,
    AUDIT_HEAD_FILE:auditPaths.headFile,
    AUDIT_KEY_FILE:auditPaths.keyFile,
    IMAGE_STORE_DIR:config.IMAGE_STORE_DIR,
    INBOX_DIR:config.INBOX_DIR,
    STORAGE_SETUP:storageSetup,
    DATA_KEY:config.DATA_KEY,
    CLAMAV_HOST:config.CLAMAV_HOST,
    CLAMAV_PORT:config.CLAMAV_PORT,
    SEARCH_OCR_ENABLED:!!ocrConfig.enabled,
    SEARCH_OCR_LANGS:ocrConfig.langs,
    PUBLIC_URL:config.PUBLIC_URL,
    TRUST_PROXY:config.TRUST_PROXY,
    PORT:config.PORT,
    ADMIN_ALLOWED_IPS:config.ADMIN_ALLOWED_IPS,
    getState,
    getSettings:settings.getSettings,
    getServerScheme,
    getWebpush:() => webpush,
    diagnosticsService,
    connectorJobService:storageConnectorJobService,
    verifyAuditChain:audit.verifyAuditChain,
    auditService:audit,
    universalSearchStatus:searchCompat.universalSearchStatus,
    detectSearchOcrTools:ocr.detectTools,
    diskFreeThresholds:notificationCenter.diskFreeThresholds,
    isBackupInFlight:backup.isBackupInFlight,
    clamavEnabled:config.clamavEnabled,
    tlsManager,
    connectorStore,
    pushSubs:notification.pushSubs,
    emailConfigured:notification.emailConfigured,
    effectiveWebhook:notification.effectiveWebhook,
    getLastEmail:notification.getLastEmail,
    getLastWebhook:notification.getLastWebhook,
    getLocalIPv4s:network.getLocalIPv4s,
    listShares:share.listShares,
    isScheduled:share.isScheduled,
    isActive:share.isActive,
    shareEffectiveExpiry:share.shareEffectiveExpiry,
    shareBackingHealthSnapshot:share.shareBackingHealthSnapshot,
    queueShareBackingHealthRefresh:share.queueShareBackingHealthRefresh,
  });
  context.register('diagnostics', diagnosticsService);
  context.register('system-health', systemHealthService);

  let lateRoutesState = 'idle';
  function attachLateRoutes(late = {}) {
    if (lateRoutesState !== 'idle') {
      throw new Error(`admin-application late routes cannot attach from state ${lateRoutesState}`);
    }
    const shutdown = requireFunction(late.shutdown, 'late.shutdown');
    const getServer = requireFunction(late.getServer, 'late.getServer');

    // Preflight lifecycle-sensitive external domains before registering late
    // adapters or mutating the Express router. A missing PWA/public-share domain
    // must fail cleanly instead of leaving the administrator router partly attached.
    requireDomain(context, 'pwa-device');
    const publicShare = requireDomain(context, 'public-share');
    const renderMaxBytes = publicShare.RENDER_MAX_BYTES;
    if (!Number.isSafeInteger(renderMaxBytes) || renderMaxBytes <= 0) {
      throw new TypeError('admin-application requires public-share.RENDER_MAX_BYTES to be a positive integer');
    }

    lateRoutesState = 'attaching';
    try {
      context.register('late-service-refs', {
        auditService:audit,
        diagnosticsService,
        systemHealthService,
      });
      context.register('late-adapters', {
        STORAGE_SETUP:storageSetup,
        RENDER_MAX_BYTES:renderMaxBytes,
        SEARCH_OCR_ENABLED:!!ocrConfig.enabled,
        SEARCH_OCR_LANGS:ocrConfig.langs,
        sendLocalCaCertificate,
        detectSearchOcrTools:ocr.detectTools,
        shutdown,
        getServer,
      });

      // Resolve every late dependency profile before mutating adminRouter. Keep
      // the exact preflighted facades for attachment so composition cannot observe
      // a second dependency snapshot between validation and route registration.
      const lateRouteDeps = Object.freeze({
        settings:context.route('adminSettings', ROUTE_DOMAINS.settings, { getState }),
        photo:context.route('adminPhoto', ROUTE_DOMAINS.photo, { getState }),
        dashboard:context.route('adminDashboard', ROUTE_DOMAINS.dashboard, { getState }),
        diagnostics:context.route('adminDiagnostics', ROUTE_DOMAINS.diagnostics, { getState }),
      });

      attachAdminSettingsRoutes(lateRouteDeps.settings);
      attachAdminPhotoRoutes(lateRouteDeps.photo);
      attachAdminDashboardRoutes(lateRouteDeps.dashboard);
      attachAdminDiagnosticsRoutes(lateRouteDeps.diagnostics);
      lateRoutesState = 'attached';
    } catch (error) {
      lateRoutesState = 'failed';
      throw error;
    }
  }

  return Object.freeze({
    adminRouter,
    ownsShare,
    currentAccount,
    shareCoreOutput,
    storageConnectorJobService,
    connectorStore,
    diagnosticsService,
    systemHealthService,
    attachLateRoutes,
  });
}

module.exports = { ROUTE_DOMAINS, createAdminApplication };
