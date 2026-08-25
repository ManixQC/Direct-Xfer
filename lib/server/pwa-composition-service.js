'use strict';

const CORE_SERVICE_NAMES = Object.freeze(['device', 'event', 'photo', 'webauthn', 'notification']);

// Only the operations consumed by pwa-routes are projected. This keeps service
// internals such as timers and clearRuntimeState out of the HTTP composition and
// makes accidental cross-domain name collisions fail during startup.
const ROUTE_SERVICE_EXPORTS = Object.freeze({
  device: Object.freeze([
    'PWA_INSTALL_HEARTBEAT_MAX_AGE_MS', 'pwaPairTickets',
    'bindPwaDeviceForLogin', 'clearPwaDeviceCookie', 'getPwaDevice',
    'getPwaPublicDevice', 'issuePwaDevice', 'lockPwaSessionHandler',
    'migratePwaRecordsForAccount',
    'prunePwaPairTickets', 'publicPwaDevice', 'pwaDetectionOrigin',
    'pwaDeviceCreatorAccount', 'pwaDeviceOwnerAccount', 'pwaDevices',
    'pwaHostAdminSession', 'pwaHttpsInstallUrl', 'pwaNetworkGuard',
    'rememberPwaDeviceOwner', 'requestClientDeviceName', 'requireAppAuth',
    'safePwaNext', 'sendPwaInstallAsset', 'stampPhotoUploadDevice',
    'stampPwaRecordOwner', 'updatePwaDeviceClientInfo',
  ]),
  event: Object.freeze([
    'activityPrincipal', 'inboxEventSubs', 'inboxReceivedFiles', 'pwaAuditReq',
    'pwaCanSeeActiveTransfer', 'pwaCanSeeActivityEvent',
    'pwaEventStreamValidator', 'pwaLiveTransfersForRequest', 'pwaOwnerKeys',
    'pwaPresenceScope', 'pwaPresenceValidator',
  ]),
  photo: Object.freeze([
    'PWA_IMG_EXT', 'applyPwaPhotoSettings', 'canManagePwaAlbum',
    'canManagePwaImage', 'normalizePwaRetentionRules', 'ownerKeyForPhoto',
    'primaryPwaOwnerKey', 'publicAlbumInvite', 'pwaAlbumPayload',
    'pwaCanManageHostShare', 'pwaDlpPolicyPayload', 'pwaImageBootstrapMarkup',
    'pwaImageCreatePayload', 'pwaImgOwner', 'pwaPhotoByToken',
    'pwaRetentionRuleStore', 'pwaViewerIsAdmin',
    'runPwaImageRetentionForOwner',
  ]),
  webauthn: Object.freeze([
    'PASSKEY_MANAGEMENT_FRESH_MS', 'WEBAUTHN_CHALLENGE_TTL',
    'accountPasskeys', 'b64u', 'bindPasskeyToDevice', 'cborDecode',
    'clearWebauthnChallengesForAccount', 'coseToJwk',
    'freshPasskeyManagementAccount', 'fromB64u', 'passkeyBoundToDevice',
    'passkeyDeviceIds', 'passkeyTransports', 'phantomAllowCredentials', 'pruneWebauthnChallenges',
    'publicPasskey', 'unbindPasskeyDevice', 'webauthnLoginChallenges',
    'webauthnParseAuthData', 'webauthnPublicKey', 'webauthnRegChallenges',
    'webauthnRp', 'webauthnVerifySignature',
  ]),
  notification: Object.freeze([
    'flushPendingFirstViewPushForKeys', 'localizedPwaPush',
    'normalizePwaPushLang', 'pwaNotificationAccountId',
  ]),
  share: Object.freeze([
    'addShare', 'addShareDurable', 'applyTrashRestoreAlternative',
    'boundedSeconds', 'detachActiveShare', 'getById', 'getByToken', 'isActive',
    'listShares', 'normalizeShareColor', 'parseMaxVisitors', 'performUndo',
    'purgeTrashRecordById', 'queueShareLogicalBytesRefresh',
    'reactivateRevokedShare', 'recordShareChange', 'recordUndoable',
    'restorePlainObject', 'restoreTrashRecord', 'rollbackRecordedUndo',
    'shareChangeSnapshot', 'shareEffectiveExpiry', 'shareLogicalBytesCache',
    'shareNeedsLogicalBytesScan', 'shareReactivationAvailability',
    'softDeleteShare', 'trashItems', 'trashPublicRecord',
    'trashRestoreAssessment', 'undoEntryExecutable', 'undoEntryVisible',
    'undoLogItems', 'undoPublicEntry', 'undoRequestAccount',
    'unlinkManagedPathsStrict',
  ]),
  media: Object.freeze([
    'acquireManagedPhotoHashResponseLock', 'addPhotoEditHistory',
    'adminPhotoFullWrites', 'adminPhotoHasVariantWrite',
    'archiveCurrentPhotoVersion', 'bumpPhotoCacheRevision',
    'cleanPhotoEditOperations', 'cleanupPhotoVersionStorage',
    'detailedPhotoRecentViews', 'duplicatePhotoPayload',
    'ensurePhotoDailyViews', 'findManagedPhotoDuplicateDeep',
    'firstExistingPhotoFile', 'handleAdminPhotoVariantUpload',
    'handlePhotoAdaptiveUpload', 'localDayKey', 'localDayKeys',
    'managedPhotoCandidates', 'photoAdaptivePath', 'photoCacheRevision',
    'photoManagedBytes', 'photoOriginalPaths', 'photoStatsOf',
    'photoVariantPaths', 'photoVersionDir', 'pwaImageInventoryForRequest',
    'pwaPhotoPayload', 'restorePhotoVersion', 'streamToFileBounded',
  ]),
  settings: Object.freeze(['computeSettingsPatch', 'getSettings', 'setSettingsDurable']),
  notificationCenter: Object.freeze([
    'CUSTOM_NOTIFICATION_RULE_METRICS', 'NOTIFICATION_MUTABLE_CATEGORIES',
    'accountCustomNotificationRules', 'accountMutedNotificationCategories',
    'addAdminCenterNotification', 'addCenterNotification',
    'addShareCenterNotification', 'clearNotificationsForAccount',
    'customNotificationRuleTargets', 'deleteCustomNotificationRule',
    'deleteNotificationForAccount', 'markNotificationsReadForAccount',
    'notificationAccountIdsForRequest', 'notificationsForAccount',
    'publicCustomNotificationRule', 'setAccountMutedNotificationCategories',
    'upsertCustomNotificationRule',
  ]),
});

const ROUTE_SERVICE_VALUE_CONTRACTS = Object.freeze({
  device: Object.freeze({
    PWA_INSTALL_HEARTBEAT_MAX_AGE_MS: Object.freeze({ label:'a positive finite number', test:(value) => Number.isFinite(value) && value > 0 }),
    pwaPairTickets: Object.freeze({ label:'a Map', test:(value) => value instanceof Map }),
  }),
  event: Object.freeze({
    inboxEventSubs: Object.freeze({ label:'a Map', test:(value) => value instanceof Map }),
  }),
  photo: Object.freeze({
    PWA_IMG_EXT: Object.freeze({ label:'a RegExp', test:(value) => value instanceof RegExp }),
  }),
  webauthn: Object.freeze({
    PASSKEY_MANAGEMENT_FRESH_MS: Object.freeze({ label:'a positive finite number', test:(value) => Number.isFinite(value) && value > 0 }),
    WEBAUTHN_CHALLENGE_TTL: Object.freeze({ label:'a positive finite number', test:(value) => Number.isFinite(value) && value > 0 }),
    webauthnLoginChallenges: Object.freeze({ label:'a Map', test:(value) => value instanceof Map }),
    webauthnRegChallenges: Object.freeze({ label:'a Map', test:(value) => value instanceof Map }),
  }),
  share: Object.freeze({
    shareLogicalBytesCache: Object.freeze({ label:'a Map', test:(value) => value instanceof Map }),
  }),
  media: Object.freeze({
    adminPhotoFullWrites: Object.freeze({ label:'a Set', test:(value) => value instanceof Set }),
  }),
  notificationCenter: Object.freeze({
    CUSTOM_NOTIFICATION_RULE_METRICS: Object.freeze({ label:'an array of strings', test:isStringArray }),
    NOTIFICATION_MUTABLE_CATEGORIES: Object.freeze({ label:'an array of strings', test:isStringArray }),
  }),
});

const UNSAFE_DEPENDENCY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const PWA_LIVE_BINDING_NAMES = Object.freeze(['state', 'searchIndexBuilding', 'universalSearchIndex', 'webpush']);
const SHARE_MEDIA_PWA_HOOKS = Object.freeze({
  device:Object.freeze([
    'pwaDeviceResolvedAccount', 'getPwaPublicDevice', 'pwaDeviceCreatorAccount',
    'pwaDeviceOwnerAccount', 'requestClientDeviceName', 'cleanDeviceLabel',
  ]),
  event:Object.freeze(['activityPrincipal', 'shareOwnerAccount']),
  photo:Object.freeze(['canManagePwaImage']),
});

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function ownDataDescriptor(object, name, source) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor) throw new TypeError(`${source} is missing ${name}`);
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError(`${source} ${name} must be a data property; use live bindings for accessors`);
  }
  return descriptor;
}

function ownCallableDescriptor(service, operation, mismatchLabel) {
  const descriptor = service && Object.getOwnPropertyDescriptor(service, operation);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(mismatchLabel);
  }
  return descriptor;
}

function createDeferredFacade(name, slots, requested) {
  const deferred = new Map();
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === Symbol.toStringTag) return 'PwaDeferredService';
      if (property === 'then') return undefined;
      const service = slots[name];
      if (service) {
        const descriptor = Object.getOwnPropertyDescriptor(service, property);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
        const value = descriptor.value;
        return typeof value === 'function' ? value.bind(service) : value;
      }
      if (typeof property !== 'string') return undefined;
      requested[name].add(property);
      if (!deferred.has(property)) {
        deferred.set(property, (...args) => {
          const current = slots[name];
          if (!current) throw new Error(`pwa-service-not-ready:${name}.${property}`);
          // Deferred references are capability contracts, not ordinary property
          // lookups. Re-read only the current own data method so a deleted method
          // cannot silently fall through to a prototype/accessor after binding.
          const descriptor = ownCallableDescriptor(
            current,
            property,
            `pwa-service-contract-mismatch:${name}.${property}`,
          );
          return descriptor.value.apply(current, args);
        });
      }
      return deferred.get(property);
    },
  });
}

function createShareMediaPwaHooks(slots, requested) {
  const plan = [];
  const seen = new Set();

  // Preflight every already-bound service before mutating the deferred contract
  // sets. A failed facade request must not leave unrelated future PWA binds with
  // requirements from a facade that was never successfully published.
  for (const [serviceName, names] of Object.entries(SHARE_MEDIA_PWA_HOOKS)) {
    const current = slots[serviceName] || null;
    for (const name of names) {
      if (seen.has(name)) throw new Error(`PWA share/media hooks have duplicate hook ${name}`);
      seen.add(name);
      if (current) {
        ownCallableDescriptor(current, name, `PWA share/media hooks require ${serviceName}.${name}()`);
      }
      plan.push([serviceName, name]);
    }
  }

  const hooks = Object.create(null);
  for (const [serviceName, name] of plan) {
    Object.defineProperty(hooks, name, {
      enumerable:true,
      configurable:false,
      writable:false,
      value:(...args) => {
        const current = slots[serviceName];
        if (!current) throw new Error(`pwa-service-not-ready:${serviceName}.${name}`);
        const descriptor = ownCallableDescriptor(
          current,
          name,
          `pwa-service-contract-mismatch:${serviceName}.${name}`,
        );
        return descriptor.value.apply(current, args);
      },
    });
  }

  // Commit deferred requirements only after the whole projection preflight has
  // succeeded. This keeps facade creation atomic when some PWA services are
  // already bound while others are still deferred.
  for (const [serviceName, name] of plan) requested[serviceName].add(name);
  return Object.freeze(hooks);
}

function createPwaServiceRegistry() {
  const slots = Object.create(null);
  const requested = Object.create(null);
  for (const name of CORE_SERVICE_NAMES) requested[name] = new Set();

  function validate(name, service) {
    if (!CORE_SERVICE_NAMES.includes(name)) throw new TypeError(`unknown PWA service: ${name}`);
    if (!service || typeof service !== 'object') throw new TypeError(`invalid PWA service: ${name}`);
    if (slots[name] && slots[name] !== service) throw new Error(`PWA service already bound: ${name}`);
    for (const operation of requested[name]) {
      const descriptor = Object.getOwnPropertyDescriptor(service, operation);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError(`pwa-service-contract-mismatch:${name}.${operation}`);
      }
    }
    return service;
  }

  const registry = {
    validate,
    bind(name, service) {
      validate(name, service);
      slots[name] = service;
      return service;
    },
    current(name) {
      if (!CORE_SERVICE_NAMES.includes(name)) throw new TypeError(`unknown PWA service: ${name}`);
      return slots[name] || null;
    },
  };
  for (const name of CORE_SERVICE_NAMES) registry[name] = createDeferredFacade(name, slots, requested);

  // Share/media is composed before the concrete PWA domains. Build this facade
  // only when the composition root asks for it so generic registry consumers do
  // not acquire unrelated deferred-contract requirements.
  let shareMediaHooks = null;
  Object.defineProperty(registry, 'shareMediaHooks', {
    enumerable:true,
    configurable:false,
    get() {
      if (!shareMediaHooks) shareMediaHooks = createShareMediaPwaHooks(slots, requested);
      return shareMediaHooks;
    },
  });
  return Object.freeze(registry);
}

function defineDependency(target, name, value, source) {
  if (UNSAFE_DEPENDENCY_NAMES.has(name)) throw new TypeError(`unsafe PWA route dependency: ${name} (${source})`);
  if (Object.prototype.hasOwnProperty.call(target, name)) {
    throw new Error(`duplicate PWA route dependency: ${name} (${source})`);
  }
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: false,
    writable: false,
    value,
  });
}

function composePwaRouteDependencies(services = {}, facades = {}) {
  if (!services || typeof services !== 'object') throw new TypeError('pwa-routes requires a services object');
  if (!facades || typeof facades !== 'object') throw new TypeError('pwa-routes requires a facades object');
  const dependencies = Object.create(null);
  for (const [serviceName, exportedNames] of Object.entries(ROUTE_SERVICE_EXPORTS)) {
    const serviceDescriptor = ownDataDescriptor(services, serviceName, 'pwa-routes services');
    const service = serviceDescriptor.value;
    if (!service || typeof service !== 'object') throw new TypeError(`pwa-routes requires ${serviceName} service`);
    for (const name of exportedNames) {
      const descriptor = ownDataDescriptor(service, name, `pwa-routes ${serviceName} service`);
      const value = descriptor.value;
      const valueContract = ROUTE_SERVICE_VALUE_CONTRACTS[serviceName] && ROUTE_SERVICE_VALUE_CONTRACTS[serviceName][name];
      if (valueContract) {
        if (!valueContract.test(value)) {
          throw new TypeError(`pwa-routes ${serviceName}.${name} must be ${valueContract.label}`);
        }
      } else if (typeof value !== 'function') {
        throw new TypeError(`pwa-routes ${serviceName}.${name} must be a function`);
      }
      defineDependency(dependencies, name, typeof value === 'function' ? value.bind(service) : value, serviceName);
    }
  }
  for (const facadeName of Object.keys(facades)) {
    if (UNSAFE_DEPENDENCY_NAMES.has(facadeName)) throw new TypeError(`unsafe PWA route facade: ${facadeName}`);
    const facade = ownDataDescriptor(facades, facadeName, 'pwa-routes facades').value;
    if (!facade || typeof facade !== 'object') throw new TypeError(`invalid PWA route facade: ${facadeName}`);
    for (const name of Object.keys(facade)) {
      const value = ownDataDescriptor(facade, name, `PWA route facade ${facadeName}`).value;
      defineDependency(dependencies, name, value, facadeName);
    }
  }
  return Object.freeze(dependencies);
}

function validatePwaRouteLiveBindings(live) {
  if (!live || typeof live !== 'object') throw new TypeError('pwa-routes requires live bindings');
  for (const name of PWA_LIVE_BINDING_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(live, name);
    if (!descriptor) throw new TypeError(`pwa-routes live bindings are missing ${name}`);
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      if (name === 'state' && descriptor.writable === false) {
        throw new TypeError('pwa-routes live state binding must be writable');
      }
      continue;
    }
    if (typeof descriptor.get !== 'function') throw new TypeError(`pwa-routes live ${name} binding must be readable`);
    if (name === 'state' && typeof descriptor.set !== 'function') {
      throw new TypeError('pwa-routes live state binding must be writable');
    }
  }
  return live;
}

module.exports = {
  ROUTE_SERVICE_EXPORTS,
  composePwaRouteDependencies,
  createPwaServiceRegistry,
  validatePwaRouteLiveBindings,
};
