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
 *  7. Admin HTTP boundary + domain route modules
 *  8. PWA HTTP boundary + dedicated share-management route boundary
 *  9. Diagnostics and lifecycle-service composition
 *
 * Large cohesive services should live in ./lib/server rather than growing this file.
 * Account bootstrap/lookups live in ./lib/server/account-service.js,
 * auth/TOTP lives in ./lib/server/auth-service.js, and browser sessions/CSRF
 * live in ./lib/server/session-service.js. Those modules own their mutable state.
 * Admin authorization and the extracted account/security/storage/share route groups
 * live in ./lib/server/admin-*.js. Upload accounting/staging lives in
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
 * Tamper-evident security journaling lives in ./lib/server/audit-service.js.
 * Persisted settings, startup state loading/migrations, transactional restore and periodic
 * retention/anomaly housekeeping live in ./lib/server/settings-service.js,
 * ./lib/server/state-bootstrap-service.js, ./lib/server/restore-service.js and
 * ./lib/server/maintenance-service.js.
 * Storage connector inventory/probes/jobs, storage accounting, system-health snapshots and
 * bounded host diagnostics live in ./lib/server/storage-connector-job-service.js,
 * ./lib/server/system-health-service.js and ./lib/server/diagnostics-service.js.
 * Notification transport, durable center policy and PWA
 * push delivery live in ./lib/server/notification-service.js,
 * ./lib/server/notification-center-service.js and ./lib/server/pwa-notification-service.js.
 * PWA device/ownership, photo/album/retention, WebAuthn/passkeys and live PWA event
 * policy live in ./lib/server/pwa-device-service.js, ./lib/server/pwa-photo-service.js,
 * ./lib/server/webauthn-service.js and ./lib/server/pwa-event-service.js. PWA service
 * bootstrap, parser/template setup and route façade composition live in
 * ./lib/server/pwa-application.js; HTTP route declarations stay in ./lib/server/pwa-routes.js,
 * while the deferred service registry and route contract live in
 * ./lib/server/pwa-composition-service.js. Environment/path parsing,
 * rclone/Windows bootstrap and HTTP(S)/shutdown ownership live in ./lib/server/config.js,
 * ./lib/server/bootstrap.js and ./lib/server/lifecycle-service.js. Public URL resolution and
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
 * ./lib/server/http-application.js. Cross-domain route dependency profiles and
 * compatibility façades are composed centrally by ./lib/server/application-context.js.
 * server.js stays below GitHub's 1 MiB
 * source-rendering threshold so syntax highlighting and code navigation remain usable.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const tls = require('tls');
const {
  CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, cleanRelativePath:cleanConnectorPath,
  connectorErrorCode, connectorHttpStatus,
} = require('./lib/storage-connectors');
const {
  bool, compareSemver, isPrivateIp, ipToInt, intToIp, maskToPrefix,
  parseIpList, ipInList, isLoopback, flagFromCode, timingSafeEqualStr, esc, jsonForScript,
  formatBytes, encodePath, mapLimit,
} = require('./lib/core-utils');
const { MAX_PASSWORD_CHARS, hashPassword, parseHash, verifyPassword } = require('./lib/auth-utils');
const { previewInfo, imageContentType, photoExt, imageDimensions } = require('./lib/photo-utils');
const { SUBTITLE_MAX_BYTES, srtToVtt, subtitleTracksFor } = require('./lib/subtitle-utils');
const { readZipEntries, readFileCapped } = require('./lib/file-content-utils');
const { createTlsManager } = require('./lib/server/tls-manager');
const { createNetworkServices } = require('./lib/server/network-services');
const { createServerConfig } = require('./lib/server/config');
const { createRuntimeBootstrap } = require('./lib/server/bootstrap');
const { createLifecycleService } = require('./lib/server/lifecycle-service');
const { createApplicationContext } = require('./lib/server/application-context');
const { createHostPathService } = require('./lib/server/host-path-service');
const { createRequestUtils } = require('./lib/server/request-utils');
const { createSharePresentationService, normalizeLinkBase } = require('./lib/server/share-presentation-service');
const { createStateBootstrapService } = require('./lib/server/state-bootstrap-service');
const { createNotificationService } = require('./lib/server/notification-service');
const { createNotificationCenterService } = require('./lib/server/notification-center-service');
const { createPwaNotificationService } = require('./lib/server/pwa-notification-service');
const { createPwaServiceRegistry } = require('./lib/server/pwa-composition-service');
const { createPwaApplication } = require('./lib/server/pwa-application');
const { createPublicPages } = require('./lib/server/public-pages');
const { createBackupService } = require('./lib/server/backup-service');
const { createRestoreService } = require('./lib/server/restore-service');
const { createMaintenanceService } = require('./lib/server/maintenance-service');
const { createSettingsService } = require('./lib/server/settings-service');
const { createStorageConnectorJobService } = require('./lib/server/storage-connector-job-service');
const { createDiagnosticsService } = require('./lib/server/diagnostics-service');
const { createSystemHealthService } = require('./lib/server/system-health-service');
const { createUploadReceptionService } = require('./lib/server/upload-reception-service');
const { createTransferService } = require('./lib/server/transfer-service');
const { createDownloadService } = require('./lib/server/download-service');

const { createOcrService } = require('./lib/server/ocr-service');
const { createSearchService } = require('./lib/server/search-service');
const { createDlpService } = require('./lib/server/dlp-service');
const { createActivityPresenceService } = require('./lib/server/activity-presence-service');
const { createAuditService } = require('./lib/server/audit-service');
const { createPhotoService } = require('./lib/server/photo-service');
const { createShareService } = require('./lib/server/share-service');
const { attachReceptionCollaborationRoutes } = require('./lib/server/reception-collaboration-routes');
const { createPublicShareRoutes } = require('./lib/server/public-share-routes');
const { attachWindowsLauncherRoutes } = require('./lib/server/windows-launcher-routes');
const { createRootRoutes } = require('./lib/server/root-routes');
const { createHttpApplication } = require('./lib/server/http-application');
const { createStateStore } = require('./lib/server/state-store');
const { createAccountService } = require('./lib/server/account-service');
const { createSessionService } = require('./lib/server/session-service');
const { createAuthService } = require('./lib/server/auth-service');
const { createPublicAccessService } = require('./lib/server/public-access-service');
const { createPublicAbuseService } = require('./lib/server/public-abuse-service');
const { createAdminRouter } = require('./lib/server/admin-router');
const { attachAdminAccountRoutes } = require('./lib/server/admin-account-routes');
const { attachAdminSecurityRoutes } = require('./lib/server/admin-security-routes');
const { attachAdminStorageRoutes } = require('./lib/server/admin-storage-routes');
const { attachAdminShareCoreRoutes, attachAdminShareRoutes, normalizeTags } = require('./lib/server/admin-share-routes');
const { attachAdminPhotoRoutes } = require('./lib/server/admin-photo-routes');
const { attachAdminSettingsRoutes } = require('./lib/server/admin-settings-routes');
const { attachAdminDashboardRoutes } = require('./lib/server/admin-dashboard-routes');
const { attachAdminDiagnosticsRoutes } = require('./lib/server/admin-diagnostics-routes');
const pwaAdminHealth = require('./lib/pwa-admin-health-route');
const { GoogleOAuthProfileStore } = require('./lib/google-oauth-profile');
const { GoogleOAuthBrokerClient, cleanBrokerUrl } = require('./lib/google-oauth-broker-client');
const { createWebStorageShareTools } = require('./lib/web-storage-share');
const { createWebStorageWritableTools, createWebStorageUploadHandler, connectorStatus:webStorageConnectorStatus } = require('./lib/web-storage-writable');
const { openFd, closeFd, readFd } = require('./lib/fd-utils');
const { renderKind, highlightCode, renderMarkdown } = require('./lib/text-render');

const applicationContext = createApplicationContext();
// A small set of bootstrap bridges must stay hoisted because early-created
// services receive these callbacks before the owning domain service exists.
// Everything else is projected after construction through applicationContext.bind().
function persist(...args) { return stateStore.persist(...args); }
function persistNow(...args) { return stateStore.persistNow(...args); }
function scheduleFlush(...args) { return stateStore.scheduleFlush(...args); }
function getById(...args) { return shareService.getById(...args); }
function getByToken(...args) { return shareService.getByToken(...args); }
function isActive(...args) { return shareService.isActive(...args); }
function listShares(...args) { return shareService.listShares(...args); }
function normalizeShareColor(...args) { return shareService.normalizeShareColor(...args); }
function normalizeDescriptionMd(...args) { return shareService.normalizeDescriptionMd(...args); }
function shareFirstUseDeadline(...args) { return shareService.shareFirstUseDeadline(...args); }
function shareInactiveDeadline(...args) { return shareService.shareInactiveDeadline(...args); }
function shareEffectiveExpiry(...args) { return shareService.shareEffectiveExpiry(...args); }
function parseMaxVisitors(...args) { return shareService.parseMaxVisitors(...args); }
function centerPublicVisitorDeviceLabel(...args) { return shareService.centerPublicVisitorDeviceLabel(...args); }
function scheduleSearchReindex(...args) { return searchService.scheduleReindex(...args); }
function receptionThreadEnabled(...args) { return uploadReceptionService.receptionThreadEnabled(...args); }

// Notification, session and share services are composed before the concrete PWA
// domains. These deferred facades keep that startup order explicit without
// duplicating one forwarding function per PWA operation in this composition root.
const pwaServices = createPwaServiceRegistry();
const {
  cleanupPwaCapabilityScopes, cleanDeviceLabel, getPwaDevice, getPwaPublicDevice,
  photoUploadDeviceName, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount,
  pwaDeviceResolvedAccount, pwaDevices, requestClientDeviceName, stampPhotoUploadDevice,
} = pwaServices.device;
const {
  activityPrincipal, closePwaEventStreamsForSession, emitInboxEvent,
  emitPwaOwnerEvent, inboxReceivedFiles, ownerKeysForShare, shareOwnerAccount,
} = pwaServices.event;
const { canManagePwaImage } = pwaServices.photo;
// TLS certificate generation. node-forge maintains a stable local CA and signs
// short-lived LAN server certificates; RSA key generation itself uses Node/OpenSSL.
let forge = null;
try { forge = require('node-forge'); } catch (_) { forge = null; }
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const QRCode = require('qrcode');
// nodemailer is optional: e-mail notifications are off by default and the app
// must still boot if the module is somehow missing (degrades to webhook-only).
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }
// Web Push (browser notifications) — optional, like nodemailer. When the module is
// absent the feature stays disabled and everything else works unchanged.
let webpush = null;
try { webpush = require('web-push'); } catch (_) { webpush = null; }
const serverConfig = createServerConfig({ rootDir:__dirname });
const {
  APP_NAME, APP_VERSION, APP_YEAR, RELEASE_DATE,
  PORT, BIND, DX_WINDOWS_LAUNCHER_TOKEN,
  HOST_ROOT, DATA_DIR, PUBLIC_HOST, PUBLIC_URL, LOCAL_IP, TRUST_PROXY,
  SHUTDOWN_AFTER_DOWNLOAD, SESSION_TTL_MS, MAX_ZIP_BYTES, MAX_CONCURRENT_ZIPS,
  DATA_KEY, GOOGLE_OAUTH_BROKER_URL_ENV, INBOX_DIR, PENDING_DIR,
  MAX_UPLOAD_BYTES, MAX_CONCURRENT_UPLOADS,
  UPLOAD_IDLE_TIMEOUT_MS, ENC_DIR, SECRETS_DIR, IMAGE_STORE_DIR,
  FULL_IMAGES_DIR, THUMBS_DIR, MICROS_DIR, PHOTO_HISTORY_DIR,
  PHOTO_VERSIONS_DIR, ADAPTIVE_IMAGES_DIR, DLP_QUARANTINE_DIR,
  LEGACY_IMAGES_DIR, LEGACY_THUMBS_DIR, LEGACY_MICROS_DIR,
  LEGACY_PHOTO_HISTORY_DIR, PWA_IMG_EXT,
  PHOTO_HISTORY_MAX, IMAGE_MAX_BYTES,
  CLAMAV_HOST, CLAMAV_PORT, QUARANTINE_DIR, clamavEnabled, MAX_LOG_BYTES,
  ADMIN_ALLOW_ANY, ADMIN_ALLOWED_IPS, WEBHOOK_URL, WEBHOOK_FORMAT,
  SMTP_URL, EMAIL_FROM, EMAIL_TO, UPDATE_CHECK,
  PUBLIC_IP_DISCOVERY, UPDATE_REPO, UPDATE_TAG,
  TRANSFER_STALL_MS, SEARCH_INDEX_MAX_DOCS,
  WEB_STORAGE_STAT_CACHE_MS, WEB_STORAGE_STREAM_IDLE_MS, MAX_ACTIVE_CONNECTOR_JOBS,
  HISTORY_MAX, AUDIT_MAX, UNDO_DESCRIPTOR_MAX_BYTES, FAIL_WINDOW_MS,
  ACCESS_REQUESTS_MAX, MAX_STORAGE_CONNECTORS,
} = serverConfig;
// Request-local CSP/template values are runtime state, not process configuration.
const requestContext = new AsyncLocalStorage();
// Shared HTTP request helpers (trust-proxy-aware client IP, cookie parsing, Secure
// flag). Declared early because most services and the early-adapters domain inject
// these by reference; their bodies live in request-utils.js.
const { clientIp, parseCookies, secureCookie } = createRequestUtils({ TRUST_PROXY });
const runtimeBootstrap = createRuntimeBootstrap({ config:serverConfig });
const {
  storageConnectorService,
  connectorStartupCleanup,
  dataWritable,
} = runtimeBootstrap;
const STORAGE_SETUP = runtimeBootstrap.storageSetup;

const tlsManager = createTlsManager({
  fs, path, crypto, os, net, tls, forge, bool, isPrivateIp,
  BIND, DATA_DIR, PUBLIC_HOST, PUBLIC_URL, LOCAL_IP,
  getState: () => state,
});
const {
  configuredSelfSignedTls, tlsManagedByEnvironment, configuredHttpsEnabled,
  localCaModeActive, localCaFeatureRelevant, tlsDirPath, localCaPaths,
  readManagedTlsFile, certificateFingerprint256, tlsMaterialFingerprint,
  validateLocalCaCertificate, readLocalCaCertificateOnly, ensureLocalCa,
  validateLeafCertificate, localCaStatus, localCaStatusForClient,
  invalidateLocalCaStatusUiCache, validateProvidedTlsPair, loadTlsOptions,
  refreshProvidedTlsServerContext, refreshLocalTlsServerContext,
} = tlsManager;
const { TLS_CERT, TLS_KEY, TLS_DAY_MS } = tlsManager.config;
const googleOAuthProfileStore = new GoogleOAuthProfileStore({ dataDir:DATA_DIR, dataKey:DATA_KEY });
const googleOAuthBrokerClient = new GoogleOAuthBrokerClient({ baseUrl:GOOGLE_OAUTH_BROKER_URL_ENV, version:APP_VERSION });
let lifecycleService = null;
function shutdown(signal, exitCode = 0) {
  if (!lifecycleService) return Promise.reject(new Error('server lifecycle is not started'));
  return lifecycleService.shutdown(signal, exitCode);
}
function currentServerScheme() {
  return lifecycleService ? lifecycleService.getServerScheme() : 'http';
}
function currentHttpServer() {
  return lifecycleService ? lifecycleService.getServer() : null;
}

// Settings owns its defaults, validation, state mutations and client projection.
// Every late-created collaborator is reached lazily so service construction stays
// safe during bootstrap and all reads follow the state replaced by a restore.
const settingsService = createSettingsService({
  APP_NAME,
  shutdownAfterDownload: SHUTDOWN_AFTER_DOWNLOAD,
  googleOAuthBrokerUrlEnv: GOOGLE_OAUTH_BROKER_URL_ENV,
  webhookUrl: WEBHOOK_URL,
  dataKey: DATA_KEY,
  smtpUrl: SMTP_URL,
  adminAllowedIps: ADMIN_ALLOWED_IPS,
  updateCheck: UPDATE_CHECK,
  publicIpDiscovery: PUBLIC_IP_DISCOVERY,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  tlsCert: TLS_CERT,
  tlsKey: TLS_KEY,
  tlsDayMs: TLS_DAY_MS,
  nodemailer,
  webpush,
  tlsManager,
  getState: () => state,
  persist: () => persist(),
  persistNow: () => persistNow(),
  onSettingsChanged: () => {
    invalidateLocalCaStatusUiCache();
    resetMailerCache();
  },
  getServerScheme: currentServerScheme,
  emailSendable: () => emailSendable(),
  pushSubs: () => pushSubs(),
  tlsManagedByEnvironment,
  configuredSelfSignedTls,
  configuredHttpsEnabled,
  localCaStatusForClient,
  normalizeLinkBase,
  cleanBrokerUrl,
  parseHotlinkHosts: (...args) => parseHotlinkHosts(...args),
  normalizeShareColor,
  normalizeTags,
  normalizeDescriptionMd,
  normExtList: (...args) => normExtList(...args),
  ipToInt,
});
const {
  DEFAULT_SETTINGS, getSettings, setSettings, setSettingsDurable,
  updateCheckEnabled, publicIpDiscoveryEnabled,
} = settingsService;

runtimeBootstrap.ensureBaseDirectories();
// Account bootstrap, legacy migration, ADMIN_PASSWORD handling and live-state
// lookups are owned by account-service. auth-service remains responsible for
// credential verification, lockouts and TOTP challenges.
const accountService = createAccountService({
  fs,
  path,
  crypto,
  dataDir:DATA_DIR,
  getState:() => state,
  getSettings,
  persistNow,
});
const {
  adminUsername:ADMIN_USERNAME,
  dummyPasswordRecord:DUMMY_PW_REC,
  initialize:initAccounts,
  normalizeUsername:normUsername,
  accountList,
  findAccountByName,
  getAccountById,
  ownerAccount,
  accountPasswordRecord:accountPwRec,
  accountNeedsPasswordChange:accountNeedsPwChange,
} = accountService;
// Host/container translation and real-path containment are centralized so every
// domain receives one consistent path-security policy.
const hostPathService = createHostPathService({ fs, path, hostRoot:HOST_ROOT });
const { withinRoot, resolveWithin, assertRealWithin, containerToHost, hostToContainer } = hostPathService;
const networkServices = createNetworkServices({
  net, os, LOCAL_IP, APP_VERSION, UPDATE_REPO, UPDATE_TAG,
  compareSemver, updateCheckEnabled, publicIpDiscoveryEnabled,
  addAdminCenterNotification: (...args) => addAdminCenterNotification(...args),
  getState: () => state, persist, maskToPrefix, ipToInt, intToIp, isPrivateIp,
  getSettings, flagFromCode,
  noteCenterServiceState: (...args) => noteCenterServiceState(...args),
});
const {
  updateState, geoCache, GEO_TTL, geoSync,
  getLocalIPv4s, checkForUpdate, getPublicIP, getPublicIPCached,
  isLocalNetwork, geolocate,
} = networkServices;
const sharePresentationService = createSharePresentationService({
  config: { PUBLIC_URL, PUBLIC_HOST, PORT, TRUST_PROXY },
  getSettings: () => getSettings(),
  getState: () => state,
  getPublicIPCached: () => getPublicIPCached(),
  getLocalIPv4s: () => getLocalIPv4s(),
  getShareService: () => shareService,
  getPhotoService: () => photoService,
  getPwaDeviceService: () => pwaDeviceService,
  pubIp: (...args) => pubIp(...args),
});
const { primaryBase, decorateShare } = sharePresentationService;
// ===================================================================
//  ACTIVE TRANSFERS: transfers in progress (IP + country)
// ===================================================================
// User-facing activity/history, IP privacy and long-lived activity/presence SSE
// streams live behind one cohesive service. All domain dependencies are lazy so
// this composition can precede share/transfer/session service initialization.
const activityPresenceService = createActivityPresenceService({
  crypto,
  getState: () => state,
  getSettings,
  scheduleFlush,
  getShareById: (id) => getById(id),
  getTrashItems: () => trashItems(),
  getPwaDevices: () => pwaDevices(),
  isSessionActive: (sid, roles) => sessionService.isSessionActive(sid, roles),
  getActiveTransfers: () => activeTransfers,
});
const {
  maskIp, pubIp, ipNameFor,
  getHistoryViewRevision, setHistoryViewRevision, bumpHistoryViewRevision,
  isActivityIgnored, sanitizeActivityLog, syncLiveActivityCache, buildLegacyActivityLog,
  emitLiveActivity, schedulePresenceBroadcast, closeActivityPresenceStreams,
  liveActivityClients, presenceClients,
} = activityPresenceService;
const { ACTIVITY_HISTORY_MAX } = activityPresenceService.constants;

// ===================================================================
//  SECURITY AUDIT SERVICE
// ===================================================================
// HMAC chaining, signed-head verification, Ed25519 proof bundles, durable writes
// and audit-key migration are isolated from the HTTP composition root.
const auditService = createAuditService({
  fs, path, crypto, DATA_DIR, DATA_KEY, APP_NAME, APP_VERSION, AUDIT_MAX,
  timingSafeEqualStr, getState: () => state, persistNow, scheduleFlush,
  emitLiveActivity, pubIp, scheduleSearchReindex, getAccountById, clientIp,
  isActivityIgnored,
  env: process.env,
});
const {
  initAuditChain, verifyAuditChain, ensureAuditChainKey, auditKeyId,
  ensureAuditProofKeys, parseAuditChainText, parseAuditChainFile,
  validateAuditRestoreEntries, verifyAuditSnapshot,
  replaceChainForRestore, logAudit, auditReq,
} = auditService;
const {
  chainFile: AUDIT_CHAIN_FILE,
  keyFile: AUDIT_KEY_FILE,
  headFile: AUDIT_HEAD_FILE,
} = auditService.paths;
const UNDO_LOG_MAX = 25; // most recent undoable admin actions kept (state.undoLog, shares.json)
// Public-link IP/country policy is owned by public-access-service.js.
// ===================================================================
//  NOTIFICATIONS
// ===================================================================
// Webhook, SMTP, Web Push, leak alerts, expiry reminders and digests live in a
// dedicated service. Keeping this wiring here makes the server entrypoint show
// which application services exist without burying their implementation details.
let notificationCenterService = null;
const notificationService = createNotificationService({
  APP_NAME, WEBHOOK_URL, WEBHOOK_FORMAT, SMTP_URL, EMAIL_FROM, EMAIL_TO,
  nodemailer, webpush, getSettings, formatBytes, persist, persistNow,
  getById, getByToken,
  notificationAccountIdForShare: (...args) => notificationCenterService ? notificationCenterService.notificationAccountIdForShare(...args) : null,
  notificationAdminAccountIds: (...args) => notificationCenterService ? notificationCenterService.notificationAdminAccountIds(...args) : [],
  pushSubscriptionsForAccountIds: (...args) => notificationCenterService ? notificationCenterService.pushSubscriptionsForAccountIds(...args) : [],
  noteCenterServiceState: (...args) => notificationCenterService ? notificationCenterService.noteCenterServiceState(...args) : undefined,
  noteExpiredPushSub: (...args) => notificationCenterService ? notificationCenterService.noteExpiredPushSub(...args) : undefined,
  shareFirstUseDeadline, shareInactiveDeadline, isActive, listShares,
  addShareCenterNotification: (...args) => notificationCenterService ? notificationCenterService.addShareCenterNotification(...args) : null,
  logAudit, readLogTail: (...args) => transferService.readLogTail(...args), getState: () => state,
});
const {
  effectiveWebhook, sendWebhook, notify, pruneLeakTrackers, noteLeakSignal,
  emailConfigured, resetMailerCache, emailSendable, sendMail, dispatch,
  pushSubs, sendWebPush, sendWebPushAwaited, checkExpiringShares, maybeSendDigest,
  maybeNotifyDownloadThreshold, maybeSecurityAlert, getLastWebhook, getLastEmail,
  clearRuntimeState:clearNotificationRuntimeState,
} = notificationService;
auditService.setSecurityAlertHandler(maybeSecurityAlert);

notificationCenterService = createNotificationCenterService({
  APP_VERSION, DATA_DIR, PUBLIC_URL, TRUST_PROXY, STORAGE_SETUP,
  getState: () => state, getSettings, scheduleFlush, persist, persistNow,
  accountList, getAccountById, shareOwnerAccount,
  getPwaDevice, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount, pwaDeviceResolvedAccount, pwaDevices,
  getById, getByToken, listShares, isActive, shareEffectiveExpiry, decorateShare,
  formatBytes, flagFromCode, pubIp, parseMaxVisitors, centerPublicVisitorDeviceLabel,
  pendingUsageForShare: (...args) => pendingUsageForShare(...args),
  photoStatsOf: (...args) => photoStatsOf(...args),
  dataWritable, emitLiveActivity, checkExpiringShares, pushSubs,
  getActiveTransfers: () => { try { return activeTransfers; } catch (_) { return new Map(); } },
  getSearchIndexError: () => { try { return searchIndexError; } catch (_) { return null; } },
  getAuditKeyMigrationStatus: () => auditService.getKeyMigrationStatus(),
  webPushAvailable: () => !!webpush,
  getDlpOcrUnavailableNotedAt: () => { try { return dlpService.getOcrUnavailableNotedAt(); } catch (_) { return 0; } },
});
const {
  NOTIFICATION_MUTABLE_CATEGORIES, CUSTOM_NOTIFICATION_RULE_METRICS,
  notificationAccountIdForShare, notificationAdminAccountIds, enrichCenterNotificationGeo,
  accountCustomNotificationRules, pruneCustomNotificationRuleStateForShareId,
  addCenterNotification, addShareCenterNotification, evaluateCustomNotificationRulesForShare,
  addAdminCenterNotification, addRequestCenterNotification, addFirstViewCenterNotification,
  enrichFirstViewCenterNotification, pruneCenterTrackers, centerShareEligibleForVisitorNotification,
  noteCenterCountry, maybeCenterViewThreshold, maybeCenterDownloadMilestone, noteCenterActivity,
  noteCenterRepeatedDownload, maybeCenterReceptionQuota, noteCenterAutoDisabled, noteCenterVisitorDevice,
  noteCenterConcurrentDownloadStart, noteCenterHighVolume, noteCenterViral, noteCenterSharedFileSignature,
  noteCenterCleanup, noteCenterServiceState,
  checkCenterLinkStates, diskFreeThresholds, checkCenterSystemHealth, noteCenterLifecycleStart,
  noteCenterCleanShutdown, noteCenterInstalledVersion, clearRuntimeState:clearNotificationCenterRuntimeState,
} = notificationCenterService;

const pwaNotificationService = pwaServices.bind('notification', createPwaNotificationService({
  APP_NAME, getState: () => state, getPwaDevice, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount, pwaDevices,
  pushSubs, ownerKeysForShare, sendWebPush, sendWebPushAwaited, webPushAvailable: () => !!webpush,
  effectiveWebhook, sendWebhook, emailConfigured, sendMail, addFirstViewCenterNotification,
  emitPwaOwnerEvent, persist, scheduleFlush, logAudit, clientIp,
}));
const {
  notifyFirstPhotoView, clearRuntimeState:clearPwaNotificationRuntimeState,
} = pwaNotificationService;

const DAY_MS = 86400000;

// Transfer history/IP privacy projection is owned by activity-presence-service.js.

// ===================================================================
//  STORE: shares + settings (persisted in shares.json)
// ===================================================================

// Persistent, exportable transfer journal (append-only JSONL).
const LOG_FILE = path.join(DATA_DIR, 'transfers.log');

// Audit journal paths and mutable cryptographic state are owned by auditService.

// state.stats: per-share aggregate totals (kept even after a share is revoked),
// keyed by share id -> { name, type, count, bytes, up, down, completed,
// interrupted, lastAt }. Cheap to keep and always available for per-link stats,
// while the full journal lives in transfers.log.
let state = { version: 1, shares: [], trash: [], settings: { ...DEFAULT_SETTINGS }, history: [], photoHistory: [], stats: {}, meta: {}, audit: [], ipNames: {}, undoLog: [], activityLog: [] };

const stateStore = createStateStore({
  fs, crypto, dataDir: DATA_DIR, dataKey: DATA_KEY, getState: () => state,
});
const STORE_FILE = stateStore.storeFile;

// Activity history and live download presence are owned by activity-presence-service.js.

const shareService = createShareService({
  HOST_ROOT, INBOX_DIR, PENDING_DIR, ENC_DIR, UNDO_LOG_MAX, UNDO_DESCRIPTOR_MAX_BYTES,
  getState: () => state, getSettings, persist, persistNow, scheduleFlush,
  hostToContainer, containerToHost, assertRealWithin, resolveWithin,
  folderMetrics: (...args) => folderMetrics(...args),
  resolveHostItem: (...args) => resolveHostItem(...args),
  photoStatsOf: (...args) => photoService.photoStatsOf(...args),
  firstExistingPhotoFile: (...args) => photoService.firstExistingPhotoFile(...args),
  photoOriginalPaths: (...args) => photoService.photoOriginalPaths(...args),
  photoVariantPaths: (...args) => photoService.photoVariantPaths(...args),
  photoAdaptivePath: (...args) => photoService.photoAdaptivePath(...args),
  photoVersionDir: (...args) => photoService.photoVersionDir(...args),
  uniquePhotoPaths: (...args) => photoService.uniquePhotoPaths(...args),
  webStorageShareMeta: (...args) => webStorageShareMeta(...args),
  webStorageStat: (...args) => webStorageStat(...args),
  accountList, accountCustomNotificationRules, pruneCustomNotificationRuleStateForShareId,
  scheduleSearchReindex: (...args) => scheduleSearchReindex(...args), emitLiveActivity,
  activityPrincipal: (...args) => activityPrincipal(...args), getAccountById, findAccountByName,
  pwaDeviceResolvedAccount: (...args) => pwaDeviceResolvedAccount(...args),
  canManagePwaImage: (...args) => canManagePwaImage(...args), currentAccount,
  setSettingsDurable,
  pruneHistory: (...args) => pruneHistory(...args),
  bumpHistoryViewRevision,
  addShareCenterNotification, maybeNotifyDownloadThreshold, maybeCenterDownloadMilestone,
  maybeCenterReceptionQuota, evaluateCustomNotificationRulesForShare, noteCenterAutoDisabled,
  logAudit, addAdminCenterNotification, clientIp, maskIp, geoSync, geolocate,
  centerShareEligibleForVisitorNotification, noteCenterCountry, maybeCenterViewThreshold,
  noteCenterVisitorDevice, noteCenterViral, noteCenterActivity,
  shareOwnerAccount: (...args) => shareOwnerAccount(...args),
  getSession: (...args) => getSession(...args),
  getPwaPublicDevice: (...args) => getPwaPublicDevice(...args),
  pwaDeviceCreatorAccount: (...args) => pwaDeviceCreatorAccount(...args),
  pwaDeviceOwnerAccount: (...args) => pwaDeviceOwnerAccount(...args),
  requestClientDeviceName: (...args) => requestClientDeviceName(...args),
  cleanDeviceLabel: (...args) => cleanDeviceLabel(...args), pubIp, flagFromCode,
  validDownloadResumeId: (...args) => validDownloadResumeId(...args),
  pruneDownloadResumeSessions: (...args) => pruneDownloadResumeSessions(...args),
});
const { recipientByToken } = shareService;
const {
  SHARE_CHANGE_HISTORY_MAX,
  SHARE_LOGICAL_BYTES_CACHE_MS,
  SHARE_BACKING_HEALTH_CACHE_MS,
  VISITORS_MAX,
} = shareService.constants;
const { clampIndex, zipAllowed } = shareService;

// Stable bound share/state facades keep service ownership explicit without one
// forwarding wrapper per operation in the composition root.
const {
  reindex, isScheduled, linkPrefix, addShare, restorePlainObject,
  shareBackingHealthSnapshot, queueShareBackingHealthRefresh, migrateLegacyFirstUseExpiryState,
  trashItems, detachActiveShare, sanitizeUndoLog, destroyShareManagedData, purgeTrashRecordById,
  incrementDownloads, shareItems, recordAndCheckVisitor, ipDownloadQuotaBlocked,
  commitManagedIpDownload, noteBytesServed, bandwidthCapReached, bumpViews,
  recordRecipientView, runExpiredLinkLifecycle,
} = applicationContext.bind(shareService, [
  'reindex', 'isScheduled', 'linkPrefix', 'addShare', 'restorePlainObject',
  'shareBackingHealthSnapshot', 'queueShareBackingHealthRefresh', 'migrateLegacyFirstUseExpiryState',
  'trashItems', 'detachActiveShare', 'sanitizeUndoLog', 'destroyShareManagedData', 'purgeTrashRecordById',
  'incrementDownloads', 'shareItems', 'recordAndCheckVisitor', 'ipDownloadQuotaBlocked',
  'commitManagedIpDownload', 'noteBytesServed', 'bandwidthCapReached', 'bumpViews',
  'recordRecipientView', 'runExpiredLinkLifecycle',
]);

const {
  encryptStore, decryptStore, deserializeStore, flushNow,
} = applicationContext.bind(stateStore, [
  'encryptStore', 'decryptStore', 'deserializeStore', 'flushNow',
]);

// Photos/Images service owns managed storage, variants, history, statistics,
// duplicate detection, cache revisions and version snapshots/restores. Route
// handlers stay in this composition root and consume these stable contracts.
const photoService = createPhotoService({
  HOST_ROOT, IMAGE_STORE_DIR, FULL_IMAGES_DIR, THUMBS_DIR, MICROS_DIR,
  PHOTO_HISTORY_DIR, PHOTO_VERSIONS_DIR, ADAPTIVE_IMAGES_DIR,
  LEGACY_IMAGES_DIR, LEGACY_THUMBS_DIR, LEGACY_MICROS_DIR, LEGACY_PHOTO_HISTORY_DIR,
  PHOTO_HISTORY_MAX, DAY_MS,
  getState: () => state,
  listShares: () => listShares(),
  trashItems: () => trashItems(),
  hostToContainer, assertRealWithin,
  getSession: (...args) => getSession(...args),
  clientIp, maskIp, geoSync, geolocate, noteCenterCountry,
  enrichFirstViewCenterNotification, maybeCenterViewThreshold,
  evaluateCustomNotificationRulesForShare, noteCenterActivity, notifyFirstPhotoView,
  pubIp, flagFromCode, scheduleFlush, persist, persistNow, restorePlainObject,
  addShareCenterNotification,
  ownsShare: (...args) => ownsShare(...args),
  canManagePwaImage: (...args) => canManagePwaImage(...args),
  decorateShare: (...args) => decorateShare(...args),
  getSettings, primaryBase: (...args) => primaryBase(...args), isActive, shareEffectiveExpiry,
});
const {
  normalizePhotoHistory, photoOriginalPaths, photoAdaptivePath, photoVariantPaths,
  firstExistingPhotoFile, migrateLegacyPhotoStorage, photoStatsOf, notePhotoView, hashFileSha256,
  streamToFileBounded, photoCacheRevision,
} = photoService;

// Search/OCR/DLP services own the previously monolithic indexing, native OCR and
// quarantine policy state. Keep tiny mirrors for legacy route live-bindings; the
// service callback updates them atomically whenever index state changes.
const SEARCH_INDEX_FILE = path.join(DATA_DIR, 'search-index.json');
const SEARCH_OCR_CACHE_FILE = path.join(DATA_DIR, 'search-ocr-cache.json');
let searchIndexBuilding = false;
let searchIndexError = null;
let universalSearchIndex = { version: 3, builtAt: 0, docs: [] };

const ocrService = createOcrService({
  DATA_DIR, DATA_KEY, encryptStore, deserializeStore,
  emitLiveActivity, addAdminCenterNotification,
  indexContentCap: 2 * 1024 * 1024,
  indexDocMax: SEARCH_INDEX_MAX_DOCS,
});
const SEARCH_OCR_ENABLED = !!ocrService.getConfig().enabled;
const SEARCH_OCR_LANGS = ocrService.getConfig().langs;

const searchService = createSearchService({
  DATA_DIR, DATA_KEY, HOST_ROOT, INBOX_DIR, encryptStore, deserializeStore,
  getState: () => state, getById, listShares, shareItems, hostToContainer,
  assertRealWithin, resolveWithin, firstExistingPhotoFile, photoOriginalPaths,
  ownsShare: (...args) => ownsShare(...args), accountList, trashItems, normUsername, linkPrefix,
  noteCenterServiceState, addAdminCenterNotification, emitLiveActivity, ocrService,
  onStateChange(snapshot) {
    searchIndexBuilding = !!snapshot.building;
    searchIndexError = snapshot.error || null;
    universalSearchIndex = snapshot.index || { version:3, builtAt:0, docs:[] };
  },
});
const dlpService = createDlpService({
  HOST_ROOT, FULL_IMAGES_DIR, DLP_QUARANTINE_DIR,
  getState: () => state, getSettings, hostToContainer, assertRealWithin, persistNow,
  clientIp, maskIp, auditReq, logAudit, addAdminCenterNotification,
  addRequestCenterNotification, noteCenterServiceState, searchService, ocrService,
});

// Compatibility names are projected once from search/OCR instead of forwarding wrappers.
// Single source of truth for the searchService -> legacy-name mapping, reused below
// when the same projection is registered as the 'search-compat' route domain. The
// scheduleSearchReindex bridge is declared as a hoisted function above, so it stays
// out of this local destructuring and is added only to the registered domain.
const SEARCH_COMPAT_MAP = {
  buildUniversalSearchIndex:'buildIndex',
  universalSearchStatus:'status', universalSearchScopedStatus:'scopedStatus',
  universalSearchVisibleDocs:'visibleDocs', universalSearchShareEligible:'universalSearchShareEligible',
  universalSearchQuery:'query', universalSemanticSearchQuery:'semanticQuery',
  globalMetadataSearch:'metadataSearch', looksLikeTextBuffer:'looksLikeTextBuffer',
  initUniversalSearchIndex:'init',
};
const {
  universalSearchStatus, initUniversalSearchIndex,
} = applicationContext.bind(searchService, SEARCH_COMPAT_MAP);
const { detectSearchOcrTools } = applicationContext.bind(ocrService, { detectSearchOcrTools:'detectTools' });

const {
  sanitizeDlpQuarantineState, reconcileDlpQuarantineFiles, cleanupDlpQuarantineOrphans,
} = dlpService;

// Transfer accounting owns live transfers, byte totals, durable history and
// one-time-download claims. Dependencies remain explicit so restored root state
// is always observed through getState()/getById().
const transferService = createTransferService({
  crypto, fs, LOG_FILE, MAX_LOG_BYTES, HISTORY_MAX, TRANSFER_STALL_MS,
  getState: () => state, getSettings, getById, clientIp, geoSync, geolocate,
  getRecipientByToken: (token) => recipientByToken.get(token),
  dataWritable, emitLiveActivity, pubIp, ipNameFor, schedulePresenceBroadcast, scheduleFlush, persist, logAudit,
  addShareCenterNotification, noteCenterCountry, noteCenterActivity, noteCenterRepeatedDownload,
  noteCenterHighVolume, noteCenterViral, maybeCenterReceptionQuota, noteCenterAutoDisabled,
  notify, noteLeakSignal,
});
const {
  activeTransfers, claimOneTimeDownload, releaseOneTimeDownload, startTransfer, endTransfer,
  pruneHistory, trimLogIfNeeded, clearRuntimeState:clearTransferRuntimeState,
} = transferService;

// Persistent state loading and startup migrations are coordinated after restore-service composition.

// Share lifecycle/statistics/trash operations are bound once through the application context above.

// Destructive direct-delete helper removed in 1.45.2. All share removals must
// flow through recoverable trash or destroyShareManagedData(), which waits for
// filesystem deletion before erasing the logical record.

// Files backing a share are normalized by the share domain service.

// Transactional restore owns validation/staging/rollback while this composition
// root supplies live state replacement and cross-service runtime reset callbacks.
// Late-created services are reached through lazy closures so interrupted TLS
// recovery can run immediately after the persistent store is loaded.
const restoreService = createRestoreService({
  fs, path, crypto, forge,
  DATA_DIR, SECRETS_DIR, LOG_FILE, AUDIT_CHAIN_FILE, AUDIT_HEAD_FILE,
  DEFAULT_SETTINGS, HISTORY_MAX, AUDIT_MAX,
  getState: () => state,
  replaceState: (nextState) => { state = nextState; },
  getHistoryViewRevision,
  setHistoryViewRevision,
  parseAuditChainText, validateAuditRestoreEntries, ensureAuditChainKey,
  auditKeyId, timingSafeEqualStr, verifyAuditSnapshot, verifyAuditChain,
  parseAuditChainFile, replaceChainForRestore,
  isBackupInFlight: () => isBackupInFlight(),
  getActiveTransferCount: () => activeTransfers.size,
  hasActiveUploads: () => hasActiveUploads(),
  isShareStateReplacementBusy: () => shareService.isBusyForStateReplacement(),
  isMaintenanceStateReplacementBusy: () => maintenanceService.isStateReplacementBusy(),
  isConnectorJobStateReplacementBusy: () => storageConnectorJobService.isBusyForStateReplacement(),
  clearAllSessions: () => sessionService.clearAllSessions(),
  clearTransferRuntimeState: () => clearTransferRuntimeState(),
  clearDownloadRuntimeState: () => clearDownloadRuntimeState(),
  clearUploadRuntimeAfterRestore: () => clearUploadRuntimeAfterRestore(),
  clearPwaPairTickets: () => pwaPairTickets.clear(),
  clearWebauthnRuntimeState: () => webauthnService.clearRuntimeState(),
  clearNotificationRuntimeState: () => clearNotificationRuntimeState(),
  clearPwaEventRuntimeState: () => pwaEventService && pwaEventService.clearRuntimeState(),
  closeActivityPresenceStreams,
  clearNotificationCenterRuntimeState: () => clearNotificationCenterRuntimeState(),
  clearPwaNotificationRuntimeState: () => clearPwaNotificationRuntimeState(),
  clearMaintenanceRuntimeState: () => maintenanceService.clearRuntimeAfterRestore(),
  clearConnectorJobRuntimeState: () => storageConnectorJobService.clearRuntimeAfterRestore(),
  clearSystemHealthRuntimeState: () => systemHealthService.clearRuntimeState(),
  clearAccountBootstrapRuntime: () => accountService.clearInitialPassword(),
  resetSearchAfterRestore: (delay) => searchService.resetAfterRestore(delay),
  tlsDirPath, validateLocalCaCertificate, validateLeafCertificate,
  markTlsRestartRequired: () => { tlsManager.tlsCertificateRestartRequired = true; },
  normalizePhotoHistory, sanitizeUndoLog, sanitizeActivityLog,
  sanitizeDlpQuarantineState, reconcileDlpQuarantineFiles,
  syncLiveActivityCache, buildLegacyActivityLog,
  migrateLegacyFirstUseExpiryState,
  prepareAccountState: (candidate) => accountService.prepareRestoredState(candidate),
  clearShareRuntimeState: () => shareService.clearRuntimeState(),
  persistNow, cleanupDlpQuarantineOrphans, migrateLegacyPhotoStorage,
});

const stateBootstrapService = createStateBootstrapService({
  fs, stateStore, getState:() => state, replaceState:(nextState) => { state = nextState; },
  DEFAULT_SETTINGS, HISTORY_MAX, AUDIT_MAX,
  normalizePhotoHistory, sanitizeUndoLog, sanitizeActivityLog, buildLegacyActivityLog, syncLiveActivityCache,
  migrateLegacyFirstUseExpiryState, sanitizeDlpQuarantineState, reconcileDlpQuarantineFiles,
  cleanupDlpQuarantineOrphans, reindex, persistNow,
  recoverInterruptedCoreRestore:() => restoreService.recoverInterruptedCoreRestore(),
  recoverInterruptedSecretRestore:() => restoreService.recoverInterruptedSecretRestore(),
  recoverInterruptedTlsRestore:() => restoreService.recoverInterruptedTlsRestore(),
  initAuditChain, ensureAuditProofKeys, initAccounts, trimLogIfNeeded, pruneHistory,
  migrateLegacyPhotoStorage, env:process.env, exit:(code) => process.exit(code),
  defer:setImmediate, logger:console,
});
stateBootstrapService.initialize();

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

// Administrator session/CSRF boundary. The service owns the session store; the
// composition root only exposes the operations needed by routes and SSE guards.
const sessionService = createSessionService({
  getSettings,
  defaultTtlMs: SESSION_TTL_MS,
  getAccountById,
  clientIp,
  parseCookies,
  secureCookie,
  timingSafeEqualStr,
  closeStreamsForSession: closePwaEventStreamsForSession,
});
const { createSession, getSession, requireAuth, clearSessionsOfAccount } = sessionService;

// Credential/brute-force/TOTP boundary. Persistence, auditing and notifications
// are injected so the auth module never reaches into the global application state.
const authService = createAuthService({
  getSettings,
  findAccountByName,
  getAccountById,
  accountPasswordRecord: accountPwRec,
  dummyPasswordRecord: DUMMY_PW_REC,
  normalizeUsername: normUsername,
  clientIp,
  createSession,
  scheduleFlush,
  persistNow,
  logAudit,
  getPwaDevice,
  pwaDeviceResolvedAccount,
  geoSync,
  geolocate,
  addCenterNotification,
  enrichCenterNotificationGeo,
  publicIp: pubIp,
  flagFromCode,
  failWindowMs: FAIL_WINDOW_MS,
});
const { attemptLogin, setAccountPassword } = authService;

// Per-link password verification and unlock cookies live in public-access-service.js.
// --- "request access" gate --------------------------------------
// A locked link shows a request form instead of the content. The visitor's
// browser gets a per-link cookie (dxreq_<token>) tying it to their pending
// request; once an admin approves that request, the same browser is let in
// automatically on its next visit — no e-mail round-trip required.
const VISITOR_FEEDBACK_MAX = 200; // per-link cap for moderated visitor feedback
// Two-way reception-thread business rules are owned by upload-reception-service.js.
// Request-approval cookies live in public-access-service.js.

// Public-link rate limiting, message deduplication and proof-of-work live in
// public-abuse-service.js.

// Security audit implementation lives in ./lib/server/audit-service.js.

// Expired-link lifecycle is owned by share-service and projected through the
// bound share facade above. maintenance-service only schedules the operation.

// ===================================================================
//  RENDERING of public pages (systematic HTML escaping)
// ===================================================================

const publicPages = createPublicPages({
  APP_NAME, APP_VERSION, APP_YEAR,
  requestContext, recipientByToken,
  pubIp, linkPrefix, shareEffectiveExpiry, getSettings, clientIp, parseCookies,
  receptionThreadEnabled, parseMaxVisitors, zipAllowed,
  esc, jsonForScript, formatBytes, encodePath,
  previewInfo, subtitleTracksFor, renderKind, renderMarkdown,
});
const {
  PUB, pickLang, previewWatermark, pageShell, collectionPage, filePage,
  encDecryptPage, secretPage, folderPage, webStorageFolderPage, errorPage, albumPage,
  mediaPlayerPage, passwordPage, accessRequestPage, challengePage,
} = publicPages;

const publicAccessService = createPublicAccessService({
  crypto, clientIp, geoSync, geolocate, hashPassword, parseHash, verifyPassword,
  parseCookies, secureCookie, timingSafeEqualStr, linkPrefix, isLoopback, isPrivateIp,
  parseIpList, ipInList, errorPage, pickLang, maxPasswordChars:MAX_PASSWORD_CHARS,
  failWindowMs:FAIL_WINDOW_MS, unlockMaxFails:8,
});
const {
  hasAccessRules, linkAccessReason, checkSharePassword, upgradeLegacySharePassword, sendPasswordWorkHtml,
  isUnlocked, setUnlockCookie, pendingAccessRequest, isAccessApproved,
  setAccessRequestCookie, beginUnlockAttempt, noteUnlockFailure, noteUnlockSuccess,
  finishUnlockAttempt, unlockFails,
} = publicAccessService;

const publicAbuseService = createPublicAbuseService({
  crypto, clientIp, getSettings, maskIp, parseCookies, secureCookie, timingSafeEqualStr,
  challengePage, pickLang, pruneLeakTrackers,
});
const {
  snapshotPublicMessageDecision, restorePublicMessageDecision, publicMessageDecision,
  publicRateRetryAfter, challengeRequired, createPowChallenge, verifyPowChallenge,
  hasValidPow, issuePowCookie, challengeGateZip,
} = publicAbuseService;
const PUBLIC_MESSAGE_DUP_MS = publicAbuseService.publicMessageDupMs;
// Public visitor routes live in lib/server/public-share-routes.js.
// These small cross-service adapters stay in the composition root because they are
// also consumed by notification/download/reception/PWA services.
function sendError(req, res, code, key) {
  const lang = pickLang(req);
  const L = PUB[lang] || PUB.en;
  res.status(code).type('html').send(errorPage(lang, code, L[key] || key));
}
const { shareMeta:webStorageShareMeta, importMeta:webStorageImportMeta, joinedPath:webStorageJoinedPath, stat:webStorageStat,
  list:webStorageList, walkFiles:webStorageWalkFiles, invalidate:webStorageInvalidate, etag:webStorageEtag, parseRange:parseWebStorageRange } =
  createWebStorageShareTools({ storageConnectorService, cacheMs:WEB_STORAGE_STAT_CACHE_MS });
const webStorageWritable=createWebStorageWritableTools({storageConnectorService,shareMeta:webStorageShareMeta,joinedPath:webStorageJoinedPath,stat:webStorageStat,invalidate:webStorageInvalidate});
const downloadService = createDownloadService({
  MAX_ZIP_BYTES, MAX_CONCURRENT_ZIPS, HOST_ROOT, WEB_STORAGE_STREAM_IDLE_MS,
  getState: () => state, getSettings, getById, maskIp, clientIp, scheduleFlush, persistNow, sendError,
  challengeRequired, hasValidPow, challengePage, pickLang, noteCenterSharedFileSignature,
  commitManagedIpDownload, onDownloadComplete, noteBytesServed, startTransfer, endTransfer,
  noteCenterConcurrentDownloadStart, claimOneTimeDownload, releaseOneTimeDownload, challengeGateZip,
  assertRealWithin, hostToContainer, storageConnectorService, connectorErrorCode, webStorageShareMeta,
  webStorageJoinedPath, webStorageStat, webStorageEtag, parseWebStorageRange, incrementDownloads,
});
const { streamFile, streamZip, streamZipFiles, serveWebStorageFile, validDownloadResumeId, pruneDownloadResumeSessions, clearRuntimeState:clearDownloadRuntimeState } = downloadService;

const publicShareRoutes = createPublicShareRoutes({
  ACCESS_REQUESTS_MAX, FULL_IMAGES_DIR, HOST_ROOT, IMAGE_MAX_BYTES,
  PUB, PUBLIC_MESSAGE_DUP_MS, PWA_IMG_EXT, SECRETS_DIR, SUBTITLE_MAX_BYTES, VISITOR_FEEDBACK_MAX,
  accessRequestPage, albumPage, addShare, addShareCenterNotification, assertRealWithin, authService,
  bandwidthCapReached, beginUnlockAttempt, bumpViews, challengeGateZip, checkSharePassword, clampIndex, createPowChallenge,
  cleanConnectorPath, clientIp, collectionPage, connectorErrorCode, detachActiveShare,
  destroyShareManagedData, emitLiveActivity, encDecryptPage, encodePath, errorPage, esc,
  express, filePage, firstExistingPhotoFile, flagFromCode, folderPage, formatBytes, geolocate, geoSync, getByToken,
  finishUnlockAttempt, getSettings, getState:() => state, hasAccessRules, highlightCode,
  hostToContainer, imageContentType, imageDimensions, incrementDownloads, issuePowCookie,
  ipDownloadQuotaBlocked, isAccessApproved, isActive, isScheduled, isUnlocked,
  linkAccessReason, linkPrefix, mapLimit, maskIp, mediaPlayerPage, notePhotoView, notify,
  noteUnlockFailure, noteUnlockSuccess, pageShell, passwordPage, pendingAccessRequest, persistNow, photoAdaptivePath,
  photoCacheRevision, photoExt, photoOriginalPaths, photoVariantPaths, pickLang,
  previewInfo, previewWatermark, primaryBase, pubIp,
  publicMessageDecision, publicRateRetryAfter, readFileCapped, readZipEntries,
  recipientByToken, recordAndCheckVisitor, recordRecipientView, renderKind, renderMarkdown,
  resolveWithin, restorePublicMessageDecision, scheduleFlush, scheduleSearchReindex,
  secretPage, sendError, sendPasswordWorkHtml, serveWebStorageFile, setAccessRequestCookie,
  setUnlockCookie, shareEffectiveExpiry, shareItems, snapshotPublicMessageDecision,
  srtToVtt, stampPhotoUploadDevice, streamFile, streamToFileBounded, streamZip,
  streamZipFiles, timingSafeEqualStr, upgradeLegacySharePassword, verifyPowChallenge, webStorageFolderPage,
  webStorageList, webStorageShareMeta, webStorageStat, zipAllowed,
});
const { downloadRouter, parseHotlinkHosts, RENDER_MAX_BYTES } = publicShareRoutes;

// ===================================================================
//  UPLOAD / RECEPTION DOMAIN SERVICE
// ===================================================================
// Quotas, resumable staging, moderation, antivirus, duplicate tracking and
// upload runtime state live behind an explicit service boundary. The small live
// bridge prevents restore operations from leaving the service with stale store maps.
const uploadReceptionService = createUploadReceptionService({
  APP_NAME, CLAMAV_HOST, CLAMAV_PORT, DATA_DIR, FULL_IMAGES_DIR, INBOX_DIR,
  MAX_CONCURRENT_UPLOADS, RECEPTION_THREAD_MAX:200, QUARANTINE_DIR, UPLOAD_IDLE_TIMEOUT_MS,
  addShareCenterNotification, assertRealWithin, clamavEnabled, clientIp, closeFd,
  dispatch, emitInboxEvent, emitLiveActivity, endTransfer,
  evaluateCustomNotificationRulesForShare, getSettings, hashFileSha256, logAudit,
  maskIp, maybeCenterReceptionQuota, notificationAccountIdForShare,
  notificationAdminAccountIds, openFd, persistNow, pubIp, readFd, resolveWithin,
  restorePlainObject, scheduleFlush, scheduleSearchReindex,
  live: {
    get state() { return state; },
    get fileExpiryMap() { return fileExpiryMap; },
    get recordFileExpiry() { return recordFileExpiry; },
  },
});
const {
  folderMetrics, acceptsUpload, normExtList, pendingUsageForShare, releaseReceptionManagedBytes,
  safeManagedInboxFilePath, receptionMetadataPath, scanFile, quarantineFile,
  maybeCleanupOrphanPendingFiles, hasActiveUploads, clearRuntimeAfterRestore:clearUploadRuntimeAfterRestore,
} = uploadReceptionService;

// ===================================================================
//  BACKUP SERVICE
// ===================================================================
// Creation, encryption and delivery live in a dedicated service. Transactional
// restore is composed separately through restore-service.js.
const backupService = createBackupService({
  fs, path, crypto, forge, DATA_KEY, SECRETS_DIR, LOG_FILE, AUDIT_CHAIN_FILE,
  AUDIT_HEAD_FILE, APP_NAME, APP_VERSION, getState: () => state, localCaPaths,
  readLocalCaCertificateOnly, localCaFeatureRelevant, readManagedTlsFile,
  validateLocalCaCertificate, validateLeafCertificate, auditKeyId, ensureAuditChainKey,
  encryptStore, decryptStore, getSettings, scheduleFlush, dispatch, formatBytes,
  logAudit, DAY_MS,
});
const { maybeRunScheduledBackup, isBackupInFlight } = backupService;

// ===================================================================
//  MAINTENANCE SERVICE
// ===================================================================
// Retention/expiry jobs and destructive-anomaly runtime state share one explicit
// lifecycle. start() is idempotent and the timers are unref'd inside the service.
const maintenanceService = createMaintenanceService({
  fs, path, crypto,
  APP_NAME, DAY_MS, INBOX_DIR, LOG_FILE, SECRETS_DIR,
  FAIL_WINDOW_MS, GEO_TTL,
  getState: () => state, getSettings, persist, persistNow, scheduleFlush,
  sessionCleanup: (now) => sessionService.cleanup(now),
  authCleanup: (now) => authService.cleanup(now),
  unlockFails, geoCache, pruneCenterTrackers,
  runExpiredLinkLifecycle, maybeCleanupOrphanPendingFiles,
  trashItems, purgeTrashRecordById, checkCenterLinkStates,
  checkExpiringShares, maybeSendDigest, maybeRunScheduledBackup,
  releaseReceptionManagedBytes, addShareCenterNotification,
  noteCenterCleanup, scheduleSearchReindex,
  notificationAccountIdForShare, receptionMetadataPath,
  safeManagedInboxFilePath, addCenterNotification,
  clientIp, isLoopback, getById, acceptsUpload,
  logAudit, dispatch,
});
const { fileExpiryMap, recordFileExpiry } = maintenanceService;
// Application route facades: services stay namespaced and route modules receive
// validated, read-only compatibility views only at attach time.
applicationContext.register('config', serverConfig);
applicationContext.register('platform', { fs, path, crypto, express, QRCode, nodemailer, webpush, forge, pwaAdminHealth });
applicationContext.register('core-utils', require('./lib/core-utils'));
applicationContext.register('storage-connectors', require('./lib/storage-connectors'));
applicationContext.register('photo-utils', require('./lib/photo-utils'));
applicationContext.register('auth-utils', require('./lib/auth-utils'));
applicationContext.register('file-content-utils', require('./lib/file-content-utils'));
applicationContext.register('text-render', require('./lib/text-render'));
applicationContext.register('dlp-utils', require('./lib/dlp-utils'));
applicationContext.register('state-store', stateStore);
applicationContext.register('settings', settingsService);
applicationContext.register('account', accountService);
applicationContext.register('network', networkServices);
applicationContext.register('share-presentation', sharePresentationService);
applicationContext.register('activity', activityPresenceService);
applicationContext.register('audit', auditService);
applicationContext.register('notification', notificationService);
applicationContext.register('notification-center', notificationCenterService);
applicationContext.register('share', shareService);
applicationContext.register('photo', photoService);
applicationContext.register('ocr', ocrService);
applicationContext.register('search', searchService);
applicationContext.register('search-compat', applicationContext.bind(searchService, {
  scheduleSearchReindex:'scheduleReindex', ...SEARCH_COMPAT_MAP,
}));
applicationContext.register('dlp', dlpService);
applicationContext.register('transfer', transferService);
applicationContext.register('restore', restoreService);
applicationContext.register('session', sessionService);
applicationContext.register('auth', authService);
applicationContext.register('public-pages', publicPages);
applicationContext.register('public-access', publicAccessService);
applicationContext.register('public-abuse', publicAbuseService);
applicationContext.register('download', downloadService);
applicationContext.register('public-share', publicShareRoutes);
applicationContext.register('upload', uploadReceptionService);
applicationContext.register('backup', backupService);
applicationContext.register('maintenance', maintenanceService);
applicationContext.register('tls-manager', tlsManager);
applicationContext.register('pwa-notification', pwaNotificationService);
// Process-local constants that are intentionally not environment configuration.
// Keep these explicit so route profiles cannot accidentally depend on an undeclared
// lexical constant from this composition root.
applicationContext.register('runtime-constants', Object.freeze({ DAY_MS, ACTIVITY_HISTORY_MAX, UNDO_LOG_MAX }));
applicationContext.register('early-adapters', {
  assertRealWithin, containerToHost, hostToContainer, resolveWithin,
  clientIp, parseCookies, secureCookie, cleanConnectorPath, connectorErrorCode, connectorHttpStatus,
  createWebStorageUploadHandler, emitInboxEvent, sendError,
  webStorageConnectorStatus, webStorageList, webStorageStat, webStorageWalkFiles,
  webStorageImportMeta, webStorageWritable, storageConnectorService,
});

// ===================================================================
//  RECEPTION / COLLABORATION PUBLIC ROUTES
// ===================================================================
// Visitor-facing writable-link HTTP orchestration is isolated from the main
// composition root. Upload storage/accounting primitives come from the dedicated
// uploadReceptionService above; mutable store state is exposed through `live`.
attachReceptionCollaborationRoutes(applicationContext.route('receptionCollaboration', [
  'config', 'platform', 'core-utils', 'state-store', 'settings', 'activity', 'audit',
  'notification', 'notification-center', 'share', 'photo', 'search-compat', 'transfer',
  'network', 'public-pages', 'public-access', 'public-abuse', 'download', 'public-share', 'upload',
  'maintenance', 'early-adapters',
], { PENDING_DIR, live: { get state() { return state; } } }));

// Burn-after-read secrets, unlock, access-request and visitor feedback routes
// are registered by lib/server/public-share-routes.js.

// ===================================================================
//  ADMIN ROUTES: protected API
// ===================================================================

const adminBoundary = createAdminRouter({
  express, requireAuth, getAccountById, accountNeedsPwChange, getById,
});
const { adminRouter, ownsShare } = adminBoundary;
applicationContext.register('admin-boundary', adminBoundary);
applicationContext.register('service-refs', { authService, sessionService, storageConnectorService, auditService });

// Current account for this request (guaranteed present: getSession validated it).
function currentAccount(req) { return getAccountById(req.session.accountId); }

// Entry-point HTTP handlers (Local-CA bootstrap, admin login, liveness/metadata)
// live in root-routes.js; their route registrations stay below, in Express order.
// loginHints and sendLocalCaCertificate are also projected into the admin and
// diagnostics route domains, so they are destructured here by name.
const {
  sendLocalCaCertificate, loginHints, handleLogin, handleHealthz, handleMeta,
} = createRootRoutes({
  APP_NAME, APP_VERSION, APP_YEAR, RELEASE_DATE, STORAGE_SETUP,
  fs, crypto, forge,
  attemptLogin, accountNeedsPwChange, accountService, dataWritable,
  updateState,
  tlsManager, localCaFeatureRelevant, localCaModeActive, localCaPaths,
  validateLocalCaCertificate, certificateFingerprint256,
  readLocalCaCertificateOnly, ensureLocalCa,
});

applicationContext.register('admin-adapters', {
  accountNeedsPwChange,
  adminPwFromEnv: accountService.isEnvironmentPasswordManaged(),
  appName: APP_NAME,
  currentAccount,
  getNotificationMutableCategories: () => NOTIFICATION_MUTABLE_CATEGORIES,
  getCustomNotificationRuleMetrics: () => CUSTOM_NOTIFICATION_RULE_METRICS,
  getPwaPairTickets: () => pwaPairTickets,
  pwaDeviceResolvedAccount,
  cleanupPwaCapabilityScopes,
  loginHints,
  publicIp: pubIp,
});

attachAdminAccountRoutes(applicationContext.route('adminAccount', [
  'platform', 'auth-utils', 'state-store', 'account', 'activity', 'audit',
  'notification', 'notification-center', 'share', 'session', 'public-access', 'admin-boundary',
  'service-refs', 'admin-adapters',
], { getState: () => state, replaceState: (next) => { state = next; } }));

attachAdminSecurityRoutes(applicationContext.route('adminSecurity', [
  'platform', 'core-utils', 'state-store', 'settings', 'audit', 'dlp', 'maintenance',
  'session', 'admin-boundary', 'service-refs', 'admin-adapters', 'early-adapters',
], { getState: () => state }));

// ---------------------------------------------------------------------------
// Bidirectional storage connectors.
// Direct-Xfer stores only connector metadata (name/type/rclone remote/root).
// OAuth tokens, passwords and private keys stay in /data/rclone/rclone.conf,
// which can be created with `rclone config` and must remain mode 0600. This keeps
// secrets out of shares.json, API responses, audit text and the browser.

// Connector inventory metadata is owned by storage-connector-job-service.js.
const storageConnectorJobService = createStorageConnectorJobService({
  storageConnectorService,
  connectorStartupCleanup,
  maxActiveJobs:MAX_ACTIVE_CONNECTOR_JOBS,
  INBOX_DIR,
  IMAGE_STORE_DIR,
  HOST_ROOT,
  getState:() => state,
  trashItems,
  persist,
  persistNow,
  scheduleFlush,
  crypto,
  path,
  withinRoot,
  assertRealWithin,
  hostToContainer,
  clientIp,
  cleanConnectorPath,
  clamavEnabled,
  scanFile,
  quarantineFile,
  connectorErrorCode,
  logAudit,
  getAccountById,
  scheduleSearchReindex,
});
const { connectorStore } = storageConnectorJobService;
applicationContext.register('storage-jobs', storageConnectorJobService);
applicationContext.register('storage-adapters', {
  storageConnectorService, googleOAuthProfileStore, googleOAuthBrokerClient,
  connectorTypes: CONNECTOR_TYPES, oauthConnectorTypes: OAUTH_CONNECTOR_TYPES,
  googleOAuthPublicOrigin: () => normalizeLinkBase(getSettings().linkBase || PUBLIC_URL || '') || '',
  googleOAuthBrokerUrl: () => GOOGLE_OAUTH_BROKER_URL_ENV || String(getSettings().googleOAuthBrokerUrl || '').trim(),
  googleOAuthBrokerManaged: () => !!GOOGLE_OAUTH_BROKER_URL_ENV,
  cleanConnectorPath, maxStorageConnectors: MAX_STORAGE_CONNECTORS,
  connectorJobService: storageConnectorJobService,
});

attachAdminStorageRoutes(applicationContext.route('adminStorage', [
  'platform', 'core-utils', 'storage-connectors', 'state-store', 'account', 'audit',
  'admin-boundary', 'storage-jobs', 'storage-adapters', 'early-adapters',
], { storageConnectorService, cleanConnectorPath, connectorErrorCode, connectorHttpStatus }));

// The Local-CA bootstrap handler (sendLocalCaCertificate) is created above via
// createRootRoutes(); its route is registered further down, in Express order.

// Core share-management routes (exports, trash/undo, statistics, imports and creation).
applicationContext.register('share-route-adapters', {
  LOG_FILE, SHARE_CHANGE_HISTORY_MAX, UNDO_LOG_MAX, VISITORS_MAX, VISITOR_FEEDBACK_MAX,
  SHARE_BACKING_HEALTH_CACHE_MS, SHARE_LOGICAL_BYTES_CACHE_MS,
  clearShareRuntimeState: () => shareService.clearRuntimeState(),
  inboxReceivedFiles, stampPhotoUploadDevice, photoUploadDeviceName, normalizeTags,
});

const adminShareRouteLiveBindings = {
  get state() { return state; },
  set state(value) { state = value; },
  get searchIndexBuilding() { return searchIndexBuilding; },
  get searchIndexError() { return searchIndexError; },
  get universalSearchIndex() { return universalSearchIndex; },
};
const { detailedShareStatsPayload, reqPathList, resolveHostItem, safeReceivedFilePath } = attachAdminShareCoreRoutes(applicationContext.route('adminShareCore', [
  'config', 'platform', 'core-utils', 'photo-utils', 'state-store', 'settings',
  'activity', 'audit', 'notification', 'notification-center', 'share', 'photo',
  'search-compat', 'dlp', 'transfer', 'public-access', 'download', 'upload',
  'storage-jobs', 'share-presentation', 'admin-boundary', 'admin-adapters',
  'early-adapters', 'share-route-adapters',
], { PENDING_DIR, live: adminShareRouteLiveBindings }));
applicationContext.register('share-core-output', { detailedShareStatsPayload, reqPathList, resolveHostItem, safeReceivedFilePath });

// Share lifecycle/mutation routes continue after photo administration to preserve route order.
attachAdminShareRoutes(applicationContext.route('adminShare', [
  'config', 'platform', 'core-utils', 'photo-utils', 'state-store', 'settings',
  'activity', 'audit', 'notification', 'notification-center', 'share', 'photo',
  'search-compat', 'dlp', 'public-access', 'upload', 'share-presentation',
  'admin-boundary', 'admin-adapters', 'early-adapters', 'share-route-adapters',
  'share-core-output',
], { PENDING_DIR, live: adminShareRouteLiveBindings }));

// Storage accounting, system health and bounded host diagnostics are owned by
// domain services. Only live state and mutable TLS/runtime collaborators cross
// this composition boundary.
const diagnosticsService = createDiagnosticsService({
  tlsCert:TLS_CERT,
  tlsKey:TLS_KEY,
  tlsDayMs:TLS_DAY_MS,
  tlsManager,
  localCaModeActive,
  readManagedTlsFile,
  localCaPaths,
  localCaStatus,
  validateProvidedTlsPair,
  certificateFingerprint256,
  tlsMaterialFingerprint,
});

const systemHealthService = createSystemHealthService({
  DATA_DIR,
  FULL_IMAGES_DIR,
  THUMBS_DIR,
  MICROS_DIR,
  PHOTO_HISTORY_DIR,
  PHOTO_VERSIONS_DIR,
  ADAPTIVE_IMAGES_DIR,
  ENC_DIR,
  SECRETS_DIR,
  QUARANTINE_DIR,
  SEARCH_INDEX_FILE,
  SEARCH_OCR_CACHE_FILE,
  LOG_FILE,
  AUDIT_CHAIN_FILE,
  STORE_FILE,
  AUDIT_HEAD_FILE,
  AUDIT_KEY_FILE,
  IMAGE_STORE_DIR,
  INBOX_DIR,
  STORAGE_SETUP,
  DATA_KEY,
  CLAMAV_HOST,
  CLAMAV_PORT,
  SEARCH_OCR_ENABLED,
  SEARCH_OCR_LANGS,
  PUBLIC_URL,
  TRUST_PROXY,
  PORT,
  ADMIN_ALLOWED_IPS,
  getState:() => state,
  getSettings,
  getServerScheme:currentServerScheme,
  getWebpush:() => webpush,
  diagnosticsService,
  connectorJobService:storageConnectorJobService,
  verifyAuditChain,
  auditService,
  universalSearchStatus,
  detectSearchOcrTools,
  diskFreeThresholds,
  isBackupInFlight,
  clamavEnabled,
  tlsManager,
  connectorStore,
  pushSubs,
  emailConfigured,
  effectiveWebhook,
  getLastEmail,
  getLastWebhook,
  getLocalIPv4s,
  listShares,
  isScheduled,
  isActive,
  shareEffectiveExpiry,
  shareBackingHealthSnapshot,
  queueShareBackingHealthRefresh,
});
applicationContext.register('diagnostics', diagnosticsService);
applicationContext.register('system-health', systemHealthService);

// ===================================================================
//  EXPRESS APPLICATION
// ===================================================================

// Administrator network policy, request security headers and the Express app
// live in http-application.js. API/domain routes are composed below in the same
// order as before, between its public-asset and final SPA/error phases.
// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage
// No `csurf`/`csrf` package here on purpose — CSRF is handled by the custom
// session double-submit token enforced by requireAuth().
const httpApplication = createHttpApplication({
  ADMIN_ALLOW_ANY,
  ADMIN_ALLOWED_IPS,
  TRUST_PROXY,
  clientIp,
  crypto,
  express,
  getSettings,
  ipInList,
  isLocalNetwork,
  isLoopback,
  localCaModeActive,
  parseIpList,
  path,
  requestContext,
  rootDir:__dirname,
  sendError,
});
const { app, adminGuard, attachPublicAssetRoutes, attachAdminSpaAndFallbacks } = httpApplication;
applicationContext.register('http-application', httpApplication);

// Credential-free trust bootstrap: the CA certificate itself is public. This
// endpoint is deliberately outside adminGuard/auth so a new LAN device never has
// to submit credentials through an as-yet-untrusted TLS session. Plain LAN HTTP
// is rejected by sendLocalCaCertificate(); compare the fingerprint out-of-band
// before installing the downloaded root.
app.get('/direct-xfer-local-ca.cer', sendLocalCaCertificate);

// Windows launcher/ServerHost private loopback routes are isolated from the main
// HTTP composition root. The launcher token remains a per-process capability and
// browser password recovery uses a separate short-lived ticket.
attachWindowsLauncherRoutes({
  APP_NAME, APP_VERSION, ADMIN_USERNAME, DX_WINDOWS_LAUNCHER_TOKEN,
  accountService, app, clearSessionsOfAccount, crypto, express, logAudit,
  ownerAccount, setAccountPassword, shutdown,
});

// Public downloads and receptions (no authentication).
app.use('/', downloadRouter);

// Browser assets used by public share/reception pages stay outside the admin
// network guard. Their cache policy and file mapping live in http-application.js.
attachPublicAssetRoutes();

// Companion PWA — a mobile "send" app (photos / documents / files → a reception
// link), served at /app. Service construction, public install/bootstrap contracts,
// parsers, document policy, route facades and the 106-route PWA surface are composed
// by pwa-application.js. Mutable state/search/module references stay live through the
// narrow callbacks below, while the deferred pwaServices registry preserves the early
// bootstrap bridges consumed by notification/share services.
const pwaApplication = createPwaApplication({
  context:applicationContext,
  registry:pwaServices,
  rootDir:__dirname,
  live:{
    getState:() => state,
    setState:(value) => { state = value; },
    getSearchIndexBuilding:() => searchIndexBuilding,
    getUniversalSearchIndex:() => universalSearchIndex,
    getWebpush:() => webpush,
  },
});
const {
  device:pwaDeviceService, webauthn:webauthnService, event:pwaEventService, pairTickets:pwaPairTickets,
} = pwaApplication;

// Login (local network only by default). 256kb comfortably fits a shares-config
// import (hundreds of link records) while staying bounded; all /api routes are
// gated by adminGuard (IP allowlist) before this parser ever runs. The handler
// body and loginHints() live in root-routes.js; jsonParser is shared with the
// /api admin mount registered below.
const jsonParser = express.json({ limit: '256kb' });
app.post('/api/login', adminGuard, jsonParser, handleLogin);

// Unauthenticated liveness probe (Docker HEALTHCHECK / uptime monitors) and public
// footer metadata (version/year/update). Both handlers live in root-routes.js and
// deliberately expose no secrets or operational counts.
app.get('/healthz', handleHealthz);
app.get('/api/meta', handleMeta);

applicationContext.register('late-service-refs', { auditService, diagnosticsService, systemHealthService });
applicationContext.register('late-adapters', {
  STORAGE_SETUP, RENDER_MAX_BYTES, SEARCH_OCR_ENABLED, SEARCH_OCR_LANGS,
  sendLocalCaCertificate, detectSearchOcrTools,
  shutdown, getServer: currentHttpServer,
});

// Remaining administrator domains are registered from focused route modules.
// Keep this composition close to the /api mount so every helper declared above is initialized.
attachAdminSettingsRoutes(applicationContext.route('adminSettings', [
  'config', 'platform', 'state-store', 'settings', 'activity', 'audit', 'notification',
  'notification-center', 'share', 'transfer', 'admin-boundary', 'late-adapters',
], { getState: () => state }));

attachAdminPhotoRoutes(applicationContext.route('adminPhoto', [
  'config', 'platform', 'core-utils', 'photo-utils', 'dlp-utils', 'state-store', 'settings',
  'notification-center', 'share', 'photo', 'dlp', 'download', 'share-presentation', 'audit',
  'admin-boundary', 'early-adapters', 'share-route-adapters', 'share-core-output',
  'runtime-constants',
], { getState: () => state }));

attachAdminDashboardRoutes(applicationContext.route('adminDashboard', [
  'config', 'platform', 'core-utils', 'state-store', 'account', 'activity', 'audit',
  'notification', 'share', 'transfer', 'auth', 'public-access', 'admin-boundary',
  'service-refs', 'share-route-adapters', 'late-service-refs', 'runtime-constants',
], { getState: () => state }));

attachAdminDiagnosticsRoutes(applicationContext.route('adminDiagnostics', [
  'config', 'platform', 'core-utils', 'photo-utils', 'file-content-utils', 'text-render',
  'state-store', 'settings', 'network', 'share-presentation', 'audit', 'notification',
  'search-compat', 'restore', 'session', 'download', 'backup', 'admin-boundary',
  'early-adapters', 'late-service-refs', 'late-adapters', 'pwa-device', 'tls-manager',
], { getState: () => state }));

// Admin API (local network + password).
app.use('/api', adminGuard, jsonParser, adminRouter);

// Final administrator SPA/static surface, 404 handling and the global Express
// error boundary are registered only after every API/domain route above.
attachAdminSpaAndFallbacks();

lifecycleService = createLifecycleService({
  app,
  config:serverConfig,
  bootstrap:runtimeBootstrap,
  tlsManager,
  maintenanceService,
  storageConnectorJobService,
  pwaEventService,
  stopPwaApplication:pwaApplication.stop,
  accountService,
  bus,
  getSettings,
  dataWritable,
  initUniversalSearchIndex,
  flushNow,
  closeActivityPresenceStreams,
  liveActivityClients,
  presenceClients,
  loadTlsOptions,
  refreshLocalTlsServerContext,
  refreshProvidedTlsServerContext,
  noteCenterLifecycleStart,
  noteCenterInstalledVersion,
  checkCenterLinkStates,
  checkCenterSystemHealth,
  noteCenterCleanShutdown,
  getPublicIP,
  publicIpDiscoveryEnabled,
  checkForUpdate,
});
lifecycleService.start();
