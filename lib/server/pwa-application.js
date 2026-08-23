'use strict';

const { createPwaDeviceService } = require('./pwa-device-service');
const { createPwaPhotoService } = require('./pwa-photo-service');
const { createWebauthnService } = require('./webauthn-service');
const { createPwaEventService } = require('./pwa-event-service');
const { attachPwaRoutes } = require('./pwa-routes');

const PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED = 'password-change-required';
const PWA_COMPOSITION_PUBLIC_SHELL_ASSETS = Object.freeze([
  '/admin-advanced.js',
  '/admin-audit-connectors.js',
  '/mobile-intelligence.js',
]);

const PWA_CONTEXT_DOMAIN_TARGETS = Object.freeze([
  'pwa-device', 'pwa-photo', 'pwa-webauthn', 'pwa-event',
]);
const PWA_REGISTRY_SERVICE_TARGETS = Object.freeze([
  'device', 'photo', 'webauthn', 'event',
]);
const UNSAFE_FACADE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

// Route-only compatibility values that are not owned by one of the dedicated PWA
// services. Keeping this mapping here means server.js no longer has to mirror the
// very large dependency list consumed by pwa-routes.js.
const PWA_ROUTE_FACADE_CONTEXT = Object.freeze({
  runtime: Object.freeze({
    ACTIVITY_HISTORY_MAX:['runtime-constants', 'ACTIVITY_HISTORY_MAX'],
    FULL_IMAGES_DIR:['config', 'FULL_IMAGES_DIR'],
    HOST_ROOT:['config', 'HOST_ROOT'],
    IMAGE_MAX_BYTES:['config', 'IMAGE_MAX_BYTES'],
    INBOX_DIR:['config', 'INBOX_DIR'],
    MICRO_MAX_BYTES:['config', 'MICRO_MAX_BYTES'],
    PENDING_DIR:['config', 'PENDING_DIR'],
    QRCode:['platform', 'QRCode'],
    THUMB_MAX_BYTES:['config', 'THUMB_MAX_BYTES'],
    TRANSFER_STALL_MS:['config', 'TRANSFER_STALL_MS'],
    UNDO_LOG_MAX:['runtime-constants', 'UNDO_LOG_MAX'],
    crypto:['platform', 'crypto'],
    errorPage:['public-pages', 'errorPage'],
    express:['platform', 'express'],
    fs:['platform', 'fs'],
    imageContentType:['photo-utils', 'imageContentType'],
    imageDimensions:['photo-utils', 'imageDimensions'],
    mapLimit:['core-utils', 'mapLimit'],
    path:['platform', 'path'],
    pickLang:['public-pages', 'pickLang'],
    timingSafeEqualStr:['core-utils', 'timingSafeEqualStr'],
  }),
  identity: Object.freeze({
    accountList:['account', 'accountList'],
    accountNeedsPwChange:['account', 'accountNeedsPasswordChange'],
    adminGuard:['http-application', 'adminGuard'],
    attemptLogin:['auth', 'attemptLogin'],
    auditReq:['audit', 'auditReq'],
    clientIp:['early-adapters', 'clientIp'],
    createSession:['session', 'createSession'],
    destroySession:['session', 'destroySession'],
    externalProto:['share-presentation', 'externalProto'],
    findAccountByName:['account', 'findAccountByName'],
    getAccountById:['account', 'getAccountById'],
    getSession:['session', 'getSession'],
    invalidateSessionSid:['session', 'invalidateSessionSid'],
    logAudit:['audit', 'logAudit'],
    loginHints:['admin-adapters', 'loginHints'],
    makeSharePassword:['public-access', 'makeSharePassword'],
    sendPasswordWorkError:['public-access', 'sendPasswordWorkError'],
  }),
  state: Object.freeze({
    assertRealWithin:['early-adapters', 'assertRealWithin'],
    containerToHost:['early-adapters', 'containerToHost'],
    deleteFileExpiryForPath:['upload', 'deleteFileExpiryForPath'],
    hostToContainer:['early-adapters', 'hostToContainer'],
    persist:['state-store', 'persist'],
    persistNow:['state-store', 'persistNow'],
    primaryBase:['share-presentation', 'primaryBase'],
    reqPathList:['share-core-output', 'reqPathList'],
    resolveHostItem:['share-core-output', 'resolveHostItem'],
    resolveWithin:['early-adapters', 'resolveWithin'],
    safeReceivedFilePath:['share-core-output', 'safeReceivedFilePath'],
    scheduleFlush:['state-store', 'scheduleFlush'],
    scheduleSearchReindex:['search-compat', 'scheduleSearchReindex'],
    sendError:['early-adapters', 'sendError'],
    serveWebStorageFile:['download', 'serveWebStorageFile'],
    stagePendingFileRemoval:['upload', 'stagePendingFileRemoval'],
    streamFile:['download', 'streamFile'],
  }),
  shares: Object.freeze({
    albumInviteHash:['public-share', 'albumInviteHash'],
    appendReceptionThreadMessage:['upload', 'appendReceptionThreadMessage'],
    applyNewShareLifetimePolicy:['share', 'applyNewShareLifetimePolicy'],
    approvePendingModeration:['upload', 'approvePendingModeration'],
    claimPendingModeration:['upload', 'claimPendingModeration'],
    decorateShare:['share-presentation', 'decorateShare'],
    detailedShareStatsPayload:['share-core-output', 'detailedShareStatsPayload'],
    finalizePendingModerationApproval:['upload', 'finalizePendingModerationApproval'],
    inboxRejectStatus:['upload', 'inboxRejectStatus'],
    normalizeTags:['share-route-adapters', 'normalizeTags'],
    ownerThreadMessage:['upload', 'ownerThreadMessage'],
    parseExpiry:['share', 'parseExpiry'],
    parseLinkRateKBps:['share', 'parseLinkRateKBps'],
    parseMaxDownloads:['share', 'parseMaxDownloads'],
    parseNewShareExpiry:['share', 'parseNewShareExpiry'],
    pendingModerationRows:['upload', 'pendingModerationRows'],
    receptionThreadArray:['upload', 'receptionThreadArray'],
    receptionThreadEnabled:['upload', 'receptionThreadEnabled'],
    receptionThreadUnreadCount:['upload', 'receptionThreadUnreadCount'],
    reindex:['share', 'reindex'],
    releasePendingModeration:['upload', 'releasePendingModeration'],
  }),
  activity: Object.freeze({
    activeTransfers:['transfer', 'activeTransfers'],
    activityEventForClient:['activity', 'activityEventForClient'],
    activityEventsForClient:['activity', 'activityEventsForClient'],
    emitLiveActivity:['activity', 'emitLiveActivity'],
    getVapidKeys:['notification', 'getVapidKeys'],
    openPresenceStream:['activity', 'openPresenceStream'],
    presenceSnapshot:['activity', 'presenceSnapshot'],
    pushSubs:['notification', 'pushSubs'],
    requestActiveTransferStop:['transfer', 'requestActiveTransferStop'],
    sanitizeActivityLog:['activity', 'sanitizeActivityLog'],
    sendWebPushAwaited:['notification', 'sendWebPushAwaited'],
    syncLiveActivityCache:['activity', 'syncLiveActivityCache'],
  }),
  policyAndSearch: Object.freeze({
    applyDlpSummary:['dlp', 'applyDlpSummary'],
    buildUniversalSearchIndex:['search-compat', 'buildUniversalSearchIndex'],
    connectorErrorCode:['storage-connectors', 'connectorErrorCode'],
    dlpDecision:['dlp', 'dlpDecision'],
    dlpScanResolvedItems:['dlp', 'dlpScanResolvedItems'],
    dlpScanStoredFile:['dlp', 'dlpScanStoredFile'],
    globalMetadataSearch:['search-compat', 'globalMetadataSearch'],
    universalSearchQuery:['search-compat', 'universalSearchQuery'],
    universalSearchScopedStatus:['search-compat', 'universalSearchScopedStatus'],
    universalSearchShareEligible:['search-compat', 'universalSearchShareEligible'],
    universalSemanticSearchQuery:['search-compat', 'universalSemanticSearchQuery'],
    webStorageConnectorStatus:['early-adapters', 'webStorageConnectorStatus'],
    webStorageWalkFiles:['early-adapters', 'webStorageWalkFiles'],
  }),
});

function requireObject(value, label) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError(`pwa-application requires ${label}`);
  }
  return value;
}

function contextDomain(context, name) {
  const source = context.current(name);
  if (!source) throw new TypeError(`pwa-application context is missing ${name}`);
  return source;
}

function contextValue(context, domainName, propertyName) {
  const source = contextDomain(context, domainName);
  const descriptor = Object.getOwnPropertyDescriptor(source, propertyName);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError(`pwa-application ${domainName} is missing stable ${propertyName}`);
  }
  if (descriptor.value === undefined) {
    throw new TypeError(`pwa-application ${domainName}.${propertyName} is undefined`);
  }
  // Service functions in Direct-Xfer close over their state and do not depend on
  // `this`. Preserve function identity here because callable modules such as Express
  // carry important static helpers (.json/.raw/.static) that Function#bind would lose.
  return descriptor.value;
}

function bindStableServiceMethod(service, name, label) {
  requireObject(service, label);
  const descriptor = Object.getOwnPropertyDescriptor(service, name);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`pwa-application ${label} is missing stable method ${name}`);
  }
  return descriptor.value.bind(service);
}

function projectContextGroup(context, spec) {
  const out = Object.create(null);
  for (const [exposed, [domain, actual]] of Object.entries(spec)) {
    Object.defineProperty(out, exposed, {
      enumerable:true,
      configurable:false,
      writable:false,
      value:contextValue(context, domain, actual),
    });
  }
  return Object.freeze(out);
}

function createPwaDocumentHeaders(res) {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie, Authorization');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; manifest-src 'self'; frame-src 'self' blob:; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
}

function mergeStableFacade(base, locals, label) {
  requireObject(locals, `${label} locals`);
  const out = Object.create(null);
  for (const [source, sourceLabel] of [[base, `${label} context`], [locals, `${label} locals`]]) {
    for (const name of Object.keys(source)) {
      if (!name || UNSAFE_FACADE_NAMES.has(name)) throw new TypeError(`pwa-application unsafe ${label} dependency: ${name}`);
      if (Object.prototype.hasOwnProperty.call(out, name)) {
        throw new Error(`pwa-application duplicate ${label} dependency: ${name}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`pwa-application ${sourceLabel} dependency ${name} must be stable`);
      }
      if (descriptor.value === undefined) throw new TypeError(`pwa-application ${sourceLabel} dependency ${name} is undefined`);
      Object.defineProperty(out, name, {
        enumerable:true, configurable:false, writable:false, value:descriptor.value,
      });
    }
  }
  return Object.freeze(out);
}

function createPwaRouteFacades(context, runtimeLocals) {
  const facades = Object.create(null);
  for (const [groupName, spec] of Object.entries(PWA_ROUTE_FACADE_CONTEXT)) {
    facades[groupName] = projectContextGroup(context, spec);
  }
  facades.runtime = mergeStableFacade(facades.runtime, runtimeLocals, 'runtime facade');
  return Object.freeze(facades);
}

function createPwaRouteLiveBindings(live) {
  if (!live || typeof live.getState !== 'function' || typeof live.setState !== 'function') {
    throw new TypeError('pwa-application requires live getState/setState');
  }
  for (const name of ['getSearchIndexBuilding', 'getUniversalSearchIndex', 'getWebpush']) {
    if (typeof live[name] !== 'function') throw new TypeError(`pwa-application requires live ${name}`);
  }
  return {
    get state() { return live.getState(); },
    set state(value) { live.setState(value); },
    get searchIndexBuilding() { return live.getSearchIndexBuilding(); },
    get universalSearchIndex() { return live.getUniversalSearchIndex(); },
    get webpush() { return live.getWebpush(); },
  };
}

function assertPwaCompositionTargetsAvailable(context, registry) {
  for (const domain of PWA_CONTEXT_DOMAIN_TARGETS) {
    if (context.current(domain) != null) throw new Error(`pwa-application context domain already registered: ${domain}`);
  }
  for (const name of PWA_REGISTRY_SERVICE_TARGETS) {
    if (registry.current(name) != null) throw new Error(`pwa-application registry service already bound: ${name}`);
  }
}

function createPwaApplication(options = {}) {
  const context = requireObject(options.context, 'application context');
  if (typeof context.current !== 'function' || typeof context.register !== 'function') {
    throw new TypeError('pwa-application requires an application context registry');
  }
  const registry = requireObject(options.registry, 'PWA service registry');
  if (typeof registry.bind !== 'function' || typeof registry.current !== 'function' || typeof registry.validate !== 'function') {
    throw new TypeError('pwa-application requires registry.bind()/current()/validate()');
  }
  const rootDir = String(options.rootDir || '').trim();
  if (!rootDir) throw new TypeError('pwa-application requires rootDir');
  assertPwaCompositionTargetsAvailable(context, registry);
  const routeLiveBindings = createPwaRouteLiveBindings(options.live);

  // Resolve every route-level dependency and immutable bootstrap asset before any
  // deferred PWA service is installed. A typo, missing context provider or unreadable
  // PWA shell therefore fails without poisoning the registry used by earlier services.
  const notificationCenter = contextDomain(context, 'notification-center');
  const pwaNotification = contextDomain(context, 'pwa-notification');
  const share = contextDomain(context, 'share');
  const photo = contextDomain(context, 'photo');

  const app = contextValue(context, 'http-application', 'app');
  const express = contextValue(context, 'platform', 'express');
  const fs = contextValue(context, 'platform', 'fs');
  const path = contextValue(context, 'platform', 'path');
  const crypto = contextValue(context, 'platform', 'crypto');

  const appLoginParser = express.json({ limit:'8kb' });
  const pwaJsonParser = express.json({ limit:'8kb' });
  const pwaNetworkTestParser = express.raw({ type:'application/octet-stream', limit:'2mb' });
  const pwaNetworkTestPayload = crypto.randomBytes(1024 * 1024);
  const pwaIndexTemplate = fs.readFileSync(path.join(rootDir, 'pwa', 'index.html'), 'utf8');
  const pwaRouteFacades = createPwaRouteFacades(context, {
    appLoginParser,
    pwaIndexTemplate,
    pwaJsonParser,
    pwaNetworkTestParser,
    pwaNetworkTestPayload,
    setPwaDocumentHeaders:createPwaDocumentHeaders,
  });

  // Resolve the service objects that are passed wholesale to pwa-routes. Intra-PWA
  // dependencies use the concrete services being composed here rather than the
  // deferred registry: the registry stays untouched until the whole bootstrap has
  // passed its contracts, so a failed late dependency can be retried safely.
  let pwaEventService = null;
  const pwaDeviceService = createPwaDeviceService({
    PUBLIC_URL: contextValue(context, 'config', 'PUBLIC_URL'),
    rootDir,
    crypto,
    path,
    getState: options.live.getState,
    getAccountById: contextValue(context, 'account', 'getAccountById'),
    findAccountByName: contextValue(context, 'account', 'findAccountByName'),
    scheduleFlush: contextValue(context, 'state-store', 'scheduleFlush'),
    persistNow: contextValue(context, 'state-store', 'persistNow'),
    timingSafeEqualStr: contextValue(context, 'core-utils', 'timingSafeEqualStr'),
    parseCookies: contextValue(context, 'early-adapters', 'parseCookies'),
    secureCookie: contextValue(context, 'early-adapters', 'secureCookie'),
    getSession: contextValue(context, 'session', 'getSession'),
    adminGuard: contextValue(context, 'http-application', 'adminGuard'),
    externalProto: contextValue(context, 'share-presentation', 'externalProto'),
    accountNeedsPwChange: contextValue(context, 'account', 'accountNeedsPasswordChange'),
    auditReq: contextValue(context, 'audit', 'auditReq'),
    logAudit: contextValue(context, 'audit', 'logAudit'),
    clientIp: contextValue(context, 'early-adapters', 'clientIp'),
    destroySession: contextValue(context, 'session', 'destroySession'),
    addCenterNotification: contextValue(context, 'notification-center', 'addCenterNotification'),
    pubIp: contextValue(context, 'activity', 'pubIp'),
    getInboxEventSubs: () => pwaEventService ? pwaEventService.inboxEventSubs : null,
  });

  const webauthnService = createWebauthnService({
    APP_NAME: contextValue(context, 'config', 'APP_NAME'),
    PUBLIC_URL: contextValue(context, 'config', 'PUBLIC_URL'),
    crypto,
    getSession: contextValue(context, 'session', 'getSession'),
    getAccountById: contextValue(context, 'account', 'getAccountById'),
    pwaDevices: bindStableServiceMethod(pwaDeviceService, 'pwaDevices', 'device service'),
    timingSafeEqualStr: contextValue(context, 'core-utils', 'timingSafeEqualStr'),
  });

  const pwaPhotoService = createPwaPhotoService({
    getState: options.live.getState,
    scheduleFlush: contextValue(context, 'state-store', 'scheduleFlush'),
    pwaDeviceCreatorAccount: bindStableServiceMethod(pwaDeviceService, 'pwaDeviceCreatorAccount', 'device service'),
    pwaDeviceOwnerAccount: bindStableServiceMethod(pwaDeviceService, 'pwaDeviceOwnerAccount', 'device service'),
    pwaDevices: bindStableServiceMethod(pwaDeviceService, 'pwaDevices', 'device service'),
    stampPwaRecordOwner: bindStableServiceMethod(pwaDeviceService, 'stampPwaRecordOwner', 'device service'),
    normUsername: contextValue(context, 'account', 'normalizeUsername'),
    pwaPhotoPayload: contextValue(context, 'photo', 'pwaPhotoPayload'),
    getByToken: contextValue(context, 'share', 'getByToken'),
    parseExpiry: contextValue(context, 'share', 'parseExpiry'),
    makeSharePassword: contextValue(context, 'public-access', 'makeSharePassword'),
    parseHotlinkHosts: contextValue(context, 'public-share', 'parseHotlinkHosts'),
    normalizeTags: contextValue(context, 'share-route-adapters', 'normalizeTags'),
    getSettings: contextValue(context, 'settings', 'getSettings'),
    primaryBase: contextValue(context, 'share-presentation', 'primaryBase'),
    isActive: contextValue(context, 'share', 'isActive'),
    listShares: contextValue(context, 'share', 'listShares'),
    photoStatsOf: contextValue(context, 'photo', 'photoStatsOf'),
    DAY_MS: contextValue(context, 'runtime-constants', 'DAY_MS'),
    photoLastPublicViewAt: contextValue(context, 'photo', 'photoLastPublicViewAt'),
    photoManagedBytes: contextValue(context, 'photo', 'photoManagedBytes'),
    destroyShareManagedData: contextValue(context, 'share', 'destroyShareManagedData'),
    detachActiveShare: contextValue(context, 'share', 'detachActiveShare'),
    logAudit: contextValue(context, 'audit', 'logAudit'),
    persistNow: contextValue(context, 'state-store', 'persistNow'),
    scheduleSearchReindex: contextValue(context, 'search-compat', 'scheduleSearchReindex'),
    dlpEffectiveAction: contextValue(context, 'dlp', 'dlpEffectiveAction'),
    pwaImagesForRequest: contextValue(context, 'photo', 'pwaImagesForRequest'),
  });

  pwaEventService = createPwaEventService({
    APP_NAME: contextValue(context, 'config', 'APP_NAME'),
    fs,
    path,
    INBOX_DIR: contextValue(context, 'config', 'INBOX_DIR'),
    resolveWithin: contextValue(context, 'early-adapters', 'resolveWithin'),
    getAccountById: contextValue(context, 'account', 'getAccountById'),
    findAccountByName: contextValue(context, 'account', 'findAccountByName'),
    scheduleFlush: contextValue(context, 'state-store', 'scheduleFlush'),
    pwaDeviceCreatorAccount: bindStableServiceMethod(pwaDeviceService, 'pwaDeviceCreatorAccount', 'device service'),
    pwaDeviceOwnerAccount: bindStableServiceMethod(pwaDeviceService, 'pwaDeviceOwnerAccount', 'device service'),
    pwaDeviceResolvedAccount: bindStableServiceMethod(pwaDeviceService, 'pwaDeviceResolvedAccount', 'device service'),
    pwaDevices: bindStableServiceMethod(pwaDeviceService, 'pwaDevices', 'device service'),
    presenceSessionValidator: contextValue(context, 'activity', 'presenceSessionValidator'),
    logAudit: contextValue(context, 'audit', 'logAudit'),
    clientIp: contextValue(context, 'early-adapters', 'clientIp'),
    sendPwaPush: contextValue(context, 'pwa-notification', 'sendPwaPush'),
    getById: contextValue(context, 'share', 'getById'),
    trashItems: contextValue(context, 'share', 'trashItems'),
    pwaViewerIsAdmin: bindStableServiceMethod(pwaPhotoService, 'pwaViewerIsAdmin', 'photo service'),
    canManagePwaImage: bindStableServiceMethod(pwaPhotoService, 'canManagePwaImage', 'photo service'),
    getActiveTransfers: () => contextValue(context, 'transfer', 'activeTransfers'),
    listTransfers: contextValue(context, 'transfer', 'listTransfers'),
  });

  if (pwaDeviceService.PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED !== PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED) {
    throw new Error('pwa-auth-error-contract-mismatch');
  }
  if (!(pwaDeviceService.PWA_PUBLIC_ASSET_PATHS instanceof Set)) {
    throw new TypeError('pwa-public-shell-contract-invalid');
  }
  for (const asset of PWA_COMPOSITION_PUBLIC_SHELL_ASSETS) {
    if (!pwaDeviceService.PWA_PUBLIC_ASSET_PATHS.has(asset)) {
      throw new Error(`pwa-public-shell-contract-missing:${asset}`);
    }
  }
  if (typeof pwaPhotoService.startRetentionScheduler !== 'function' || typeof pwaPhotoService.stopRetentionScheduler !== 'function') {
    throw new TypeError('pwa-photo-retention-lifecycle-contract-invalid');
  }

  const services = Object.freeze({
    device:pwaDeviceService,
    event:pwaEventService,
    photo:pwaPhotoService,
    webauthn:webauthnService,
    notification:pwaNotification,
    share,
    media:photo,
    settings:contextDomain(context, 'settings'),
    notificationCenter,
  });

  // Validate the deferred bridges without mutating them. The server creates several
  // services before the concrete PWA domains; a failed PWA bootstrap must not leave
  // those bridges pointing at orphaned half-composed services.
  registry.validate('device', pwaDeviceService);
  registry.validate('photo', pwaPhotoService);
  registry.validate('webauthn', webauthnService);
  registry.validate('event', pwaEventService);

  // Allocate the retention timers before mutating Express or publishing services.
  // If the runtime cannot allocate a timer (resource pressure / embedder failure),
  // bootstrap fails without leaving routes or deferred-service slots half installed.
  pwaPhotoService.startRetentionScheduler();
  let committed = false;
  try {
    // attachPwaRoutes validates the complete service/facade contract before its first
    // route registration. No registry/context publication happens until it succeeds.
    attachPwaRoutes({
      app,
      rootDir,
      services,
      facades:pwaRouteFacades,
      live:routeLiveBindings,
    });

    registry.bind('device', pwaDeviceService);
    registry.bind('photo', pwaPhotoService);
    registry.bind('webauthn', webauthnService);
    registry.bind('event', pwaEventService);

    context.register('pwa-device', pwaDeviceService);
    context.register('pwa-photo', pwaPhotoService);
    context.register('pwa-webauthn', webauthnService);
    context.register('pwa-event', pwaEventService);
    committed = true;
  } finally {
    if (!committed) pwaPhotoService.stopRetentionScheduler();
  }

  function stop() {
    pwaPhotoService.stopRetentionScheduler();
  }

  return Object.freeze({
    device:pwaDeviceService,
    photo:pwaPhotoService,
    webauthn:webauthnService,
    event:pwaEventService,
    pairTickets:pwaDeviceService.pwaPairTickets,
    routeFacades:pwaRouteFacades,
    routeLiveBindings,
    stop,
  });
}

module.exports = {
  PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED,
  PWA_COMPOSITION_PUBLIC_SHELL_ASSETS,
  PWA_CONTEXT_DOMAIN_TARGETS,
  PWA_REGISTRY_SERVICE_TARGETS,
  PWA_ROUTE_FACADE_CONTEXT,
  bindStableServiceMethod,
  createPwaApplication,
  createPwaDocumentHeaders,
  createPwaRouteFacades,
  createPwaRouteLiveBindings,
  mergeStableFacade,
  projectContextGroup,
};
