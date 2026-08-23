'use strict';

/**
 * Public HTTP composition boundary for Direct-Xfer.
 *
 * Owns the visitor page renderers, public-link access/anti-abuse second phase,
 * Web Storage read/write helpers, late download-service composition and the
 * read-only public share router. Writable reception/collaboration routes stay in
 * their dedicated boundary because they depend on upload state composed later.
 */
const {
  esc, jsonForScript, formatBytes, encodePath, mapLimit, flagFromCode, timingSafeEqualStr,
} = require('../core-utils');
const { previewInfo, imageContentType, photoExt, imageDimensions } = require('../photo-utils');
const { SUBTITLE_MAX_BYTES, srtToVtt, subtitleTracksFor } = require('../subtitle-utils');
const { readZipEntries, readFileCapped } = require('../file-content-utils');
const { renderKind, highlightCode, renderMarkdown } = require('../text-render');
const {
  cleanRelativePath:cleanConnectorPath,
  connectorErrorCode,
} = require('../storage-connectors');
const { createWebStorageShareTools } = require('../web-storage-share');
const {
  createWebStorageWritableTools,
  createWebStorageUploadHandler,
  connectorStatus:webStorageConnectorStatus,
} = require('../web-storage-writable');
const { createPublicPages } = require('./public-pages');
const { createPublicShareRoutes } = require('./public-share-routes');

const VISITOR_FEEDBACK_MAX = 200;
const PUBLIC_CONTEXT_DOMAINS = Object.freeze([
  'public-pages', 'public-access', 'public-abuse', 'public-share',
]);

function requiredObject(value, label) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Array.isArray(value)) {
    throw new TypeError(`public-http application requires ${label}`);
  }
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`public-http application requires ${label}`);
  return value;
}

function requiredMethods(source, label, names) {
  requiredObject(source, label);
  for (const name of names) requiredFunction(source[name], `${label}.${name}()`);
  return source;
}

function method(source, name, label) {
  requiredObject(source, label);
  const value = source[name];
  if (typeof value !== 'function') throw new TypeError(`public-http application requires ${label}.${name}()`);
  return value.bind(source);
}

function requiredValue(source, name, label) {
  requiredObject(source, label);
  const value = source[name];
  if (value === undefined || value === null) throw new TypeError(`public-http application requires ${label}.${name}`);
  return value;
}

function createPublicHttpApplication(options = {}) {
  const applicationContext = requiredObject(options.applicationContext, 'application context');
  for (const name of ['current', 'registerMany']) requiredFunction(applicationContext[name], `application context.${name}()`);

  const config = requiredObject(options.config, 'config');
  const requestContext = requiredObject(options.requestContext, 'requestContext');
  const request = requiredObject(options.request, 'request adapters');
  const state = requiredObject(options.state, 'state adapters');
  const storage = requiredObject(options.storage, 'storage adapters');
  const services = requiredObject(options.services, 'domain services');
  const pwa = requiredObject(options.pwa, 'PWA adapters');
  const bridges = requiredObject(options.bridges, 'late bridges');
  const platform = requiredObject(options.platform, 'platform');

  const express = requiredFunction(platform.express, 'platform.express');
  if (typeof express.Router !== 'function') throw new TypeError('public-http application requires Express.Router');
  const clientIp = requiredFunction(request.clientIp, 'request.clientIp()');
  const parseCookies = requiredFunction(request.parseCookies, 'request.parseCookies()');
  const getState = requiredFunction(state.getState, 'state.getState()');
  const getSettings = requiredFunction(state.getSettings, 'state.getSettings()');
  const persistNow = requiredFunction(state.persistNow, 'state.persistNow()');
  const scheduleFlush = requiredFunction(state.scheduleFlush, 'state.scheduleFlush()');
  const storageConnectorService = requiredObject(storage.storageConnectorService, 'storage.storageConnectorService');
  const onDownloadComplete = requiredFunction(bridges.onDownloadComplete, 'bridges.onDownloadComplete()');
  const receptionThreadEnabled = requiredFunction(bridges.receptionThreadEnabled, 'bridges.receptionThreadEnabled()');
  const stampPhotoUploadDevice = requiredFunction(pwa.stampPhotoUploadDevice, 'pwa.stampPhotoUploadDevice()');

  const securityAuthApplication = requiredObject(services.securityAuthApplication, 'services.securityAuthApplication');
  const shareMediaTransferApplication = requiredObject(services.shareMediaTransferApplication, 'services.shareMediaTransferApplication');
  const shareService = requiredObject(shareMediaTransferApplication.shareService, 'share service');
  const photoService = requiredObject(shareMediaTransferApplication.photoService, 'photo service');
  const searchService = requiredObject(shareMediaTransferApplication.searchService, 'search service');
  const sharePresentationService = requiredObject(services.sharePresentationService, 'services.sharePresentationService');
  const activityPresenceService = requiredObject(services.activityPresenceService, 'services.activityPresenceService');
  const networkServices = requiredObject(services.networkServices, 'services.networkServices');
  const notificationService = requiredObject(services.notificationService, 'services.notificationService');
  const notificationCenterService = requiredObject(services.notificationCenterService, 'services.notificationCenterService');
  const hostPathService = requiredObject(services.hostPathService, 'services.hostPathService');

  // Preflight the full static contract before entering either stateful second phase
  // (public security and download-service initialization). A late wiring error must
  // not leave a cleanup timer, security runtime, or download runtime half-published.
  for (const name of [
    'APP_NAME', 'APP_VERSION', 'APP_YEAR', 'WEB_STORAGE_STAT_CACHE_MS',
    'ACCESS_REQUESTS_MAX', 'FULL_IMAGES_DIR', 'HOST_ROOT', 'IMAGE_MAX_BYTES',
    'PWA_IMG_EXT', 'SECRETS_DIR',
  ]) requiredValue(config, name, 'config');
  requiredMethods(storageConnectorService, 'storage.storageConnectorService', [
    'stat', 'list', 'exportFile', 'mkdir', 'remove',
  ]);
  requiredMethods(securityAuthApplication, 'security-auth application', ['initializePublicSecurity']);
  requiredObject(securityAuthApplication.authService, 'administrator auth service');
  requiredMethods(shareMediaTransferApplication, 'share-media-transfer application', ['initializeDownloadService']);
  requiredMethods(shareService, 'share service', [
    'zipAllowed', 'parseMaxVisitors', 'linkPrefix', 'shareEffectiveExpiry', 'addShare',
    'bandwidthCapReached', 'bumpViews', 'clampIndex', 'detachActiveShare',
    'destroyShareManagedData', 'getByToken', 'incrementDownloads', 'ipDownloadQuotaBlocked',
    'isActive', 'isScheduled', 'recordAndCheckVisitor', 'recordRecipientView', 'shareItems',
  ]);
  requiredMethods(photoService, 'photo service', [
    'firstExistingPhotoFile', 'notePhotoView', 'photoAdaptivePath', 'photoCacheRevision',
    'photoOriginalPaths', 'photoVariantPaths', 'streamToFileBounded',
  ]);
  requiredMethods(searchService, 'search service', ['scheduleReindex']);
  requiredMethods(sharePresentationService, 'share-presentation service', ['primaryBase']);
  requiredMethods(activityPresenceService, 'activity service', ['pubIp', 'emitLiveActivity', 'maskIp']);
  requiredMethods(networkServices, 'network services', ['geolocate', 'geoSync']);
  requiredMethods(notificationService, 'notification service', ['notify']);
  requiredMethods(notificationCenterService, 'notification-center service', ['addShareCenterNotification']);
  requiredMethods(hostPathService, 'host-path service', ['assertRealWithin', 'hostToContainer', 'resolveWithin']);

  const recipientByToken = requiredValue(shareService, 'recipientByToken', 'share service');
  if (!recipientByToken || typeof recipientByToken.get !== 'function') {
    throw new TypeError('public-http application requires share service.recipientByToken Map-like value');
  }
  const zipAllowed = method(shareService, 'zipAllowed', 'share service');
  const parseMaxVisitors = method(shareService, 'parseMaxVisitors', 'share service');
  const linkPrefix = method(shareService, 'linkPrefix', 'share service');
  const shareEffectiveExpiry = method(shareService, 'shareEffectiveExpiry', 'share service');

  const publicPages = requiredObject(createPublicPages({
    APP_NAME:requiredValue(config, 'APP_NAME', 'config'),
    APP_VERSION:requiredValue(config, 'APP_VERSION', 'config'),
    APP_YEAR:requiredValue(config, 'APP_YEAR', 'config'),
    requestContext,
    recipientByToken,
    pubIp:method(activityPresenceService, 'pubIp', 'activity service'),
    linkPrefix,
    shareEffectiveExpiry,
    getSettings,
    clientIp,
    parseCookies,
    receptionThreadEnabled,
    parseMaxVisitors,
    zipAllowed,
    esc,
    jsonForScript,
    formatBytes,
    encodePath,
    previewInfo,
    subtitleTracksFor,
    renderKind,
    renderMarkdown,
  }), 'public pages');

  const {
    PUB, pickLang, previewWatermark, pageShell, collectionPage, filePage,
    encDecryptPage, secretPage, folderPage, webStorageFolderPage, errorPage, albumPage,
    mediaPlayerPage, passwordPage, accessRequestPage, challengePage,
  } = publicPages;
  for (const [name, value] of Object.entries({
    pickLang, previewWatermark, pageShell, collectionPage, filePage, encDecryptPage,
    secretPage, folderPage, webStorageFolderPage, errorPage, albumPage,
    mediaPlayerPage, passwordPage, accessRequestPage, challengePage,
  })) requiredFunction(value, `public pages.${name}()`);
  requiredObject(PUB, 'public pages.PUB');

  const initializePublicSecurity = requiredFunction(
    securityAuthApplication.initializePublicSecurity,
    'security-auth application.initializePublicSecurity()'
  );
  const { publicAccessService, publicAbuseService } = initializePublicSecurity.call(securityAuthApplication, {
    pages:{ errorPage, pickLang, challengePage },
  });
  requiredObject(publicAccessService, 'public access service');
  requiredObject(publicAbuseService, 'public abuse service');

  const hasAccessRules = method(publicAccessService, 'hasAccessRules', 'public access service');
  const linkAccessReason = method(publicAccessService, 'linkAccessReason', 'public access service');
  const checkSharePassword = method(publicAccessService, 'checkSharePassword', 'public access service');
  const upgradeLegacySharePassword = method(publicAccessService, 'upgradeLegacySharePassword', 'public access service');
  const sendPasswordWorkHtml = method(publicAccessService, 'sendPasswordWorkHtml', 'public access service');
  const isUnlocked = method(publicAccessService, 'isUnlocked', 'public access service');
  const setUnlockCookie = method(publicAccessService, 'setUnlockCookie', 'public access service');
  const pendingAccessRequest = method(publicAccessService, 'pendingAccessRequest', 'public access service');
  const isAccessApproved = method(publicAccessService, 'isAccessApproved', 'public access service');
  const setAccessRequestCookie = method(publicAccessService, 'setAccessRequestCookie', 'public access service');
  const beginUnlockAttempt = method(publicAccessService, 'beginUnlockAttempt', 'public access service');
  const noteUnlockFailure = method(publicAccessService, 'noteUnlockFailure', 'public access service');
  const noteUnlockSuccess = method(publicAccessService, 'noteUnlockSuccess', 'public access service');
  const finishUnlockAttempt = method(publicAccessService, 'finishUnlockAttempt', 'public access service');
  const unlockFails = requiredValue(publicAccessService, 'unlockFails', 'public access service');
  if (!(unlockFails instanceof Map)) throw new TypeError('public-http application requires public access unlockFails Map');

  const snapshotPublicMessageDecision = method(publicAbuseService, 'snapshotPublicMessageDecision', 'public abuse service');
  const restorePublicMessageDecision = method(publicAbuseService, 'restorePublicMessageDecision', 'public abuse service');
  const publicMessageDecision = method(publicAbuseService, 'publicMessageDecision', 'public abuse service');
  const publicRateRetryAfter = method(publicAbuseService, 'publicRateRetryAfter', 'public abuse service');
  const challengeRequired = method(publicAbuseService, 'challengeRequired', 'public abuse service');
  const createPowChallenge = method(publicAbuseService, 'createPowChallenge', 'public abuse service');
  const verifyPowChallenge = method(publicAbuseService, 'verifyPowChallenge', 'public abuse service');
  const hasValidPow = method(publicAbuseService, 'hasValidPow', 'public abuse service');
  const issuePowCookie = method(publicAbuseService, 'issuePowCookie', 'public abuse service');
  const challengeGateZip = method(publicAbuseService, 'challengeGateZip', 'public abuse service');
  const PUBLIC_MESSAGE_DUP_MS = Number(requiredValue(publicAbuseService, 'publicMessageDupMs', 'public abuse service'));
  if (!Number.isFinite(PUBLIC_MESSAGE_DUP_MS) || PUBLIC_MESSAGE_DUP_MS < 0) {
    throw new TypeError('public-http application requires a finite public abuse duplicate-message window');
  }

  function sendError(req, res, code, key) {
    const lang = pickLang(req);
    const L = PUB[lang] || PUB.en;
    res.status(code).type('html').send(errorPage(lang, code, L[key] || key));
  }

  const webStorageTools = createWebStorageShareTools({
    storageConnectorService,
    cacheMs:requiredValue(config, 'WEB_STORAGE_STAT_CACHE_MS', 'config'),
  });
  const {
    shareMeta:webStorageShareMeta,
    importMeta:webStorageImportMeta,
    joinedPath:webStorageJoinedPath,
    stat:webStorageStat,
    list:webStorageList,
    walkFiles:webStorageWalkFiles,
    invalidate:webStorageInvalidate,
    etag:webStorageEtag,
    parseRange:parseWebStorageRange,
    clearCache:webStorageClearCache,
    isBusyForStateReplacement:webStorageReadBusy,
  } = webStorageTools;
  for (const [name, value] of Object.entries({
    webStorageShareMeta, webStorageImportMeta, webStorageJoinedPath, webStorageStat,
    webStorageList, webStorageWalkFiles, webStorageInvalidate, webStorageEtag,
    parseWebStorageRange, webStorageClearCache, webStorageReadBusy,
  })) requiredFunction(value, `Web Storage ${name}()`);

  const webStorageWritable = createWebStorageWritableTools({
    storageConnectorService,
    shareMeta:webStorageShareMeta,
    joinedPath:webStorageJoinedPath,
    stat:webStorageStat,
    invalidate:webStorageInvalidate,
  });
  requiredObject(webStorageWritable, 'Web Storage writable tools');
  const webStorageWriteBusy = method(webStorageWritable, 'isBusyForStateReplacement', 'Web Storage writable tools');

  const initializeDownloadService = requiredFunction(
    shareMediaTransferApplication.initializeDownloadService,
    'share-media-transfer application.initializeDownloadService()'
  );
  const downloadService = initializeDownloadService.call(shareMediaTransferApplication, {
    publicSecurity:{ challengeRequired, hasValidPow, challengeGateZip },
    pages:{ sendError, challengePage, pickLang },
    lifecycle:{ onDownloadComplete },
    webStorage:{
      storageConnectorService,
      connectorErrorCode,
      shareMeta:webStorageShareMeta,
      joinedPath:webStorageJoinedPath,
      stat:webStorageStat,
      etag:webStorageEtag,
      parseRange:parseWebStorageRange,
    },
  });
  requiredObject(downloadService, 'download service');
  const streamFile = method(downloadService, 'streamFile', 'download service');
  const streamZip = method(downloadService, 'streamZip', 'download service');
  const streamZipFiles = method(downloadService, 'streamZipFiles', 'download service');
  const serveWebStorageFile = method(downloadService, 'serveWebStorageFile', 'download service');
  const validDownloadResumeId = method(downloadService, 'validDownloadResumeId', 'download service');
  const pruneDownloadResumeSessions = method(downloadService, 'pruneDownloadResumeSessions', 'download service');
  const clearDownloadRuntimeState = method(downloadService, 'clearRuntimeState', 'download service');

  function isBusyForStateReplacement() {
    return !!webStorageReadBusy() || !!webStorageWriteBusy();
  }

  function clearRuntimeState() {
    const failures = [];
    for (const [name, callback] of [
      ['web-storage-cache', webStorageClearCache],
      ['downloads', clearDownloadRuntimeState],
    ]) {
      try { callback(); }
      catch (error) { failures.push({ name, error }); }
    }
    if (failures.length) {
      const error = new Error('public-http-runtime-reset-failed: ' + failures.map((failure) => failure.name).join(','));
      error.code = 'PUBLIC_HTTP_RUNTIME_RESET_FAILED';
      error.failures = failures;
      throw error;
    }
  }

  const publicShareRoutes = createPublicShareRoutes({
    ACCESS_REQUESTS_MAX:requiredValue(config, 'ACCESS_REQUESTS_MAX', 'config'),
    FULL_IMAGES_DIR:requiredValue(config, 'FULL_IMAGES_DIR', 'config'),
    HOST_ROOT:requiredValue(config, 'HOST_ROOT', 'config'),
    IMAGE_MAX_BYTES:requiredValue(config, 'IMAGE_MAX_BYTES', 'config'),
    PUB,
    PUBLIC_MESSAGE_DUP_MS,
    PWA_IMG_EXT:requiredValue(config, 'PWA_IMG_EXT', 'config'),
    SECRETS_DIR:requiredValue(config, 'SECRETS_DIR', 'config'),
    SUBTITLE_MAX_BYTES,
    VISITOR_FEEDBACK_MAX,
    accessRequestPage,
    albumPage,
    addShare:method(shareService, 'addShare', 'share service'),
    addShareCenterNotification:method(notificationCenterService, 'addShareCenterNotification', 'notification-center service'),
    assertRealWithin:method(hostPathService, 'assertRealWithin', 'host-path service'),
    authService:requiredObject(securityAuthApplication.authService, 'administrator auth service'),
    bandwidthCapReached:method(shareService, 'bandwidthCapReached', 'share service'),
    beginUnlockAttempt,
    bumpViews:method(shareService, 'bumpViews', 'share service'),
    challengeGateZip,
    checkSharePassword,
    clampIndex:method(shareService, 'clampIndex', 'share service'),
    createPowChallenge,
    cleanConnectorPath,
    clientIp,
    collectionPage,
    connectorErrorCode,
    detachActiveShare:method(shareService, 'detachActiveShare', 'share service'),
    destroyShareManagedData:method(shareService, 'destroyShareManagedData', 'share service'),
    emitLiveActivity:method(activityPresenceService, 'emitLiveActivity', 'activity service'),
    encDecryptPage,
    encodePath,
    errorPage,
    esc,
    express,
    filePage,
    firstExistingPhotoFile:method(photoService, 'firstExistingPhotoFile', 'photo service'),
    flagFromCode,
    finishUnlockAttempt,
    folderPage,
    formatBytes,
    geolocate:method(networkServices, 'geolocate', 'network services'),
    geoSync:method(networkServices, 'geoSync', 'network services'),
    getByToken:method(shareService, 'getByToken', 'share service'),
    getSettings,
    getState,
    hasAccessRules,
    highlightCode,
    hostToContainer:method(hostPathService, 'hostToContainer', 'host-path service'),
    imageContentType,
    imageDimensions,
    incrementDownloads:method(shareService, 'incrementDownloads', 'share service'),
    issuePowCookie,
    ipDownloadQuotaBlocked:method(shareService, 'ipDownloadQuotaBlocked', 'share service'),
    isAccessApproved,
    isActive:method(shareService, 'isActive', 'share service'),
    isScheduled:method(shareService, 'isScheduled', 'share service'),
    isUnlocked,
    linkAccessReason,
    linkPrefix,
    mapLimit,
    maskIp:method(activityPresenceService, 'maskIp', 'activity service'),
    mediaPlayerPage,
    notePhotoView:method(photoService, 'notePhotoView', 'photo service'),
    noteUnlockFailure,
    noteUnlockSuccess,
    notify:method(notificationService, 'notify', 'notification service'),
    pageShell,
    passwordPage,
    pendingAccessRequest,
    persistNow,
    photoAdaptivePath:method(photoService, 'photoAdaptivePath', 'photo service'),
    photoCacheRevision:method(photoService, 'photoCacheRevision', 'photo service'),
    photoExt,
    photoOriginalPaths:method(photoService, 'photoOriginalPaths', 'photo service'),
    photoVariantPaths:method(photoService, 'photoVariantPaths', 'photo service'),
    pickLang,
    previewInfo,
    previewWatermark,
    primaryBase:method(sharePresentationService, 'primaryBase', 'share-presentation service'),
    pubIp:method(activityPresenceService, 'pubIp', 'activity service'),
    publicMessageDecision,
    publicRateRetryAfter,
    readFileCapped,
    readZipEntries,
    recipientByToken,
    recordAndCheckVisitor:method(shareService, 'recordAndCheckVisitor', 'share service'),
    recordRecipientView:method(shareService, 'recordRecipientView', 'share service'),
    renderKind,
    renderMarkdown,
    resolveWithin:method(hostPathService, 'resolveWithin', 'host-path service'),
    restorePublicMessageDecision,
    scheduleFlush,
    scheduleSearchReindex:method(searchService, 'scheduleReindex', 'search service'),
    secretPage,
    sendError,
    sendPasswordWorkHtml,
    serveWebStorageFile,
    setAccessRequestCookie,
    setUnlockCookie,
    shareEffectiveExpiry,
    shareItems:method(shareService, 'shareItems', 'share service'),
    snapshotPublicMessageDecision,
    srtToVtt,
    stampPhotoUploadDevice,
    streamFile,
    streamToFileBounded:method(photoService, 'streamToFileBounded', 'photo service'),
    streamZip,
    streamZipFiles,
    timingSafeEqualStr,
    upgradeLegacySharePassword,
    verifyPowChallenge,
    webStorageFolderPage,
    webStorageList,
    webStorageShareMeta,
    webStorageStat,
    zipAllowed,
  });
  requiredObject(publicShareRoutes, 'public share routes');
  const downloadRouter = requiredValue(publicShareRoutes, 'downloadRouter', 'public share routes');
  if (typeof downloadRouter !== 'function' && (!downloadRouter || typeof downloadRouter.handle !== 'function')) {
    throw new TypeError('public-http application requires public share downloadRouter');
  }
  const parseHotlinkHosts = method(publicShareRoutes, 'parseHotlinkHosts', 'public share routes');

  function applicationDomainEntries() {
    return Object.freeze([
      ['public-pages', publicPages],
      ['public-access', publicAccessService],
      ['public-abuse', publicAbuseService],
      ['public-share', publicShareRoutes],
    ].map((entry) => Object.freeze(entry)));
  }

  let domainPhase = 'idle';
  let domainFailure = null;
  function registerApplicationDomains() {
    if (domainPhase === 'ready') return;
    if (domainPhase === 'registering') throw new Error('public-http domain registration is already in progress');
    if (domainPhase === 'failed') {
      const error = new Error('public-http domain registration previously failed; restart is required');
      if (domainFailure) error.cause = domainFailure;
      throw error;
    }
    const applicationDomains = applicationDomainEntries();
    let published = 0;
    for (const [name, service] of applicationDomains) {
      requiredObject(service, `application domain ${name}`);
      const current = applicationContext.current(name);
      if (current === service) { published += 1; continue; }
      if (current != null) throw new Error(`public-http application domain is already registered: ${name}`);
    }
    if (published === applicationDomains.length) {
      domainFailure = null;
      domainPhase = 'ready';
      return;
    }
    if (published !== 0) {
      for (const [name] of applicationDomains) {
        if (applicationContext.current(name) != null) throw new Error(`public-http application domain is already registered: ${name}`);
      }
      throw new Error('public-http application domains are only partially published');
    }
    domainPhase = 'registering';
    try {
      applicationContext.registerMany(applicationDomains);
      domainFailure = null;
      domainPhase = 'ready';
    } catch (error) {
      domainFailure = error;
      domainPhase = 'failed';
      throw error;
    }
  }

  return Object.freeze({
    VISITOR_FEEDBACK_MAX,
    publicPages,
    publicAccessService,
    publicAbuseService,
    publicShareRoutes,
    downloadService,
    sendError,
    webStorageShareMeta,
    webStorageImportMeta,
    webStorageStat,
    webStorageList,
    webStorageWalkFiles,
    webStorageWritable,
    webStorageConnectorStatus,
    createWebStorageUploadHandler,
    validDownloadResumeId,
    pruneDownloadResumeSessions,
    clearDownloadRuntimeState,
    clearRuntimeState,
    isBusyForStateReplacement,
    unlockFails,
    downloadRouter,
    parseHotlinkHosts,
    applicationDomainEntries,
    registerApplicationDomains,
  });
}

module.exports = {
  PUBLIC_CONTEXT_DOMAINS,
  VISITOR_FEEDBACK_MAX,
  createPublicHttpApplication,
};
