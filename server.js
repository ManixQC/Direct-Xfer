'use strict';
/*
 * Direct-Xfer — direct HTTP file sharing, single server.
 * Backend composition root (state, services and HTTP route orchestration).
 * Reusable helpers live under ./lib; large server subsystems live under ./lib/server.
 * Configuration, runtime bootstrap and process lifecycle live behind dedicated modules.
 * The static web interface is served from ./public.
 * Architecture map
 * ----------------
 *  1. Configuration/bootstrap service composition
 *  2. Core state and persistence primitives
 *  3. Security services (auth credentials/TOTP, sessions and CSRF)
 *  4. Application services (TLS, network, notifications, public pages, backups)
 *  5. Share lifecycle/domain + search/OCR/DLP services
 *  6. Upload/reception service + reception/collaboration route boundary
 *  7. Administrator application composition + protected domain route modules
 *  8. PWA HTTP boundary + dedicated share-management route boundary
 *  9. Final HTTP/PWA/process-lifecycle composition and listener start
 *
 * Large cohesive services should live in ./lib/server rather than growing this file.
 * Account bootstrap/lookups live in ./lib/server/account-service.js,
 * auth/TOTP lives in ./lib/server/auth-service.js, and browser sessions/CSRF
 * live in ./lib/server/session-service.js. Their composition, plus public-link access/anti-abuse
 * wiring, is centralized in ./lib/server/security-auth-application.js; domain modules own mutable state.
 * Admin service orchestration, protected route dependency profiles and attachment order live in
 * ./lib/server/admin-application.js; individual administrator domains stay in ./lib/server/admin-*.js.
 * Upload accounting/staging lives in
 * ./lib/server/upload-reception-service.js and writable public routes live in
 * ./lib/server/reception-collaboration-routes.js. Read-only public share/image/gallery/secret
 * HTTP orchestration lives in ./lib/server/public-share-routes.js. Download/range/ZIP streaming lives
 * in ./lib/server/download-service.js and transfer accounting/live state lives in
 * ./lib/server/transfer-service.js. Universal indexing/query lives in
 * ./lib/server/search-service.js, native OCR/cache handling lives in
 * ./lib/server/ocr-service.js, and DLP scanning/quarantine policy lives in
 * ./lib/server/dlp-service.js. Managed image storage/variants/history/versioning lives in
 * ./lib/server/photo-service.js. Share tokens/recipients, expiry, statistics, quotas,
 * visitors, trash/undo/restore and managed share storage live in ./lib/server/share-service.js.
 * Their share/media/search/transfer wiring is centralized in
 * ./lib/server/share-media-transfer-application.js. Visitor renderers, public security, Web Storage
 * helpers and late download/public-share HTTP composition live in ./lib/server/public-http-application.js.
 * Tamper-evident security journaling lives in ./lib/server/audit-service.js.
 * Persisted settings, startup state loading/migrations, transactional restore and periodic
 * retention/anomaly housekeeping live in ./lib/server/settings-service.js,
 * ./lib/server/state-bootstrap-service.js, ./lib/server/restore-service.js and
 * ./lib/server/maintenance-service.js. Root-state replacement busy/reset coordination lives in
 * ./lib/server/state-replacement-coordinator.js, while its cross-domain composition and startup/restore
 * lifecycle wiring are centralized in ./lib/server/state-lifecycle-application.js. Upload, backup and maintenance runtime wiring is
 * centralized in ./lib/server/runtime-services-application.js. Their core/state composition and live root-state cell
 * are centralized in ./lib/server/core-state-application.js.
 * Storage connector inventory/probes/jobs, storage accounting, system-health snapshots and
 * bounded host diagnostics live in ./lib/server/storage-connector-job-service.js,
 * ./lib/server/system-health-service.js and ./lib/server/diagnostics-service.js.
 * Notification transport, durable center policy and PWA push delivery live in
 * ./lib/server/notification-service.js, ./lib/server/notification-center-service.js and
 * ./lib/server/pwa-notification-service.js; their cross-wiring is centralized in
 * ./lib/server/notification-application.js.
 * PWA device/ownership, photo/album/retention, WebAuthn/passkeys and live PWA event
 * policy live in ./lib/server/pwa-device-service.js, ./lib/server/pwa-photo-service.js,
 * ./lib/server/webauthn-service.js and ./lib/server/pwa-event-service.js. PWA service
 * bootstrap, parser/template setup and route façade composition live in
 * ./lib/server/pwa-application.js; HTTP route declarations stay in ./lib/server/pwa-routes.js,
 * while the deferred service registry and route contract live in
 * ./lib/server/pwa-composition-service.js. Process/platform dependency loading lives in
 * ./lib/server/platform-dependencies.js. Environment/path parsing, rclone/Windows bootstrap
 * and HTTP(S)/shutdown ownership live in ./lib/server/config.js,
 * ./lib/server/bootstrap.js and ./lib/server/lifecycle-service.js. Final Express route order,
 * PWA publication and lifecycle wiring are centralized in ./lib/server/http-pwa-lifecycle-application.js.
 * Public URL resolution and
 * complete API/UI share projection live in ./lib/server/share-presentation-service.js. Public-link
 * IP/country rules, password/unlock/request cookies and brute-force state live in
 * ./lib/server/public-access-service.js; transfer throttling, message deduplication and
 * proof-of-work live in ./lib/server/public-abuse-service.js. Activity history, IP privacy and
 * activity/download-presence SSE live in ./lib/server/activity-presence-service.js. Private Windows
 * launcher password recovery, readiness and shutdown routes live in
 * ./lib/server/windows-launcher-routes.js. Host/container path containment lives in
 * ./lib/server/host-path-service.js, while generic bounded concurrency lives in
 * ./lib/core-utils.js. Express security headers, administrator network gating,
 * public browser assets, SPA fallbacks and final HTTP errors live in
 * ./lib/server/http-application.js. Cross-domain route dependency contracts and
 * compatibility façades are enforced centrally by ./lib/server/application-context.js.
 * Direct-domain entry construction lives in ./lib/server/register-application-domains.js,
 * while atomic publication of the complete application graph plus writable reception/
 * collaboration route attachment live in ./lib/server/application-publication.js.
 * server.js stays below GitHub's 1 MiB
 * source-rendering threshold so syntax highlighting and code navigation remain usable.
 */
const { createPlatformDependencies } = require('./lib/server/platform-dependencies');
const {
  CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, cleanRelativePath:cleanConnectorPath,
  connectorErrorCode, connectorHttpStatus,
} = require('./lib/storage-connectors');
const {
  bool, compareSemver, isPrivateIp, ipToInt, intToIp, maskToPrefix,
  parseIpList, ipInList, isLoopback, flagFromCode, timingSafeEqualStr,
  formatBytes,
} = require('./lib/core-utils');
const { createServerConfig } = require('./lib/server/config');
const { createRuntimeBootstrap } = require('./lib/server/bootstrap');
const { createApplicationContext } = require('./lib/server/application-context');
const { createServerBootstrapReferences } = require('./lib/server/bootstrap-reference-registry');
const { createCoreStateBridges } = require('./lib/server/core-state-bridges');
const { createStateLifecycleApplication } = require('./lib/server/state-lifecycle-application');
const { publishApplicationGraph } = require('./lib/server/application-publication');
const { createRequestUtils } = require('./lib/server/request-utils');
const { createCoreStateApplication } = require('./lib/server/core-state-application');
const { createNotificationApplication } = require('./lib/server/notification-application');
const { createPwaServiceRegistry } = require('./lib/server/pwa-composition-service');
const { createRuntimeServicesApplication } = require('./lib/server/runtime-services-application');

const { createSecurityAuthApplication } = require('./lib/server/security-auth-application');
const { createShareMediaTransferApplication } = require('./lib/server/share-media-transfer-application');
const { createPublicHttpApplication } = require('./lib/server/public-http-application');
const { createFinalHttpApplication } = require('./lib/server/final-http-application');
const { openFd, closeFd, readFd } = require('./lib/fd-utils');

const applicationContext = createApplicationContext();
let notificationApplication = null;
let runtimeServicesApplication = null;

// Only callbacks that genuinely cross bootstrap order stay lazy. Their contracts
// are centralized and validated before each provider becomes visible.
const bootstrapReferences = createServerBootstrapReferences();
const {
  getById, getByToken, isActive, listShares,
  shareFirstUseDeadline, shareInactiveDeadline, shareEffectiveExpiry, parseMaxVisitors,
  centerPublicVisitorDeviceLabel, receptionThreadEnabled, runtimeFolderMetrics,
  currentAccount, ownsShare, resolveHostItem,
} = bootstrapReferences.refs;

// Notification, session and share services are composed before the concrete PWA
// domains. These deferred facades keep that startup order explicit without
// duplicating one forwarding function per PWA operation in this composition root.
const pwaServices = createPwaServiceRegistry();
const {
  cleanupPwaCapabilityScopes, getPwaDevice, photoUploadDeviceName,
  pwaDeviceResolvedAccount, stampPhotoUploadDevice,
} = pwaServices.device;
const {
  closePwaEventStreamsForSession, emitInboxEvent,
  emitPwaOwnerEvent, inboxReceivedFiles, ownerKeysForShare,
} = pwaServices.event;
// Built-ins, external packages and optional TLS/notification transports are
// loaded once behind a dedicated platform boundary. Consumers receive frozen,
// named views instead of rebuilding ad-hoc platform objects in this root.
const platformDependencies = createPlatformDependencies();
const { EventEmitter, AsyncLocalStorage } = platformDependencies;
const serverConfig = createServerConfig({ rootDir:__dirname });
const { app:appConfig, http:httpConfig, paths:configPaths, security:securityConfig, notifications:notificationTransportConfig } = serverConfig.groups;
// Request-local CSP/template values are runtime state, not process configuration.
const requestContext = new AsyncLocalStorage();
// Shared HTTP request helpers (trust-proxy-aware client IP, cookie parsing, Secure
// flag). Declared early because most services and the early-adapters domain inject
// these by reference; their bodies live in request-utils.js.
const { clientIp, parseCookies, secureCookie } = createRequestUtils({ TRUST_PROXY:httpConfig.TRUST_PROXY });
const runtimeBootstrap = createRuntimeBootstrap({ config:serverConfig });
const {
  storageConnectorService,
  connectorStartupCleanup,
  dataWritable,
} = runtimeBootstrap;
const STORAGE_SETUP = runtimeBootstrap.storageSetup;

let finalHttpApplication = null;
function currentLifecycleService() {
  return finalHttpApplication ? finalHttpApplication.lifecycleService : null;
}
function shutdown(signal, exitCode = 0) {
  const lifecycleService = currentLifecycleService();
  if (!lifecycleService) return Promise.reject(new Error('server lifecycle is not started'));
  return lifecycleService.shutdown(signal, exitCode);
}
function currentServerScheme() {
  const lifecycleService = currentLifecycleService();
  return lifecycleService ? lifecycleService.getServerScheme() : 'http';
}
function currentHttpServer() {
  const lifecycleService = currentLifecycleService();
  return lifecycleService ? lifecycleService.getServer() : null;
}

// Core infrastructure and root-state ownership are composed behind one explicit
// boundary. The late compatibility surface is centralized in core-state-bridges;
// server.js only supplies the high-level bootstrap registries and request/lifecycle joints.
const coreStateBridges = createCoreStateBridges({
  bootstrapReferences,
  pwaRegistry:pwaServices,
  getServerScheme:currentServerScheme,
  clientIp,
});
const coreStateApplication = createCoreStateApplication({
  platform:platformDependencies.views.coreState,
  config:serverConfig,
  runtimeBootstrap,
  utils:{ bool, compareSemver, isPrivateIp, ipToInt, intToIp, maskToPrefix, flagFromCode, timingSafeEqualStr },
  bridges:coreStateBridges,
  env:process.env,
});
const {
  getState, replaceState, liveState,
  persist, persistNow, scheduleFlush,
  tlsManager, settingsService, accountService, hostPathService, networkServices,
  sharePresentationService, activityPresenceService, auditService,
} = coreStateApplication;
const {
  localCaModeActive, localCaFeatureRelevant, localCaPaths,
  readManagedTlsFile, certificateFingerprint256,
  validateLocalCaCertificate, readLocalCaCertificateOnly, ensureLocalCa,
  validateLeafCertificate, invalidateLocalCaStatusUiCache,
} = tlsManager;
const {
  getSettings, setSettings, setSettingsDurable,
} = settingsService;
const {
  dummyPasswordRecord:DUMMY_PW_REC,
  normalizeUsername:normUsername,
  accountList,
  findAccountByName,
  getAccountById,
  ownerAccount,
  accountPasswordRecord:accountPwRec,
  accountNeedsPasswordChange:accountNeedsPwChange,
} = accountService;
const { withinRoot, resolveWithin, assertRealWithin, containerToHost, hostToContainer } = hostPathService;
const {
  updateState, geoCache, GEO_TTL, geoSync, geolocate,
} = networkServices;
const { primaryBase, decorateShare } = sharePresentationService;
const {
  maskIp, pubIp, ipNameFor, bumpHistoryViewRevision,
  emitLiveActivity, schedulePresenceBroadcast,
} = activityPresenceService;
const { ACTIVITY_HISTORY_MAX } = activityPresenceService.constants;
const { ensureAuditChainKey, auditKeyId, logAudit, auditReq } = auditService;
const {
  chainFile:AUDIT_CHAIN_FILE,
  headFile:AUDIT_HEAD_FILE,
} = auditService.paths;
const UNDO_LOG_MAX = 25; // most recent undoable admin actions kept (state.undoLog, shares.json)
// Public-link IP/country policy is owned by public-access-service.js.
// ===================================================================
//  NOTIFICATIONS
// ===================================================================
// Transport, durable notification-center policy and PWA Push delivery are
// composed behind one boundary. The only late dependencies are explicit lazy
// bridges to share/media/transfer and upload domains created later in startup.
notificationApplication = createNotificationApplication({
  applicationContext,
  pwaRegistry:pwaServices,
  platform:platformDependencies.views.notification,
  config:{
    APP_NAME:appConfig.APP_NAME, APP_VERSION:appConfig.APP_VERSION,
    DATA_DIR:configPaths.DATA_DIR, PUBLIC_URL:httpConfig.PUBLIC_URL, TRUST_PROXY:httpConfig.TRUST_PROXY,
    STORAGE_SETUP, ...notificationTransportConfig,
  },
  state:{ getState, persist, persistNow, scheduleFlush },
  settingsService,
  accountService,
  sharePresentationService,
  activityPresenceService,
  auditService,
  bridges:{
    getById, getByToken, isActive, listShares,
    shareFirstUseDeadline, shareInactiveDeadline, shareEffectiveExpiry,
    parseMaxVisitors, centerPublicVisitorDeviceLabel,
    getShareMediaTransferApplication:() => shareMediaTransferApplication,
    getUploadReceptionService:() => {
      if (!runtimeServicesApplication) throw new Error('runtime services application is not composed yet');
      return runtimeServicesApplication.uploadReceptionService;
    },
    dataWritable, clientIp,
  },
  utils:{ formatBytes, flagFromCode },
});
const { notificationService, notificationCenterService } = notificationApplication;
bootstrapReferences.bindNotification(notificationApplication);
const { pruneLeakTrackers } = notificationService;
const { addCenterNotification, enrichCenterNotificationGeo } = notificationCenterService;

const DAY_MS = 86400000;

// Transfer history/IP privacy projection is owned by activity-presence-service.js.

// ===================================================================
//  STORE: shares + settings (persisted in shares.json)
// ===================================================================

// Persistent, exportable transfer journal (append-only JSONL).
const LOG_FILE = platformDependencies.path.join(configPaths.DATA_DIR, 'transfers.log');

// Audit journal paths and mutable cryptographic state are owned by auditService.

// Initialize the persistent root-state cell only after notification/PWA services
// have been composed, preserving the historical startup boundary while ownership
// of the state object and shares.json I/O stays inside core-state-application.js.
const {
  stateStore,
  storeFile:STORE_FILE,
  encryptStore, decryptStore, deserializeStore, flushNow,
} = coreStateApplication.initializePersistence();

// Activity history and live download presence are owned by activity-presence-service.js.

const shareMediaTransferApplication = createShareMediaTransferApplication({
  applicationContext,
  platform:platformDependencies.views.shareMediaTransfer,
  config:{ ...serverConfig, LOG_FILE },
  constants:{ DAY_MS, UNDO_LOG_MAX },
  state:{
    getState, getSettings, persist, persistNow, scheduleFlush, setSettingsDurable,
    encryptStore, deserializeStore,
  },
  paths:{ hostToContainer, containerToHost, assertRealWithin, resolveWithin },
  account:{ accountList, getAccountById, findAccountByName, normUsername },
  presentation:{ primaryBase, decorateShare },
  activity:{ pubIp, maskIp, emitLiveActivity, ipNameFor, schedulePresenceBroadcast, bumpHistoryViewRevision },
  network:{ clientIp, geoSync, geolocate, flagFromCode },
  notification:notificationApplication.shareMediaHooks,
  pwa:pwaServices.shareMediaHooks,
  bridges:{
    folderMetrics:runtimeFolderMetrics,
    resolveHostItem,
    webStorageShareMeta:(...args) => webStorageShareMeta(...args),
    webStorageStat:(...args) => webStorageStat(...args),
    currentAccount,
    getSession:(...args) => getSession(...args),
    validDownloadResumeId:(...args) => validDownloadResumeId(...args),
    pruneDownloadResumeSessions:(...args) => pruneDownloadResumeSessions(...args),
    ownsShare,
    dataWritable,
  },
});
const {
  shareService, photoService, ocrService, searchService, dlpService, transferService,
  shareFacade, searchCompat,
} = shareMediaTransferApplication;
bootstrapReferences.bindShareMediaTransfer(shareMediaTransferApplication);
const { recipientByToken, clampIndex, zipAllowed } = shareService;
const {
  SHARE_CHANGE_HISTORY_MAX,
  SHARE_LOGICAL_BYTES_CACHE_MS,
  SHARE_BACKING_HEALTH_CACHE_MS,
  VISITORS_MAX,
} = shareService.constants;
const {
  reindex, isScheduled, linkPrefix, addShare, restorePlainObject,
  shareBackingHealthSnapshot, queueShareBackingHealthRefresh, migrateLegacyFirstUseExpiryState,
  detachActiveShare, sanitizeUndoLog, destroyShareManagedData, purgeTrashRecordById,
  incrementDownloads, shareItems, recordAndCheckVisitor, ipDownloadQuotaBlocked,
  commitManagedIpDownload, noteBytesServed, bandwidthCapReached, bumpViews,
  recordRecipientView, runExpiredLinkLifecycle,
} = shareFacade;
const {
  normalizePhotoHistory, photoOriginalPaths, photoAdaptivePath, photoVariantPaths,
  firstExistingPhotoFile, migrateLegacyPhotoStorage, photoStatsOf, notePhotoView, hashFileSha256,
  streamToFileBounded, photoCacheRevision,
} = photoService;
const {
  universalSearchStatus, initUniversalSearchIndex,
} = searchCompat;
const {
  sanitizeDlpQuarantineState, reconcileDlpQuarantineFiles, cleanupDlpQuarantineOrphans,
} = dlpService;
const {
  claimOneTimeDownload, releaseOneTimeDownload, startTransfer, endTransfer,
} = transferService;

// Persistent state loading and startup migrations are coordinated after restore-service composition.

// Share lifecycle/statistics/trash operations are bound once through the application context above.

// Destructive direct-delete helper removed in 1.45.2. All share removals must
// flow through recoverable trash or destroyShareManagedData(), which waits for
// filesystem deletion before erasing the logical record.

// Files backing a share are normalized by the share domain service.

// Transactional restore and startup state normalization are a second phase of
// core-state composition. The lifecycle application owns the cross-domain
// busy/reset graph and derives migration hooks from the domain applications;
// services composed later remain behind explicit lazy providers.
const stateLifecycleApplication = createStateLifecycleApplication({
  coreStateApplication,
  config:{ LOG_FILE },
  services:{
    shareMediaTransferApplication,
    notificationApplication,
    activityPresenceService,
    accountService,
  },
  late:{
    securityAuthApplication:() => securityAuthApplication,
    publicHttpApplication:() => publicHttpApplication,
    runtimeServicesApplication:() => runtimeServicesApplication,
    adminApplication:() => finalHttpApplication && finalHttpApplication.adminApplication,
    httpPwaLifecycleApplication:() => finalHttpApplication && finalHttpApplication.httpPwaLifecycleApplication,
  },
  process:{ exit:(code) => process.exit(code), defer:setImmediate, logger:console },
});
const { restoreService } = stateLifecycleApplication;

// ===================================================================
//  LIFECYCLE: auto-shutdown after download
// ===================================================================

const bus = new EventEmitter();

function onDownloadComplete(info) {
  const settings = getSettings();
  if (!settings.shutdownAfterDownload) return;
  setSettings({ shutdownAfterDownload: false }); // one-shot: avoids a loop on restart
  console.log(
    `[lifecycle] complete download finished (${(info && info.name) || '?'}) — ` +
      'shutdown requested (auto-shutdown enabled in the interface).'
  );
  bus.emit('shutdown', info || {});
}

// ===================================================================
//  AUTH: sessions, CSRF, brute-force protection
// ===================================================================

// Administrator sessions, CSRF tokens and login lockouts are owned by the
// dedicated services instantiated below. Public-link password failure state is
// owned later by public-access-service.js.
// clientIp/parseCookies/secureCookie now live in request-utils.js and are
// destructured near the top of this composition root.

// Administrator sessions/CSRF and credential/TOTP services share one security
// composition boundary. Public-link access/anti-abuse joins it in a second phase
// after the public HTML renderers are available.
const securityAuthApplication = createSecurityAuthApplication({
  platform:platformDependencies.views.securityAuth,
  config:{ SESSION_TTL_MS:securityConfig.SESSION_TTL_MS, FAIL_WINDOW_MS:securityConfig.FAIL_WINDOW_MS },
  request:{ clientIp, parseCookies, secureCookie },
  state:{ getSettings, scheduleFlush, persistNow },
  account:{
    getAccountById, findAccountByName, accountPasswordRecord:accountPwRec,
    dummyPasswordRecord:DUMMY_PW_REC, normalizeUsername:normUsername,
  },
  pwa:{
    closeStreamsForSession:closePwaEventStreamsForSession,
    getPwaDevice, pwaDeviceResolvedAccount,
  },
  network:{ geoSync, geolocate },
  notification:{
    logAudit, addCenterNotification, enrichCenterNotificationGeo, pruneLeakTrackers,
  },
  activity:{ publicIp:pubIp, maskIp },
  share:{ linkPrefix },
  utils:{ timingSafeEqualStr, flagFromCode, isLoopback, isPrivateIp, parseIpList, ipInList },
});
bootstrapReferences.bindSecurity(securityAuthApplication);
const { sessionService, authService } = securityAuthApplication;
const { getSession, requireAuth } = sessionService;
const { attemptLogin } = authService;

// Per-link password verification and unlock cookies live in public-access-service.js.
// --- "request access" gate --------------------------------------
// A locked link shows a request form instead of the content. The visitor's
// browser gets a per-link cookie (dxreq_<token>) tying it to their pending
// request; once an admin approves that request, the same browser is let in
// automatically on its next visit — no e-mail round-trip required.
// ===================================================================
//  PUBLIC HTTP / WEB STORAGE / DOWNLOAD COMPOSITION
// ===================================================================
// Visitor renderers, public-link security, Web Storage read/write helpers,
// download streaming and the public share router share one explicit boundary.
// Writable reception/collaboration stays separate because upload state is
// intentionally composed later in the startup graph.
const publicHttpApplication = createPublicHttpApplication({
  applicationContext,
  config:serverConfig,
  requestContext,
  platform:platformDependencies.views.publicHttp,
  request:{ clientIp, parseCookies },
  state:{ getState, getSettings, persistNow, scheduleFlush },
  storage:{ storageConnectorService },
  services:{
    securityAuthApplication,
    shareMediaTransferApplication,
    sharePresentationService,
    activityPresenceService,
    networkServices,
    notificationService,
    notificationCenterService,
    hostPathService,
  },
  pwa:{ stampPhotoUploadDevice },
  bridges:{ onDownloadComplete, receptionThreadEnabled },
});
bootstrapReferences.bindPublicHttp(publicHttpApplication);
const {
  VISITOR_FEEDBACK_MAX,
  sendError,
  webStorageShareMeta, webStorageImportMeta, webStorageStat, webStorageList,
  webStorageWalkFiles, webStorageWritable, webStorageConnectorStatus,
  createWebStorageUploadHandler,
  validDownloadResumeId, pruneDownloadResumeSessions,
  clearRuntimeState:clearPublicHttpRuntimeState, unlockFails,
} = publicHttpApplication;

// ===================================================================
//  UPLOAD / BACKUP / MAINTENANCE RUNTIME SERVICES
// ===================================================================
// Late runtime services share one composition boundary. Upload keeps a lazy
// bridge to the maintenance-owned file-expiry map, while maintenance consumes
// upload and backup services only after their constructors have completed.
runtimeServicesApplication = createRuntimeServicesApplication({
  applicationContext,
  platform:platformDependencies.views.runtimeServices,
  fd:{ openFd, closeFd, readFd },
  config:serverConfig,
  constants:{ DAY_MS, LOG_FILE },
  state:{ getState, getSettings, persist, persistNow, scheduleFlush, encryptStore, decryptStore },
  request:{ clientIp },
  utils:{ formatBytes, isLoopback },
  pwa:{ emitInboxEvent },
  services:{
    securityAuthApplication, shareMediaTransferApplication, publicHttpApplication,
    notificationApplication, tlsManager, auditService, activityPresenceService,
    networkServices, hostPathService,
  },
});
bootstrapReferences.bindRuntime(runtimeServicesApplication);

// ===================================================================
//  APPLICATION PUBLICATION + RECEPTION/COLLABORATION ROUTES
// ===================================================================
// All route-facing domains become visible in one application-context transaction.
// The writable-link route contract is preflighted against an isolated context before
// the production registry is mutated or any reception/collaboration route is attached.
publishApplicationGraph({
  applicationContext,
  direct:{
    config:serverConfig,
    platform:platformDependencies.views.directDomains,
    services:{
      stateStore, settingsService, accountService, networkServices, sharePresentationService,
      activityPresenceService, auditService, restoreService, sessionService, authService, tlsManager,
    },
    runtimeConstants:Object.freeze({ DAY_MS, ACTIVITY_HISTORY_MAX, UNDO_LOG_MAX }),
    earlyAdapters:{
      withinRoot, assertRealWithin, containerToHost, hostToContainer, resolveWithin,
      clientIp, parseCookies, secureCookie, cleanConnectorPath, connectorErrorCode, connectorHttpStatus,
      createWebStorageUploadHandler, emitInboxEvent, sendError,
      webStorageConnectorStatus, webStorageList, webStorageStat, webStorageWalkFiles,
      webStorageImportMeta, webStorageWritable, storageConnectorService,
    },
  },
  applications:{
    runtimeServicesApplication, notificationApplication, shareMediaTransferApplication, publicHttpApplication,
  },
  reception:{ PENDING_DIR:configPaths.PENDING_DIR, live:liveState },
});

// Burn-after-read secrets, unlock, access-request and visitor feedback routes
// are registered by lib/server/public-share-routes.js.

// ===================================================================
//  FINAL ADMIN / HTTP / PWA / PROCESS LIFECYCLE COMPOSITION
// ===================================================================
// Root handlers, administrator composition, PWA publication, final Express route
// order and process lifecycle now share one boundary. server.js keeps only the
// genuinely live joints that earlier services need before the listener exists.
finalHttpApplication = createFinalHttpApplication({
  context:applicationContext,
  rootDir:__dirname,
  bootstrap:runtimeBootstrap,
  bootstrapReferences,
  pwaRegistry:pwaServices,
  requestContext,
  bus,
  applications:{ shareMediaTransferApplication, publicHttpApplication },
  live:{ getState, setState:replaceState, getWebpush:() => platformDependencies.webpush },
  runtime:{
    getServerScheme:currentServerScheme,
    shutdown,
    getServer:currentHttpServer,
    undoLogMax:UNDO_LOG_MAX,
  },
});
finalHttpApplication.lifecycleService.start();
