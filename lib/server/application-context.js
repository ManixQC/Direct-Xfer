'use strict';

const UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

const ROUTE_DEPENDENCIES = Object.freeze({
  receptionCollaboration: Object.freeze([
    "DEDUPE_CHALLENGE_TTL_MS", "INBOX_DIR", "PARTS_DIR", "PENDING_DIR", "ZIP_SELECTION_MAX", "acceptsUpload", "addShareCenterNotification", "anomalyClientIp",
    "anomalyWindows", "appendReceptionThreadMessage", "applyReceptionAccountingState", "assertRealWithin", "beginPublicUpload", "blockRansomwareClient", "bumpSenderStat", "bumpViews",
    "clamavEnabled", "clampExpireSec", "cleanConnectorPath", "cleanSenderName", "cleanupDedupeChallenges", "clientIp", "collabPage", "collabRoot",
    "completedUploadReceipt", "connectorErrorCode", "createWebStorageUploadHandler", "dedupeChallenges", "deleteFileExpiryForPath", "downloadRouter", "effMaxUpload", "emitInboxEvent",
    "emitLiveActivity", "endTransfer", "express", "fileExpiryMap", "finalizeReceptionAccountingEffects", "findDedupeCandidate", "folderBytes", "geoSync",
    "geolocate", "getByToken", "getSettings", "hashFileSha256", "inboxContentReason", "inboxPage", "inboxRejectReason", "inboxRejectStatus",
    "incrementDownloads", "isAccessApproved", "isActive", "isLoopback", "isUnlocked", "listDir", "logAudit", "makeDedupeRanges",
    "notificationAccountIdForShare", "notify", "parseSelList", "partPath", "passwordPage", "perSenderRejectReason", "persistNow", "pickLang",
    "pruneAnomalyEvents", "pubIp", "publicMessageDecision", "publicThreadMessage", "ransomwareBlocked", "ransomwareShareBlocked", "receptionDuplicateReason", "receptionDuplicateStoredPath",
    "receptionHashSeen", "receptionMetadataPath", "receptionThreadArray", "receptionThreadEnabled", "recordFileExpiry", "rememberCompletedUpload", "rememberDedupeFile", "rememberReceptionHash",
    "reserveUniqueUploadPath", "resolveWithin", "restorePlainObject", "restorePublicMessageDecision", "rollbackAcceptedUploadFile", "rollbackReceptionAccountingState", "safeUploadByteCount", "safeUploadFolderName",
    "safeUploadId", "safeUploadParentSegments", "safeUploadRelPath", "scanGate", "scheduleFlush", "scheduleSearchReindex", "scopedUploadId", "selParser",
    "selectionToItems", "sendError", "sendSha256Manifest", "senderSubdirSegs", "senderTaggedName", "serveFolderFile", "serveFolderZip", "serveWebStorageFile",
    "shareManifestFiles", "snapshotPublicMessageDecision", "startTransfer", "stashPending", "stoppedUploads", "streamZipFiles", "suspiciousRansomwareName", "uploadSenderKey",
    "uploadTransfers", "uploadsInFlight", "validSha256Hex", "verifyAndRememberDedupe", "verifyDedupeProof", "webStorageConnectorStatus", "webStorageList", "webStorageStat",
    "webStorageWritable", "withShareUploadLock", "live",
  ]),
  adminAccount: Object.freeze([
    "adminRouter", "requireOwner", "authService", "sessionService", "getAccountById", "accountNeedsPwChange", "adminPwFromEnv", "notificationsForAccount",
    "markNotificationsReadForAccount", "deleteNotificationForAccount", "clearNotificationsForAccount", "accountMutedNotificationCategories", "getNotificationMutableCategories", "setAccountMutedNotificationCategories", "accountCustomNotificationRules", "publicCustomNotificationRule",
    "customNotificationRuleTargets", "getCustomNotificationRuleMetrics", "upsertCustomNotificationRule", "deleteCustomNotificationRule", "auditReq", "persistNow", "crypto", "appName",
    "accountList", "normalizeUsername", "findAccountByName", "newAccountId", "hashPassword", "sendPasswordWorkError", "getPwaPairTickets", "pwaDeviceResolvedAccount",
    "cleanupPwaCapabilityScopes", "clearNotificationDedupeForAccount", "syncLiveActivityCache", "reindex", "shareLogicalBytesCache", "trashItems", "getState", "replaceState",
  ]),
  adminSecurity: Object.freeze([
    "adminRouter", "requireAuditAccess", "requireFullAdmin", "ransomwareBlocks", "ransomwareShareBlocks", "scheduleFlush", "getSettings", "anomalyRecent",
    "anomalyWindows", "persistNow", "auditReq", "crypto", "sessionService", "publicIp", "invalidateSessionSid", "secureCookie",
    "getState", "verifyAuditChain", "ensureAuditProofKeys", "auditProofKeyId", "parseAuditChainFile", "buildAuditProof", "verifyAuditProofBundle", "timingSafeEqualStr",
    "csvField", "appName", "fs", "path", "dlpQuarantineRecords", "dlpQuarantineFilePath", "schedulePersistRetry",
  ]),
  adminStorage: Object.freeze([
    "adminRouter", "requireFullAdmin", "storageConnectorService", "googleOAuthProfileStore", "googleOAuthBrokerClient", "connectorTypes", "oauthConnectorTypes", "connectorBackendType",
    "safeRcloneErrorDetail", "crypto", "isLoopback", "clientIp", "auditReq", "logAudit", "getAccountById", "googleOAuthPublicOrigin",
    "googleOAuthBrokerUrl", "googleOAuthBrokerManaged", "getStorageConnector", "cleanConnectorPath", "connectorErrorCode", "connectorHttpStatus", "connectorStore", "publicConnector",
    "normalizeConnector", "maxStorageConnectors", "persistNow", "webStorageShareReferencesConnector", "connectorJobService",
  ]),
  adminShareCore: Object.freeze([
    "APP_NAME", "HOST_ROOT", "INBOX_DIR", "LOG_FILE", "SHARE_CHANGE_HISTORY_MAX", "UNDO_LOG_MAX", "VISITORS_MAX", "activeTransfers",
    "addShareDurable", "adminRouter", "applyAccessRules", "applyDlpSummary", "applyTrashRestoreAlternative", "assertRealWithin", "auditReq", "boundedSeconds",
    "cleanConnectorPath", "connectorErrorCode", "connectorHttpStatus", "containerToHost", "crypto", "csvField", "decorateShare", "detachActiveShare",
    "detailedPhotoRecentViews", "displayStatsForShare", "dlpDecision", "dlpEffectiveAction", "dlpScanResolvedItems", "emitLiveActivity", "firstExistingPhotoFile", "fs",
    "getById", "getSettings", "getStorageConnector", "hostToContainer", "imageContentType", "imageDimensions", "inboxReceivedFiles", "ipNameFor",
    "isActive", "isScheduled", "listShares", "makeSharePassword", "newToken", "normExtList", "normalizeDescriptionMd", "normalizePwHint",
    "normalizeShareColor", "normalizeShareEmoji", "ownsShare", "parseLinkRateKBps", "parseMaxBytesServed", "parseMaxDownloads", "parseMaxDownloadsPerIp", "parseMaxVisitors",
    "parseStartsAt", "path", "performUndo", "persistNow", "photoExt", "photoOriginalPaths", "photoStatsOf", "photoVariantPaths",
    "pubIp", "purgeTrashRecordById", "readLogTailAsync", "recordShareChange", "refreshShareBackingHealth", "refreshShareLogicalBytes", "reindex", "requireFullAdmin",
    "resolveNewShareExpiry", "resolveWithin", "restoreTrashRecord", "scheduleSearchReindex", "sendPasswordWorkError", "serveWebStorageFile", "shareEffectiveExpiry", "shareItems",
    "shareLogicalBytesCache", "shareNeedsLogicalBytesScan", "shareReactivationAvailability", "shareStatsBaseline", "stampOwner", "storageConnectorService", "syncLiveActivityCache",
    "trashItems", "trashPublicRecord", "trashRecordVisible", "trashRestoreAssessment", "undoEntryExecutable", "undoEntryVisible", "undoLogItems", "undoPublicEntry",
    "webStorageConnectorStatus", "webStorageImportMeta", "webStorageWalkFiles", "webStorageWritable", "SHARE_BACKING_HEALTH_CACHE_MS", "SHARE_LOGICAL_BYTES_CACHE_MS", "historyMeta", "listTransfers",
    "mapLimit", "photoHistoryMeta", "primaryBase", "queueShareBackingHealthRefresh", "queueShareLogicalBytesRefresh", "settingsForClient", "shareBackingHealthCache", "shareBackingHealthRefreshes",
    "shareBackingHealthRelevant", "shareLogicalBytesRefreshes", "listHistory", "clearShareRuntimeState", "live",
  ]),
  adminShare: Object.freeze([
    "APP_NAME", "ENC_DIR", "FULL_IMAGES_DIR", "HOST_ROOT", "INBOX_DIR", "MICROS_DIR", "PENDING_DIR", "QRCode",
    "SECRETS_DIR", "SHARE_CHANGE_HISTORY_MAX", "THUMBS_DIR", "VISITOR_FEEDBACK_MAX", "addShare", "addShareCenterNotification", "addShareDurable", "adminRouter",
    "appendReceptionThreadMessage", "applyAccessRules", "applyDlpSummary", "applyNewShareLifetimePolicy", "approvePendingModeration", "assertRealWithin", "auditReq", "boundedSeconds",
    "buildUniversalSearchIndex", "claimPendingModeration", "collabRoot", "copyFirstExistingPhotoFile", "copyPhotoFile", "crypto", "currentAccount", "decorateShare",
    "deleteFileExpiryForPath", "detachActiveShare", "dlpDecision", "dlpScanResolvedItems", "effMaxUpload", "emailSendable", "emitLiveActivity", "finalizePendingModerationApproval",
    "firstExistingPhotoFile", "fs", "getById", "getByToken", "getSettings", "globalMetadataSearch", "hostToContainer", "inboxRejectStatus",
    "invalidateShareLogicalBytes", "isActive", "isScheduled", "linkPrefix", "listShares", "makeSharePassword", "newStoredImageName", "newToken",
    "normExtList", "normalizeDescriptionMd", "normalizePwHint", "normalizeShareColor", "normalizeShareEmoji", "ownerThreadMessage", "ownsShare", "parseExpiry",
    "parseExpiryAt", "parseLinkRateKBps", "parseMaxBytesServed", "parseMaxDownloads", "parseMaxDownloadsPerIp", "parseMaxVisitors", "parseNewShareExpiry", "parseStartsAt",
    "path", "pendingModerationRows", "persistNow", "photoAdaptivePath", "photoExt", "photoOriginalPaths", "photoVariantPaths", "primaryBase",
    "pubIp", "reactivateRevokedShare", "receptionThreadArray", "receptionThreadEnabled", "receptionThreadUnreadCount", "recordShareChange", "recordUndoable", "reindex",
    "releasePendingModeration", "reqPathList", "requireFullAdmin", "resolveHostItem", "resolveNewShareExpiry", "resolveWithin", "restorePlainObject", "rollbackRecordedUndo",
    "scheduleSearchReindex", "sendMail", "sendPasswordWorkError", "shareChangeSnapshot", "shareLogicalBytesCache", "softDeleteShare", "stagePendingFileRemoval",
    "stampOwner", "stampPhotoUploadDevice", "syncLiveActivityCache", "universalSearchQuery", "universalSearchScopedStatus", "universalSearchShareEligible", "universalSearchStatus", "universalSemanticSearchQuery",
    "clearShareRuntimeState", "live",
  ]),
  adminSettings: Object.freeze([
    "APP_NAME", "WEBHOOK_URL", "addCenterNotification", "adminRouter", "auditReq", "autoWebhookFormat", "computeSettingsPatch", "crypto",
    "effectiveWebhook", "emailConfigured", "getSettings", "getVapidKeys", "maybeSendDigest", "nodemailer", "persistNow", "pruneHistory",
    "pushSubs", "pushSubAccountIds", "pushSubscriptionsForAccountIds", "recordUndoable", "requireFullAdmin", "rollbackRecordedUndo", "sendLocalCaCertificate", "sendMail",
    "sendWebPush", "sendWebhook", "setSettingsDurable", "settingsForClient", "webpush", "getState", "bumpHistoryViewRevision",
  ]),
  adminPhoto: Object.freeze([
    "DAY_MS", "FULL_IMAGES_DIR", "HOST_ROOT", "IMAGE_MAX_BYTES", "IMAGE_STORE_DIR", "MICROS_DIR", "MICRO_MAX_BYTES", "PWA_IMG_EXT",
    "THUMBS_DIR", "acquireManagedPhotoHashResponseLock", "addPhotoEditHistory", "addShareCenterNotification", "addShareDurable", "adminPhotoFullWrites", "adminPhotoHasVariantWrite", "adminRouter",
    "analyzePhotoDuplicates", "applyDlpSummary", "archiveCurrentPhotoVersion", "assertRealWithin", "auditReq", "bumpPhotoCacheRevision", "canSeePhotoHistory", "cleanPhotoEditOperations",
    "cleanupPhotoVersionStorage", "copyHostPhotoToStore", "createZipArchive", "crypto", "csvField", "decorateShare", "diskFreeThresholds", "dlpDecision",
    "dlpScanResolvedItems", "dlpScanStoredFile", "duplicatePhotoPayload", "estimateImageOptimization", "findManagedPhotoDuplicateDeep", "firstExistingPhotoFile", "formatBytes", "fs",
    "getById", "getSettings", "handleAdminPhotoVariantUpload", "hashFileSha256", "hostToContainer", "imageContentType", "imageDimensions", "isActive",
    "listShares", "mergeDlpSummaries", "ownsShare", "parseNewShareExpiry", "path", "persistNow", "photoAdaptivePath", "photoCacheRevision",
    "photoDashboardQueryOptions", "photoDimensions", "photoExt", "photoHistoryMeta", "photoHistoryPreviewPaths", "photoMatchesDashboardFilters", "photoMetadata", "photoOriginalPaths",
    "photoStatsOf", "photoUploadDeviceName", "photoVariantPaths", "photoVersionDir", "primaryBase", "reqPathList", "resolveHostItem", "restorePhotoVersion",
    "restorePlainObject", "stagePhotoHistoryPreviewRemoval", "stampOwner", "stampPhotoUploadDevice", "streamFile", "streamToFileBounded", "unlinkManagedPathsStrict", "unlinkPhotoFiles",
    "validSha256", "visiblePhotoHistory", "getState",
  ]),
  adminDashboard: Object.freeze([
    "APP_VERSION", "DAY_MS", "LOG_FILE", "TRANSFER_STALL_MS", "TRUST_PROXY", "accountList", "activeTransfers", "adminRouter",
    "auditReq", "authService", "byId", "crypto", "csvField", "dashboardQueryOptions", "dashboardRecordMatches", "effectiveWebhook",
    "emailConfigured", "formatBytes", "fs", "getById", "getLastEmail", "getLastWebhook", "ipNameFor", "isActive",
    "listShares", "listTransfers", "openLiveActivityStream", "openPresenceStream", "ownsShare", "path", "persistNow", "pwaAdminHealth",
    "presenceSessionValidator", "presenceSnapshot", "recentActivityPayload", "pubIp", "readLogTailAsync", "requestActiveTransferStop", "requireAuditAccess", "requireFullAdmin",
    "systemHealthService", "twoFactorEnabledFor", "unlockFails", "getState",
  ]),
  adminDiagnostics: Object.freeze([
    "CLAMAV_HOST", "CLAMAV_PORT", "DATA_DIR", "DATA_KEY", "HOST_ROOT", "IMAGE_STORE_DIR", "INBOX_DIR", "PORT",
    "PUBLIC_URL", "RENDER_MAX_BYTES", "SEARCH_OCR_ENABLED", "SEARCH_OCR_LANGS", "STORAGE_SETUP", "TRUST_PROXY", "adminRouter", "applyRestore",
    "assertRealWithin", "auditReq", "auditService", "backupFilename", "backupStamp", "buildBackupBundle", "checkPort", "clamavEnabled",
    "clearPwaDeviceCookie", "clearRuntimeAfterRestore", "clientIp", "containerToHost", "destroySession", "detectSearchOcrTools", "diagnosticsService", "effectiveWebhook",
    "emailConfigured", "externalTarget", "fs", "getLastEmail", "getLastWebhook", "getLocalIPv4s", "getPublicIP", "getSettings",
    "hostToContainer", "isPrivateIp", "looksLikeTextBuffer", "mapLimit", "normalizeLinkBase", "parseBackup", "path", "performBackup",
    "previewInfo", "primaryBase", "pushSubs", "putBackupS3", "putBackupWebdav", "pwaDevices", "readFileCapped", "refreshLocalTlsServerContext",
    "renderKind", "requireAuditAccess", "requireFullAdmin", "requireOwner", "restoreIsBusy", "rootDir", "scheduleSearchReindex", "serializeBackup",
    "shutdown", "streamFile", "systemHealthService", "universalSearchStatus", "verifyAuditChain", "webpush", "getState", "getServer",
  ]),
});

function assertDomainName(name) {
  const text = String(name || '').trim();
  if (!text || UNSAFE_NAMES.has(text)) throw new TypeError(`invalid application context domain: ${name}`);
  return text;
}

function assertSource(source, label) {
  if ((typeof source !== 'object' || source === null) && typeof source !== 'function') {
    throw new TypeError(`application context ${label} must be an object`);
  }
  return source;
}

function ownDescriptor(source, property) {
  return Object.prototype.hasOwnProperty.call(source, property)
    ? Object.getOwnPropertyDescriptor(source, property)
    : undefined;
}

function readDescriptor(source, property, descriptor, bindFunctions = false) {
  if (!descriptor) return undefined;
  const value = Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : (typeof descriptor.get === 'function' ? Reflect.get(source, property, source) : undefined);
  return bindFunctions && typeof value === 'function' ? value.bind(source) : value;
}

function isDataDescriptor(descriptor) {
  return !!descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function createBoundFacade(source, names) {
  assertSource(source, 'bound facade source');
  let mapping;
  if (names == null) {
    mapping = Reflect.ownKeys(source).filter((name) => typeof name === 'string').map((name) => [name, name]);
  } else if (Array.isArray(names)) {
    mapping = names.map((name) => [String(name), String(name)]);
  } else if (typeof names === 'object') {
    mapping = Object.entries(names).map(([exposed, actual]) => [String(exposed), String(actual)]);
  } else {
    throw new TypeError('application binding names must be an array or alias object');
  }
  const out = Object.create(null);
  for (const [exposed, actual] of mapping) {
    if (!exposed || UNSAFE_NAMES.has(exposed) || !actual || UNSAFE_NAMES.has(actual)) {
      throw new TypeError(`unsafe application dependency: ${exposed || actual}`);
    }
    const descriptor = ownDescriptor(source, actual);
    if (!descriptor) throw new TypeError(`application dependency is missing: ${actual}`);
    if (!isDataDescriptor(descriptor)) {
      throw new TypeError(`application dependency is dynamic: ${actual}; use a live facade instead of bind()`);
    }
    if (Object.prototype.hasOwnProperty.call(out, exposed)) throw new Error(`duplicate application dependency: ${exposed}`);
    Object.defineProperty(out, exposed, {
      enumerable: true, configurable: false, writable: false,
      value: readDescriptor(source, actual, descriptor, true),
    });
  }
  return Object.freeze(out);
}

/**
 * Composition registry used by server.js. Domain services stay namespaced while
 * legacy route modules receive a read-only flat compatibility facade only when
 * attached. Route values keep their original identity (important for callable modules
 * such as Express that expose static helpers), while explicit `bind()` projections own
 * method binding. Ambiguous dependencies fail at startup instead of silently selecting
 * a different domain implementation.
 */
function createApplicationContext() {
  let domains = new Map();
  let revision = 0;

  function register(name, source) {
    const domain = assertDomainName(name);
    assertSource(source, `domain ${domain}`);
    if (domains.has(domain)) throw new Error(`application context domain already registered: ${domain}`);
    const next = new Map(domains);
    next.set(domain, source);
    domains = next;
    revision += 1;
    return source;
  }

  // Publish a set of domains as one synchronous composition transaction. Every
  // name/source and every namespace conflict is validated before the registry is
  // mutated, so a bad late entry cannot leave an observable half-published graph.
  function registerMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new TypeError('application context registration batch must be a non-empty array');
    }
    const startRevision = revision;
    const prepared = [];
    const names = new Set();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError('application context registration batch entries must be [name, source] pairs');
      }
      const domain = assertDomainName(entry[0]);
      const source = assertSource(entry[1], `domain ${domain}`);
      if (names.has(domain)) throw new Error(`application context registration batch contains duplicate domain: ${domain}`);
      if (domains.has(domain)) throw new Error(`application context domain already registered: ${domain}`);
      names.add(domain);
      prepared.push([domain, source]);
    }
    // Entry arrays are trusted in production, but tests and embedders can supply
    // proxies/accessors. If validation re-enters the registry, never overwrite or
    // silently absorb that mutation: keep the external registration and abort this
    // batch before publication.
    if (revision !== startRevision) {
      throw new Error('application context changed during registration batch preflight');
    }
    const next = new Map(domains);
    for (const [domain, source] of prepared) next.set(domain, source);
    domains = next;
    revision += 1;
    return Object.freeze(prepared.map(([domain]) => domain));
  }

  function current(name) { return domains.get(assertDomainName(name)) || null; }

  function facade(domainNames, overrides = null) {
    const requested = Array.isArray(domainNames) ? domainNames : [domainNames];
    const names = requested.map(assertDomainName);
    if (new Set(names).size !== names.length) throw new Error('application context facade contains duplicate domains');
    for (const name of names) if (!domains.has(name)) throw new Error(`application context domain is not registered: ${name}`);
    if (overrides !== null) assertSource(overrides, 'facade overrides');
    const sources = names.map((name) => ({ name, source: domains.get(name) }));
    const overrideSource = overrides || null;

    function resolve(property) {
      if (typeof property !== 'string' || UNSAFE_NAMES.has(property)) return null;

      // Explicit route overrides are authoritative and are the only supported
      // way to disambiguate two selected domains exposing the same name.
      if (overrideSource) {
        const descriptor = ownDescriptor(overrideSource, property);
        if (descriptor) return { name:'override', source:overrideSource, descriptor };
      }

      let chosen = null;
      for (const entry of sources) {
        const descriptor = ownDescriptor(entry.source, property);
        if (!descriptor) continue;
        if (chosen) {
          // Provider ownership matters, not merely the value observed at startup.
          // Two domains that happen to export the same primitive/function today can
          // diverge later; silently selecting the first one would make composition
          // order security-sensitive.
          throw new Error(`ambiguous application dependency ${property}: ${chosen.name}, ${entry.name}`);
        }
        chosen = { name:entry.name, source:entry.source, descriptor };
      }
      return chosen;
    }

    function read(property) {
      const item = resolve(property);
      if (!item) return undefined;
      // Re-read the descriptor so accessor-backed domains remain live and a data
      // property deliberately updated after composition is not frozen by a cache.
      const descriptor = ownDescriptor(item.source, property);
      return readDescriptor(item.source, property, descriptor);
    }

    return new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === Symbol.toStringTag) return 'ApplicationFacade';
        if (property === 'then') return undefined;
        return read(property);
      },
      has(_target, property) { return !!resolve(property); },
      set() { return false; }, defineProperty() { return false; }, deleteProperty() { return false; },
      ownKeys() {
        const all = new Set();
        for (const { source } of sources) for (const key of Reflect.ownKeys(source))
          if (typeof key === 'string' && !UNSAFE_NAMES.has(key)) all.add(key);
        if (overrideSource) for (const key of Reflect.ownKeys(overrideSource))
          if (typeof key === 'string' && !UNSAFE_NAMES.has(key)) all.add(key);
        return [...all];
      },
      getOwnPropertyDescriptor(_target, property) {
        const item = resolve(property);
        if (!item) return undefined;
        const descriptor = ownDescriptor(item.source, property);
        if (!descriptor) return undefined;
        if (!isDataDescriptor(descriptor)) {
          return {
            configurable:true,
            enumerable:descriptor.enumerable !== false,
            get: typeof descriptor.get === 'function' ? () => read(property) : undefined,
          };
        }
        return {
          configurable:true,
          enumerable:descriptor.enumerable !== false,
          writable:false,
          value:descriptor.value,
        };
      },
    });
  }

  function route(profileName, domainNames, overrides = null) {
    const required = ROUTE_DEPENDENCIES[profileName];
    if (!required) throw new TypeError(`unknown application route profile: ${profileName}`);
    const composed = facade(domainNames, overrides);
    const restricted = Object.create(null);
    for (const dependency of required) {
      if (!(dependency in composed)) {
        throw new TypeError(`application route ${profileName} is missing ${dependency}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(composed, dependency);
      if (!descriptor || !isDataDescriptor(descriptor)) {
        throw new TypeError(`application route ${profileName} dependency ${dependency} is dynamic; expose a stable value or nested live binding`);
      }
      const value = descriptor.value;
      if (value === undefined) throw new TypeError(`application route ${profileName} is missing ${dependency}`);
      Object.defineProperty(restricted, dependency, {
        enumerable:true, configurable:false, writable:false, value,
      });
    }
    return Object.freeze(restricted);
  }

  return Object.freeze({
    register, registerMany, current, facade, route, bind:createBoundFacade,
    domains: () => Object.freeze([...domains.keys()]),
  });
}

module.exports = { ROUTE_DEPENDENCIES, createApplicationContext, createBoundFacade };
