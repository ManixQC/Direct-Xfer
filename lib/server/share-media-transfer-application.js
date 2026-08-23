'use strict';

/**
 * Share/media/transfer composition boundary for Direct-Xfer.
 *
 * Owns construction and cross-wiring of the share, managed-photo, OCR/search/DLP
 * and transfer-accounting services. Download delivery is composed explicitly in
 * a second phase after public-link security and page renderers exist.
 *
 * The underlying domain services remain the owners of mutable runtime state. This
 * module only owns dependency wiring, compatibility projections and startup order.
 */
const { createShareService } = require('./share-service');
const { createPhotoService } = require('./photo-service');
const { createOcrService } = require('./ocr-service');
const { createSearchService } = require('./search-service');
const { createDlpService } = require('./dlp-service');
const { createTransferService } = require('./transfer-service');
const { createDownloadService } = require('./download-service');

const SHARE_MEDIA_CONTEXT_DOMAINS = Object.freeze([
  'share', 'photo', 'ocr', 'search', 'search-compat', 'dlp', 'transfer', 'download',
]);

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`share-media-transfer application requires ${name}`);
  }
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`share-media-transfer application requires ${name}()`);
  }
  return value;
}

function requiredValue(value, name) {
  if (value == null) throw new TypeError(`share-media-transfer application requires ${name}`);
  return value;
}

function requiredFunctions(source, label, names) {
  for (const name of names) requiredFunction(source && source[name], `${label}.${name}`);
}

function requiredValues(source, label, names) {
  for (const name of names) requiredValue(source && source[name], `${label}.${name}`);
}

function lazyServiceMethod(getService, serviceName, methodName) {
  return (...args) => {
    const service = getService();
    if (!service || typeof service[methodName] !== 'function') {
      throw new Error(`share-media-transfer application ${serviceName}.${methodName} is not ready`);
    }
    return service[methodName](...args);
  };
}

const SEARCH_COMPAT_MAP = Object.freeze({
  buildUniversalSearchIndex:'buildIndex',
  universalSearchStatus:'status',
  universalSearchScopedStatus:'scopedStatus',
  universalSearchVisibleDocs:'visibleDocs',
  universalSearchShareEligible:'universalSearchShareEligible',
  universalSearchQuery:'query',
  universalSemanticSearchQuery:'semanticQuery',
  globalMetadataSearch:'metadataSearch',
  looksLikeTextBuffer:'looksLikeTextBuffer',
  initUniversalSearchIndex:'init',
});

const SHARE_FACADE_METHODS = Object.freeze([
  'reindex', 'isScheduled', 'linkPrefix', 'addShare', 'restorePlainObject',
  'shareBackingHealthSnapshot', 'queueShareBackingHealthRefresh', 'migrateLegacyFirstUseExpiryState',
  'trashItems', 'detachActiveShare', 'sanitizeUndoLog', 'destroyShareManagedData', 'purgeTrashRecordById',
  'incrementDownloads', 'shareItems', 'recordAndCheckVisitor', 'ipDownloadQuotaBlocked',
  'commitManagedIpDownload', 'noteBytesServed', 'bandwidthCapReached', 'bumpViews',
  'recordRecipientView', 'runExpiredLinkLifecycle',
]);

function createShareMediaTransferApplication(options = {}) {
  const applicationContext = requiredObject(options.applicationContext, 'applicationContext');
  requiredFunctions(applicationContext, 'applicationContext', ['bind', 'registerMany', 'current']);
  const platform = requiredObject(options.platform, 'platform');
  const config = requiredObject(options.config, 'config');
  const state = requiredObject(options.state, 'state adapters');
  const paths = requiredObject(options.paths, 'path adapters');
  const account = requiredObject(options.account, 'account adapters');
  const presentation = requiredObject(options.presentation, 'presentation adapters');
  const activity = requiredObject(options.activity, 'activity adapters');
  const network = requiredObject(options.network, 'network adapters');
  const notification = requiredObject(options.notification, 'notification adapters');
  const pwa = requiredObject(options.pwa, 'PWA adapters');
  const bridges = requiredObject(options.bridges, 'late bridges');
  const constants = requiredObject(options.constants, 'runtime constants');

  // Validate the complete first-phase contract before constructing any domain
  // service. A late wiring typo must not leave a partially composed service graph.
  requiredValues(config, 'config', [
    'HOST_ROOT', 'INBOX_DIR', 'PENDING_DIR', 'ENC_DIR', 'IMAGE_STORE_DIR',
    'FULL_IMAGES_DIR', 'THUMBS_DIR', 'MICROS_DIR', 'PHOTO_HISTORY_DIR',
    'PHOTO_VERSIONS_DIR', 'ADAPTIVE_IMAGES_DIR', 'LEGACY_IMAGES_DIR',
    'LEGACY_THUMBS_DIR', 'LEGACY_MICROS_DIR', 'LEGACY_PHOTO_HISTORY_DIR',
    'DATA_DIR', 'DLP_QUARANTINE_DIR', 'LOG_FILE',
  ]);
  requiredFunctions(state, 'state', [
    'getState', 'getSettings', 'persist', 'persistNow', 'scheduleFlush',
    'setSettingsDurable', 'encryptStore', 'deserializeStore',
  ]);
  requiredFunctions(paths, 'paths', ['hostToContainer', 'containerToHost', 'assertRealWithin', 'resolveWithin']);
  requiredFunctions(account, 'account', ['accountList', 'getAccountById', 'findAccountByName', 'normUsername']);
  requiredFunctions(presentation, 'presentation', ['primaryBase', 'decorateShare']);
  requiredFunctions(activity, 'activity', [
    'pubIp', 'maskIp', 'emitLiveActivity', 'ipNameFor',
    'schedulePresenceBroadcast', 'bumpHistoryViewRevision',
  ]);
  requiredFunctions(network, 'network', ['clientIp', 'geoSync', 'geolocate', 'flagFromCode']);
  requiredFunctions(notification, 'notification', [
    'accountCustomNotificationRules', 'pruneCustomNotificationRuleStateForShareId',
    'addShareCenterNotification', 'maybeNotifyDownloadThreshold', 'maybeCenterDownloadMilestone',
    'maybeCenterReceptionQuota', 'evaluateCustomNotificationRulesForShare', 'noteCenterAutoDisabled',
    'logAudit', 'auditReq', 'addAdminCenterNotification', 'centerShareEligibleForVisitorNotification',
    'noteCenterCountry', 'maybeCenterViewThreshold', 'noteCenterVisitorDevice', 'noteCenterViral',
    'noteCenterActivity', 'enrichFirstViewCenterNotification', 'notifyFirstPhotoView',
    'noteCenterServiceState', 'addRequestCenterNotification', 'noteCenterRepeatedDownload',
    'noteCenterHighVolume', 'notify', 'noteLeakSignal', 'noteCenterSharedFileSignature',
    'noteCenterConcurrentDownloadStart',
  ]);
  requiredFunctions(pwa, 'pwa', [
    'activityPrincipal', 'pwaDeviceResolvedAccount', 'canManagePwaImage', 'shareOwnerAccount',
    'getPwaPublicDevice', 'pwaDeviceCreatorAccount', 'pwaDeviceOwnerAccount',
    'requestClientDeviceName', 'cleanDeviceLabel',
  ]);
  requiredFunctions(bridges, 'bridges', [
    'folderMetrics', 'resolveHostItem', 'webStorageShareMeta', 'webStorageStat',
    'currentAccount', 'getSession', 'validDownloadResumeId', 'pruneDownloadResumeSessions',
    'ownsShare', 'dataWritable',
  ]);

  const fs = requiredObject(platform.fs, 'platform.fs');
  const crypto = requiredObject(platform.crypto, 'platform.crypto');
  const getState = requiredFunction(state.getState, 'state.getState');
  const getSettings = requiredFunction(state.getSettings, 'state.getSettings');
  const persist = requiredFunction(state.persist, 'state.persist');
  const persistNow = requiredFunction(state.persistNow, 'state.persistNow');
  const scheduleFlush = requiredFunction(state.scheduleFlush, 'state.scheduleFlush');
  const encryptStore = requiredFunction(state.encryptStore, 'state.encryptStore');
  const deserializeStore = requiredFunction(state.deserializeStore, 'state.deserializeStore');

  const hostToContainer = requiredFunction(paths.hostToContainer, 'paths.hostToContainer');
  const containerToHost = requiredFunction(paths.containerToHost, 'paths.containerToHost');
  const assertRealWithin = requiredFunction(paths.assertRealWithin, 'paths.assertRealWithin');
  const resolveWithin = requiredFunction(paths.resolveWithin, 'paths.resolveWithin');

  const clientIp = requiredFunction(network.clientIp, 'network.clientIp');
  const geoSync = requiredFunction(network.geoSync, 'network.geoSync');
  const geolocate = requiredFunction(network.geolocate, 'network.geolocate');
  const pubIp = requiredFunction(activity.pubIp, 'activity.pubIp');
  const maskIp = requiredFunction(activity.maskIp, 'activity.maskIp');
  const emitLiveActivity = requiredFunction(activity.emitLiveActivity, 'activity.emitLiveActivity');

  // Circular share <-> photo/search/transfer dependencies are intentionally lazy.
  // No domain constructor is allowed to freeze a sibling service reference before
  // that sibling has completed construction.
  let photoService = null;
  let searchService = null;
  let transferService = null;

  const shareService = createShareService({
    HOST_ROOT:requiredValue(config.HOST_ROOT, 'config.HOST_ROOT'),
    INBOX_DIR:requiredValue(config.INBOX_DIR, 'config.INBOX_DIR'),
    PENDING_DIR:requiredValue(config.PENDING_DIR, 'config.PENDING_DIR'),
    ENC_DIR:requiredValue(config.ENC_DIR, 'config.ENC_DIR'),
    UNDO_LOG_MAX:constants.UNDO_LOG_MAX,
    UNDO_DESCRIPTOR_MAX_BYTES:config.UNDO_DESCRIPTOR_MAX_BYTES,
    getState, getSettings, persist, persistNow, scheduleFlush,
    hostToContainer, containerToHost, assertRealWithin, resolveWithin,
    folderMetrics:requiredFunction(bridges.folderMetrics, 'bridges.folderMetrics'),
    resolveHostItem:requiredFunction(bridges.resolveHostItem, 'bridges.resolveHostItem'),
    photoStatsOf:lazyServiceMethod(() => photoService, 'photoService', 'photoStatsOf'),
    firstExistingPhotoFile:lazyServiceMethod(() => photoService, 'photoService', 'firstExistingPhotoFile'),
    photoOriginalPaths:lazyServiceMethod(() => photoService, 'photoService', 'photoOriginalPaths'),
    photoVariantPaths:lazyServiceMethod(() => photoService, 'photoService', 'photoVariantPaths'),
    photoAdaptivePath:lazyServiceMethod(() => photoService, 'photoService', 'photoAdaptivePath'),
    photoVersionDir:lazyServiceMethod(() => photoService, 'photoService', 'photoVersionDir'),
    uniquePhotoPaths:lazyServiceMethod(() => photoService, 'photoService', 'uniquePhotoPaths'),
    webStorageShareMeta:requiredFunction(bridges.webStorageShareMeta, 'bridges.webStorageShareMeta'),
    webStorageStat:requiredFunction(bridges.webStorageStat, 'bridges.webStorageStat'),
    accountList:requiredFunction(account.accountList, 'account.accountList'),
    accountCustomNotificationRules:requiredFunction(notification.accountCustomNotificationRules, 'notification.accountCustomNotificationRules'),
    pruneCustomNotificationRuleStateForShareId:requiredFunction(notification.pruneCustomNotificationRuleStateForShareId, 'notification.pruneCustomNotificationRuleStateForShareId'),
    scheduleSearchReindex:lazyServiceMethod(() => searchService, 'searchService', 'scheduleReindex'),
    emitLiveActivity,
    activityPrincipal:requiredFunction(pwa.activityPrincipal, 'pwa.activityPrincipal'),
    getAccountById:requiredFunction(account.getAccountById, 'account.getAccountById'),
    findAccountByName:requiredFunction(account.findAccountByName, 'account.findAccountByName'),
    pwaDeviceResolvedAccount:requiredFunction(pwa.pwaDeviceResolvedAccount, 'pwa.pwaDeviceResolvedAccount'),
    canManagePwaImage:requiredFunction(pwa.canManagePwaImage, 'pwa.canManagePwaImage'),
    currentAccount:requiredFunction(bridges.currentAccount, 'bridges.currentAccount'),
    setSettingsDurable:requiredFunction(state.setSettingsDurable, 'state.setSettingsDurable'),
    pruneHistory:lazyServiceMethod(() => transferService, 'transferService', 'pruneHistory'),
    bumpHistoryViewRevision:requiredFunction(activity.bumpHistoryViewRevision, 'activity.bumpHistoryViewRevision'),
    addShareCenterNotification:requiredFunction(notification.addShareCenterNotification, 'notification.addShareCenterNotification'),
    maybeNotifyDownloadThreshold:requiredFunction(notification.maybeNotifyDownloadThreshold, 'notification.maybeNotifyDownloadThreshold'),
    maybeCenterDownloadMilestone:requiredFunction(notification.maybeCenterDownloadMilestone, 'notification.maybeCenterDownloadMilestone'),
    maybeCenterReceptionQuota:requiredFunction(notification.maybeCenterReceptionQuota, 'notification.maybeCenterReceptionQuota'),
    evaluateCustomNotificationRulesForShare:requiredFunction(notification.evaluateCustomNotificationRulesForShare, 'notification.evaluateCustomNotificationRulesForShare'),
    noteCenterAutoDisabled:requiredFunction(notification.noteCenterAutoDisabled, 'notification.noteCenterAutoDisabled'),
    logAudit:requiredFunction(notification.logAudit, 'notification.logAudit'),
    addAdminCenterNotification:requiredFunction(notification.addAdminCenterNotification, 'notification.addAdminCenterNotification'),
    clientIp, maskIp, geoSync, geolocate,
    centerShareEligibleForVisitorNotification:requiredFunction(notification.centerShareEligibleForVisitorNotification, 'notification.centerShareEligibleForVisitorNotification'),
    noteCenterCountry:requiredFunction(notification.noteCenterCountry, 'notification.noteCenterCountry'),
    maybeCenterViewThreshold:requiredFunction(notification.maybeCenterViewThreshold, 'notification.maybeCenterViewThreshold'),
    noteCenterVisitorDevice:requiredFunction(notification.noteCenterVisitorDevice, 'notification.noteCenterVisitorDevice'),
    noteCenterViral:requiredFunction(notification.noteCenterViral, 'notification.noteCenterViral'),
    noteCenterActivity:requiredFunction(notification.noteCenterActivity, 'notification.noteCenterActivity'),
    shareOwnerAccount:requiredFunction(pwa.shareOwnerAccount, 'pwa.shareOwnerAccount'),
    getSession:requiredFunction(bridges.getSession, 'bridges.getSession'),
    getPwaPublicDevice:requiredFunction(pwa.getPwaPublicDevice, 'pwa.getPwaPublicDevice'),
    pwaDeviceCreatorAccount:requiredFunction(pwa.pwaDeviceCreatorAccount, 'pwa.pwaDeviceCreatorAccount'),
    pwaDeviceOwnerAccount:requiredFunction(pwa.pwaDeviceOwnerAccount, 'pwa.pwaDeviceOwnerAccount'),
    requestClientDeviceName:requiredFunction(pwa.requestClientDeviceName, 'pwa.requestClientDeviceName'),
    cleanDeviceLabel:requiredFunction(pwa.cleanDeviceLabel, 'pwa.cleanDeviceLabel'),
    pubIp,
    flagFromCode:requiredFunction(network.flagFromCode, 'network.flagFromCode'),
    validDownloadResumeId:requiredFunction(bridges.validDownloadResumeId, 'bridges.validDownloadResumeId'),
    pruneDownloadResumeSessions:requiredFunction(bridges.pruneDownloadResumeSessions, 'bridges.pruneDownloadResumeSessions'),
  });

  const shareFacade = applicationContext.bind(shareService, SHARE_FACADE_METHODS);

  photoService = createPhotoService({
    HOST_ROOT:config.HOST_ROOT,
    IMAGE_STORE_DIR:requiredValue(config.IMAGE_STORE_DIR, 'config.IMAGE_STORE_DIR'),
    FULL_IMAGES_DIR:requiredValue(config.FULL_IMAGES_DIR, 'config.FULL_IMAGES_DIR'),
    THUMBS_DIR:requiredValue(config.THUMBS_DIR, 'config.THUMBS_DIR'),
    MICROS_DIR:requiredValue(config.MICROS_DIR, 'config.MICROS_DIR'),
    PHOTO_HISTORY_DIR:requiredValue(config.PHOTO_HISTORY_DIR, 'config.PHOTO_HISTORY_DIR'),
    PHOTO_VERSIONS_DIR:requiredValue(config.PHOTO_VERSIONS_DIR, 'config.PHOTO_VERSIONS_DIR'),
    ADAPTIVE_IMAGES_DIR:requiredValue(config.ADAPTIVE_IMAGES_DIR, 'config.ADAPTIVE_IMAGES_DIR'),
    LEGACY_IMAGES_DIR:requiredValue(config.LEGACY_IMAGES_DIR, 'config.LEGACY_IMAGES_DIR'),
    LEGACY_THUMBS_DIR:requiredValue(config.LEGACY_THUMBS_DIR, 'config.LEGACY_THUMBS_DIR'),
    LEGACY_MICROS_DIR:requiredValue(config.LEGACY_MICROS_DIR, 'config.LEGACY_MICROS_DIR'),
    LEGACY_PHOTO_HISTORY_DIR:requiredValue(config.LEGACY_PHOTO_HISTORY_DIR, 'config.LEGACY_PHOTO_HISTORY_DIR'),
    PHOTO_HISTORY_MAX:config.PHOTO_HISTORY_MAX,
    DAY_MS:constants.DAY_MS,
    getState,
    listShares:() => shareService.listShares(),
    trashItems:() => shareFacade.trashItems(),
    hostToContainer, assertRealWithin,
    getSession:bridges.getSession,
    clientIp, maskIp, geoSync, geolocate,
    noteCenterCountry:notification.noteCenterCountry,
    enrichFirstViewCenterNotification:notification.enrichFirstViewCenterNotification,
    maybeCenterViewThreshold:notification.maybeCenterViewThreshold,
    evaluateCustomNotificationRulesForShare:notification.evaluateCustomNotificationRulesForShare,
    noteCenterActivity:notification.noteCenterActivity,
    notifyFirstPhotoView:requiredFunction(notification.notifyFirstPhotoView, 'notification.notifyFirstPhotoView'),
    pubIp,
    flagFromCode:network.flagFromCode,
    scheduleFlush, persist, persistNow,
    restorePlainObject:shareFacade.restorePlainObject,
    addShareCenterNotification:notification.addShareCenterNotification,
    ownsShare:requiredFunction(bridges.ownsShare, 'bridges.ownsShare'),
    canManagePwaImage:pwa.canManagePwaImage,
    decorateShare:requiredFunction(presentation.decorateShare, 'presentation.decorateShare'),
    getSettings,
    primaryBase:requiredFunction(presentation.primaryBase, 'presentation.primaryBase'),
    isActive:(...args) => shareService.isActive(...args),
    shareEffectiveExpiry:(...args) => shareService.shareEffectiveExpiry(...args),
  });

  let searchIndexBuilding = false;
  let searchIndexError = null;
  let universalSearchIndex = { version:3, builtAt:0, docs:[] };

  const ocrService = createOcrService({
    DATA_DIR:requiredValue(config.DATA_DIR, 'config.DATA_DIR'),
    DATA_KEY:config.DATA_KEY,
    encryptStore,
    deserializeStore,
    emitLiveActivity,
    addAdminCenterNotification:notification.addAdminCenterNotification,
    indexContentCap:2 * 1024 * 1024,
    indexDocMax:config.SEARCH_INDEX_MAX_DOCS,
  });

  searchService = createSearchService({
    DATA_DIR:config.DATA_DIR,
    DATA_KEY:config.DATA_KEY,
    HOST_ROOT:config.HOST_ROOT,
    INBOX_DIR:config.INBOX_DIR,
    encryptStore,
    deserializeStore,
    getState,
    getById:(...args) => shareService.getById(...args),
    listShares:(...args) => shareService.listShares(...args),
    shareItems:shareFacade.shareItems,
    hostToContainer,
    assertRealWithin,
    resolveWithin,
    firstExistingPhotoFile:(...args) => photoService.firstExistingPhotoFile(...args),
    photoOriginalPaths:(...args) => photoService.photoOriginalPaths(...args),
    ownsShare:bridges.ownsShare,
    accountList:account.accountList,
    trashItems:shareFacade.trashItems,
    normUsername:requiredFunction(account.normUsername, 'account.normUsername'),
    linkPrefix:shareFacade.linkPrefix,
    noteCenterServiceState:requiredFunction(notification.noteCenterServiceState, 'notification.noteCenterServiceState'),
    addAdminCenterNotification:notification.addAdminCenterNotification,
    emitLiveActivity,
    ocrService,
    onStateChange(snapshot) {
      searchIndexBuilding = !!snapshot.building;
      searchIndexError = snapshot.error || null;
      universalSearchIndex = snapshot.index || { version:3, builtAt:0, docs:[] };
    },
  });

  const dlpService = createDlpService({
    HOST_ROOT:config.HOST_ROOT,
    FULL_IMAGES_DIR:config.FULL_IMAGES_DIR,
    DLP_QUARANTINE_DIR:requiredValue(config.DLP_QUARANTINE_DIR, 'config.DLP_QUARANTINE_DIR'),
    getState, getSettings, hostToContainer, assertRealWithin, persistNow,
    clientIp, maskIp,
    auditReq:requiredFunction(notification.auditReq, 'notification.auditReq'),
    logAudit:notification.logAudit,
    addAdminCenterNotification:notification.addAdminCenterNotification,
    addRequestCenterNotification:requiredFunction(notification.addRequestCenterNotification, 'notification.addRequestCenterNotification'),
    noteCenterServiceState:notification.noteCenterServiceState,
    searchService, ocrService,
  });

  const recipientByToken = shareService.recipientByToken;
  transferService = createTransferService({
    crypto, fs,
    LOG_FILE:requiredValue(config.LOG_FILE, 'config.LOG_FILE'),
    MAX_LOG_BYTES:config.MAX_LOG_BYTES,
    HISTORY_MAX:config.HISTORY_MAX,
    TRANSFER_STALL_MS:config.TRANSFER_STALL_MS,
    getState, getSettings,
    getById:(...args) => shareService.getById(...args),
    clientIp, geoSync, geolocate,
    getRecipientByToken:(token) => recipientByToken.get(token),
    dataWritable:requiredFunction(bridges.dataWritable, 'bridges.dataWritable'),
    emitLiveActivity, pubIp,
    ipNameFor:requiredFunction(activity.ipNameFor, 'activity.ipNameFor'),
    schedulePresenceBroadcast:requiredFunction(activity.schedulePresenceBroadcast, 'activity.schedulePresenceBroadcast'),
    scheduleFlush, persist,
    logAudit:notification.logAudit,
    addShareCenterNotification:notification.addShareCenterNotification,
    noteCenterCountry:notification.noteCenterCountry,
    noteCenterActivity:notification.noteCenterActivity,
    noteCenterRepeatedDownload:requiredFunction(notification.noteCenterRepeatedDownload, 'notification.noteCenterRepeatedDownload'),
    noteCenterHighVolume:requiredFunction(notification.noteCenterHighVolume, 'notification.noteCenterHighVolume'),
    noteCenterViral:notification.noteCenterViral,
    maybeCenterReceptionQuota:notification.maybeCenterReceptionQuota,
    noteCenterAutoDisabled:notification.noteCenterAutoDisabled,
    notify:requiredFunction(notification.notify, 'notification.notify'),
    noteLeakSignal:requiredFunction(notification.noteLeakSignal, 'notification.noteLeakSignal'),
  });

  const searchCompat = applicationContext.bind(searchService, SEARCH_COMPAT_MAP);
  const searchCompatRoute = applicationContext.bind(searchService, {
    scheduleSearchReindex:'scheduleReindex',
    ...SEARCH_COMPAT_MAP,
  });

  let downloadService = null;
  let downloadPhase = 'idle';
  let downloadFailure = null;

  function initializeDownloadService(init = {}) {
    if (downloadPhase === 'ready') return downloadService;
    if (downloadPhase === 'initializing') {
      throw new Error('share-media-transfer download initialization is already in progress');
    }
    if (downloadPhase === 'failed') {
      const error = new Error('share-media-transfer download initialization previously failed; restart is required');
      if (downloadFailure) error.cause = downloadFailure;
      throw error;
    }

    const publicSecurity = requiredObject(init.publicSecurity, 'download publicSecurity');
    const pages = requiredObject(init.pages, 'download pages');
    const webStorage = requiredObject(init.webStorage, 'download webStorage');
    const lifecycle = requiredObject(init.lifecycle, 'download lifecycle');

    // Finish all caller-input validation before entering the irreversible
    // initialization state. A missing late adapter has created no runtime state,
    // so correcting the wiring and retrying is safe and should not require restart.
    const prepared = Object.freeze({
      sendError:requiredFunction(pages.sendError, 'download pages.sendError'),
      challengeRequired:requiredFunction(publicSecurity.challengeRequired, 'download publicSecurity.challengeRequired'),
      hasValidPow:requiredFunction(publicSecurity.hasValidPow, 'download publicSecurity.hasValidPow'),
      challengePage:requiredFunction(pages.challengePage, 'download pages.challengePage'),
      pickLang:requiredFunction(pages.pickLang, 'download pages.pickLang'),
      onDownloadComplete:requiredFunction(lifecycle.onDownloadComplete, 'download lifecycle.onDownloadComplete'),
      challengeGateZip:requiredFunction(publicSecurity.challengeGateZip, 'download publicSecurity.challengeGateZip'),
      storageConnectorService:requiredObject(webStorage.storageConnectorService, 'download webStorage.storageConnectorService'),
      connectorErrorCode:requiredFunction(webStorage.connectorErrorCode, 'download webStorage.connectorErrorCode'),
      webStorageShareMeta:requiredFunction(webStorage.shareMeta, 'download webStorage.shareMeta'),
      webStorageJoinedPath:requiredFunction(webStorage.joinedPath, 'download webStorage.joinedPath'),
      webStorageStat:requiredFunction(webStorage.stat, 'download webStorage.stat'),
      webStorageEtag:requiredFunction(webStorage.etag, 'download webStorage.etag'),
      parseWebStorageRange:requiredFunction(webStorage.parseRange, 'download webStorage.parseRange'),
      startTransfer:requiredFunction(transferService.startTransfer, 'transferService.startTransfer'),
      endTransfer:requiredFunction(transferService.endTransfer, 'transferService.endTransfer'),
      claimOneTimeDownload:requiredFunction(transferService.claimOneTimeDownload, 'transferService.claimOneTimeDownload'),
      releaseOneTimeDownload:requiredFunction(transferService.releaseOneTimeDownload, 'transferService.releaseOneTimeDownload'),
    });

    downloadPhase = 'initializing';
    try {
      downloadService = createDownloadService({
        MAX_ZIP_BYTES:config.MAX_ZIP_BYTES,
        MAX_CONCURRENT_ZIPS:config.MAX_CONCURRENT_ZIPS,
        HOST_ROOT:config.HOST_ROOT,
        WEB_STORAGE_STREAM_IDLE_MS:config.WEB_STORAGE_STREAM_IDLE_MS,
        getState, getSettings,
        getById:(...args) => shareService.getById(...args),
        maskIp, clientIp, scheduleFlush, persistNow,
        sendError:prepared.sendError,
        challengeRequired:prepared.challengeRequired,
        hasValidPow:prepared.hasValidPow,
        challengePage:prepared.challengePage,
        pickLang:prepared.pickLang,
        noteCenterSharedFileSignature:notification.noteCenterSharedFileSignature,
        commitManagedIpDownload:shareFacade.commitManagedIpDownload,
        onDownloadComplete:prepared.onDownloadComplete,
        noteBytesServed:shareFacade.noteBytesServed,
        startTransfer:prepared.startTransfer,
        endTransfer:prepared.endTransfer,
        noteCenterConcurrentDownloadStart:notification.noteCenterConcurrentDownloadStart,
        claimOneTimeDownload:prepared.claimOneTimeDownload,
        releaseOneTimeDownload:prepared.releaseOneTimeDownload,
        challengeGateZip:prepared.challengeGateZip,
        assertRealWithin, hostToContainer,
        storageConnectorService:prepared.storageConnectorService,
        connectorErrorCode:prepared.connectorErrorCode,
        webStorageShareMeta:prepared.webStorageShareMeta,
        webStorageJoinedPath:prepared.webStorageJoinedPath,
        webStorageStat:prepared.webStorageStat,
        webStorageEtag:prepared.webStorageEtag,
        parseWebStorageRange:prepared.parseWebStorageRange,
        incrementDownloads:shareFacade.incrementDownloads,
      });
      downloadFailure = null;
      downloadPhase = 'ready';
      return downloadService;
    } catch (error) {
      downloadService = null;
      downloadFailure = error;
      downloadPhase = 'failed';
      throw error;
    }
  }

  function getDownloadService() {
    if (downloadPhase !== 'ready' || !downloadService) {
      throw new Error('share-media-transfer download service is not initialized yet');
    }
    return downloadService;
  }

  function isBusyForStateReplacement() {
    return shareService.isBusyForStateReplacement()
      || photoService.isBusyForStateReplacement();
  }

  function clearMediaRuntimeState() {
    photoService.clearRuntimeState();
  }

  function applicationDomainEntries() {
    if (downloadPhase !== 'ready' || !downloadService) {
      throw new Error('share-media-transfer domains require the download service before publication');
    }
    return Object.freeze([
      ['share', shareService], ['photo', photoService], ['ocr', ocrService],
      ['search', searchService], ['search-compat', searchCompatRoute], ['dlp', dlpService],
      ['transfer', transferService], ['download', downloadService],
    ].map((entry) => Object.freeze(entry)));
  }

  let domainPhase = 'idle';
  let domainFailure = null;
  function registerApplicationDomains() {
    if (domainPhase === 'ready') return;
    if (domainPhase === 'registering') {
      throw new Error('share-media-transfer domain registration is already in progress');
    }
    if (domainPhase === 'failed') {
      const error = new Error('share-media-transfer domain registration previously failed; restart is required');
      if (domainFailure) error.cause = domainFailure;
      throw error;
    }
    if (downloadPhase !== 'ready' || !downloadService) {
      throw new Error('share-media-transfer domains require the download service before registration');
    }
    const applicationDomains = applicationDomainEntries();
    let published = 0;
    for (const [name, service] of applicationDomains) {
      const current = applicationContext.current(name);
      if (current === service) { published += 1; continue; }
      if (current != null) throw new Error(`share-media-transfer domain is already registered: ${name}`);
    }
    if (published === applicationDomains.length) {
      domainFailure = null;
      domainPhase = 'ready';
      return;
    }
    if (published !== 0) {
      for (const [name] of applicationDomains) {
        if (applicationContext.current(name) != null) throw new Error(`share-media-transfer domain is already registered: ${name}`);
      }
      throw new Error('share-media-transfer domains are only partially published');
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
    shareService,
    photoService,
    ocrService,
    searchService,
    dlpService,
    transferService,
    shareFacade,
    searchCompat,
    searchCompatRoute,
    searchCompatMap:SEARCH_COMPAT_MAP,
    initializeDownloadService,
    getDownloadService,
    isBusyForStateReplacement,
    clearMediaRuntimeState,
    applicationDomainEntries,
    registerApplicationDomains,
    getSearchIndexBuilding:() => searchIndexBuilding,
    getSearchIndexError:() => searchIndexError,
    getUniversalSearchIndex:() => universalSearchIndex,
  });
}

module.exports = {
  SHARE_MEDIA_CONTEXT_DOMAINS,
  createShareMediaTransferApplication,
  SEARCH_COMPAT_MAP,
  SHARE_FACADE_METHODS,
};
