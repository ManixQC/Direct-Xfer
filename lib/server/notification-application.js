'use strict';

/**
 * Notification composition boundary for Direct-Xfer.
 *
 * Owns construction and cross-wiring of the transport, durable notification
 * center and PWA push services. The services themselves keep ownership of their
 * mutable runtime state; this module owns only dependency wiring, the small set
 * of intentional lazy bridges to later-composed domains, PWA registry binding,
 * audit alert integration and application-context publication.
 */
const { createNotificationService } = require('./notification-service');
const { createNotificationCenterService } = require('./notification-center-service');
const { createPwaNotificationService } = require('./pwa-notification-service');

const NOTIFICATION_CONTEXT_DOMAINS = Object.freeze([
  'notification', 'notification-center', 'pwa-notification',
]);

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`notification application requires ${name}`);
  }
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`notification application requires ${name}()`);
  return value;
}

function requiredFunctions(source, label, names) {
  for (const name of names) requiredFunction(source[name], `${label}.${name}`);
  return source;
}

function requiredProperties(source, label, names) {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] === undefined) {
      throw new TypeError(`notification application requires ${label}.${name}`);
    }
  }
  return source;
}


const SHARE_MEDIA_NOTIFICATION_HOOKS = Object.freeze({
  notificationService:Object.freeze([
    'maybeNotifyDownloadThreshold', 'notify', 'noteLeakSignal',
  ]),
  notificationCenterService:Object.freeze([
    'accountCustomNotificationRules', 'pruneCustomNotificationRuleStateForShareId',
    'addShareCenterNotification', 'maybeCenterDownloadMilestone', 'maybeCenterReceptionQuota',
    'evaluateCustomNotificationRulesForShare', 'noteCenterAutoDisabled', 'addAdminCenterNotification',
    'centerShareEligibleForVisitorNotification', 'noteCenterCountry', 'maybeCenterViewThreshold',
    'noteCenterVisitorDevice', 'noteCenterViral', 'noteCenterActivity',
    'enrichFirstViewCenterNotification', 'noteCenterServiceState', 'addRequestCenterNotification',
    'noteCenterRepeatedDownload', 'noteCenterHighVolume', 'noteCenterSharedFileSignature',
    'noteCenterConcurrentDownloadStart',
  ]),
  pwaNotificationService:Object.freeze(['notifyFirstPhotoView']),
  auditService:Object.freeze(['logAudit', 'auditReq']),
});

function createLiveMethodFacade(label, sources, contract) {
  const facade = Object.create(null);
  const seen = new Set();

  // Validate the complete projection before exposing any hook. This keeps a
  // composition typo from creating a partially usable cross-domain facade.
  for (const [sourceName, names] of Object.entries(contract)) {
    const source = requiredObject(sources[sourceName], `${label} ${sourceName}`);
    for (const name of names) {
      if (seen.has(name)) throw new Error(`${label} has duplicate hook ${name}`);
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError(`${label} requires ${sourceName}.${name}()`);
      }
    }
  }

  for (const [sourceName, names] of Object.entries(contract)) {
    const source = sources[sourceName];
    for (const name of names) {
      Object.defineProperty(facade, name, {
        enumerable:true,
        configurable:false,
        writable:false,
        value:(...args) => {
          // Resolve the current own method on every call. The previous server.js
          // bridges had live semantics, so a service method replacement must not
          // leave this facade calling a stale captured function.
          const descriptor = Object.getOwnPropertyDescriptor(source, name);
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
            throw new Error(`${label} contract changed: ${sourceName}.${name}`);
          }
          return descriptor.value.apply(source, args);
        },
      });
    }
  }
  return Object.freeze(facade);
}

function createNotificationApplication(options = {}) {
  const applicationContext = requiredObject(options.applicationContext, 'applicationContext');
  requiredFunctions(applicationContext, 'applicationContext', ['registerMany', 'current']);

  const pwaRegistry = requiredObject(options.pwaRegistry, 'pwaRegistry');
  requiredFunctions(pwaRegistry, 'pwaRegistry', ['validate', 'bind']);
  const pwaDevice = requiredObject(pwaRegistry.device, 'pwaRegistry.device');
  const pwaEvent = requiredObject(pwaRegistry.event, 'pwaRegistry.event');

  const platform = requiredObject(options.platform, 'platform');
  const config = requiredObject(options.config, 'config');
  requiredProperties(config, 'config', [
    'APP_NAME', 'APP_VERSION', 'DATA_DIR', 'PUBLIC_URL', 'TRUST_PROXY', 'STORAGE_SETUP',
    'WEBHOOK_URL', 'WEBHOOK_FORMAT', 'SMTP_URL', 'EMAIL_FROM', 'EMAIL_TO',
  ]);
  const state = requiredObject(options.state, 'state adapters');
  const settingsService = requiredObject(options.settingsService, 'settingsService');
  const accountService = requiredObject(options.accountService, 'accountService');
  const sharePresentationService = requiredObject(options.sharePresentationService, 'sharePresentationService');
  const activityPresenceService = requiredObject(options.activityPresenceService, 'activityPresenceService');
  const auditService = requiredObject(options.auditService, 'auditService');
  const bridges = requiredObject(options.bridges, 'bridges');
  const utils = requiredObject(options.utils, 'utils');

  requiredFunctions(state, 'state', ['getState', 'persist', 'persistNow', 'scheduleFlush']);
  requiredFunctions(settingsService, 'settingsService', ['getSettings']);
  requiredFunctions(accountService, 'accountService', ['accountList', 'getAccountById']);
  requiredFunctions(sharePresentationService, 'sharePresentationService', ['decorateShare']);
  requiredFunctions(activityPresenceService, 'activityPresenceService', ['pubIp', 'emitLiveActivity']);
  requiredFunctions(auditService, 'auditService', [
    'logAudit', 'setSecurityAlertHandler', 'getKeyMigrationStatus',
  ]);
  requiredFunctions(bridges, 'bridges', [
    'getById', 'getByToken', 'isActive', 'listShares',
    'shareFirstUseDeadline', 'shareInactiveDeadline', 'shareEffectiveExpiry',
    'parseMaxVisitors', 'centerPublicVisitorDeviceLabel',
    'getShareMediaTransferApplication', 'getUploadReceptionService',
    'dataWritable', 'clientIp',
  ]);
  requiredFunctions(utils, 'utils', ['formatBytes', 'flagFromCode']);
  requiredFunctions(pwaDevice, 'pwaRegistry.device', [
    'getPwaDevice', 'pwaDeviceCreatorAccount', 'pwaDeviceOwnerAccount',
    'pwaDeviceResolvedAccount', 'pwaDevices',
  ]);
  requiredFunctions(pwaEvent, 'pwaRegistry.event', ['ownerKeysForShare', 'shareOwnerAccount', 'emitPwaOwnerEvent']);

  const getState = state.getState;
  const persist = state.persist;
  const persistNow = state.persistNow;
  const scheduleFlush = state.scheduleFlush;
  const getSettings = settingsService.getSettings;
  const webpush = platform.webpush || null;

  function shareMediaApplication() {
    const app = bridges.getShareMediaTransferApplication();
    if (!app || typeof app !== 'object') throw new Error('notification dependency not ready: share-media-transfer application');
    return app;
  }

  function uploadService() {
    const service = bridges.getUploadReceptionService();
    if (!service || typeof service !== 'object') throw new Error('notification dependency not ready: upload-reception service');
    return service;
  }

  let notificationCenterService = null;
  const notificationService = createNotificationService({
    APP_NAME:config.APP_NAME,
    WEBHOOK_URL:config.WEBHOOK_URL,
    WEBHOOK_FORMAT:config.WEBHOOK_FORMAT,
    SMTP_URL:config.SMTP_URL,
    EMAIL_FROM:config.EMAIL_FROM,
    EMAIL_TO:config.EMAIL_TO,
    ASVS_L3_MODE:config.ASVS_L3_MODE === true,
    ASVS_L3_EGRESS_ALLOWLIST:config.ASVS_L3_EGRESS_ALLOWLIST,
    nodemailer:platform.nodemailer || null,
    webpush,
    getSettings,
    formatBytes:utils.formatBytes,
    persist,
    persistNow,
    getById:bridges.getById,
    getByToken:bridges.getByToken,
    notificationAccountIdForShare:(...args) => notificationCenterService
      ? notificationCenterService.notificationAccountIdForShare(...args) : null,
    notificationAdminAccountIds:(...args) => notificationCenterService
      ? notificationCenterService.notificationAdminAccountIds(...args) : [],
    pushSubscriptionsForAccountIds:(...args) => notificationCenterService
      ? notificationCenterService.pushSubscriptionsForAccountIds(...args) : [],
    noteCenterServiceState:(...args) => notificationCenterService
      ? notificationCenterService.noteCenterServiceState(...args) : undefined,
    noteExpiredPushSub:(...args) => notificationCenterService
      ? notificationCenterService.noteExpiredPushSub(...args) : undefined,
    shareFirstUseDeadline:bridges.shareFirstUseDeadline,
    shareInactiveDeadline:bridges.shareInactiveDeadline,
    isActive:bridges.isActive,
    listShares:bridges.listShares,
    addShareCenterNotification:(...args) => notificationCenterService
      ? notificationCenterService.addShareCenterNotification(...args) : null,
    logAudit:auditService.logAudit,
    readLogTail:(...args) => {
      const service = shareMediaApplication().transferService;
      if (!service || typeof service.readLogTail !== 'function') {
        throw new Error('notification dependency not ready: transferService.readLogTail');
      }
      return service.readLogTail(...args);
    },
    getState,
  });

  notificationCenterService = createNotificationCenterService({
    APP_VERSION:config.APP_VERSION,
    DATA_DIR:config.DATA_DIR,
    PUBLIC_URL:config.PUBLIC_URL,
    TRUST_PROXY:config.TRUST_PROXY,
    STORAGE_SETUP:config.STORAGE_SETUP,
    getState,
    getSettings,
    scheduleFlush,
    persist,
    persistNow,
    accountList:accountService.accountList,
    getAccountById:accountService.getAccountById,
    shareOwnerAccount:pwaEvent.shareOwnerAccount,
    getPwaDevice:pwaDevice.getPwaDevice,
    pwaDeviceCreatorAccount:pwaDevice.pwaDeviceCreatorAccount,
    pwaDeviceOwnerAccount:pwaDevice.pwaDeviceOwnerAccount,
    pwaDeviceResolvedAccount:pwaDevice.pwaDeviceResolvedAccount,
    pwaDevices:pwaDevice.pwaDevices,
    getById:bridges.getById,
    getByToken:bridges.getByToken,
    listShares:bridges.listShares,
    isActive:bridges.isActive,
    shareEffectiveExpiry:bridges.shareEffectiveExpiry,
    decorateShare:sharePresentationService.decorateShare,
    formatBytes:utils.formatBytes,
    flagFromCode:utils.flagFromCode,
    pubIp:activityPresenceService.pubIp,
    parseMaxVisitors:bridges.parseMaxVisitors,
    centerPublicVisitorDeviceLabel:bridges.centerPublicVisitorDeviceLabel,
    pendingUsageForShare:(...args) => {
      const service = uploadService();
      if (typeof service.pendingUsageForShare !== 'function') {
        throw new Error('notification dependency not ready: uploadReceptionService.pendingUsageForShare');
      }
      return service.pendingUsageForShare(...args);
    },
    photoStatsOf:(...args) => {
      const service = shareMediaApplication().photoService;
      if (!service || typeof service.photoStatsOf !== 'function') {
        throw new Error('notification dependency not ready: photoService.photoStatsOf');
      }
      return service.photoStatsOf(...args);
    },
    dataWritable:bridges.dataWritable,
    emitLiveActivity:activityPresenceService.emitLiveActivity,
    checkExpiringShares:notificationService.checkExpiringShares,
    pushSubs:notificationService.pushSubs,
    getActiveTransfers:() => {
      try {
        const service = shareMediaApplication().transferService;
        return service && service.activeTransfers instanceof Map ? service.activeTransfers : new Map();
      } catch (_) { return new Map(); }
    },
    getSearchIndexError:() => {
      try { return shareMediaApplication().getSearchIndexError(); }
      catch (_) { return null; }
    },
    getAuditKeyMigrationStatus:() => auditService.getKeyMigrationStatus(),
    webPushAvailable:() => !!webpush,
    getDlpOcrUnavailableNotedAt:() => {
      try {
        const service = shareMediaApplication().dlpService;
        return service && typeof service.getOcrUnavailableNotedAt === 'function'
          ? service.getOcrUnavailableNotedAt() : 0;
      } catch (_) { return 0; }
    },
  });

  const pwaNotificationService = createPwaNotificationService({
    APP_NAME:config.APP_NAME,
    getState,
    getPwaDevice:pwaDevice.getPwaDevice,
    pwaDeviceCreatorAccount:pwaDevice.pwaDeviceCreatorAccount,
    pwaDeviceOwnerAccount:pwaDevice.pwaDeviceOwnerAccount,
    pwaDevices:pwaDevice.pwaDevices,
    pushSubs:notificationService.pushSubs,
    ownerKeysForShare:pwaEvent.ownerKeysForShare,
    sendWebPush:notificationService.sendWebPush,
    sendWebPushAwaited:notificationService.sendWebPushAwaited,
    webPushAvailable:() => !!webpush,
    effectiveWebhook:notificationService.effectiveWebhook,
    sendWebhook:notificationService.sendWebhook,
    emailConfigured:notificationService.emailConfigured,
    sendMail:notificationService.sendMail,
    addFirstViewCenterNotification:notificationCenterService.addFirstViewCenterNotification,
    emitPwaOwnerEvent:pwaEvent.emitPwaOwnerEvent,
    persist,
    scheduleFlush,
    logAudit:auditService.logAudit,
    clientIp:bridges.clientIp,
  });

  const shareMediaHooks = createLiveMethodFacade(
    'notification share/media hooks',
    { notificationService, notificationCenterService, pwaNotificationService, auditService },
    SHARE_MEDIA_NOTIFICATION_HOOKS,
  );

  // Validate the deferred PWA contract before mutating either external registry.
  pwaRegistry.validate('notification', pwaNotificationService);
  pwaRegistry.bind('notification', pwaNotificationService);
  auditService.setSecurityAlertHandler(notificationService.maybeSecurityAlert);

  function applicationDomainEntries() {
    return Object.freeze([
      ['notification', notificationService],
      ['notification-center', notificationCenterService],
      ['pwa-notification', pwaNotificationService],
    ].map((entry) => Object.freeze(entry)));
  }

  let registrationPhase = 'idle';
  let registrationFailure = null;
  function registerApplicationDomains() {
    if (registrationPhase === 'registered') return;
    if (registrationPhase === 'registering') throw new Error('notification application registration is already in progress');
    if (registrationPhase === 'failed') {
      const error = new Error('notification application registration previously failed; restart is required');
      if (registrationFailure) error.cause = registrationFailure;
      throw error;
    }

    // The global application-publication boundary may publish every application
    // domain atomically in one batch. Treat a complete identity-equal publication
    // as success, but keep rejecting partial or foreign pre-publication.
    const applicationDomains = applicationDomainEntries();
    let published = 0;
    for (const [name, service] of applicationDomains) {
      const current = applicationContext.current(name);
      if (current === service) { published += 1; continue; }
      if (current != null) throw new Error(`notification application domain already registered: ${name}`);
    }
    if (published === applicationDomains.length) {
      registrationFailure = null;
      registrationPhase = 'registered';
      return;
    }
    if (published !== 0) {
      for (const [name] of applicationDomains) {
        if (applicationContext.current(name) != null) throw new Error(`notification application domain already registered: ${name}`);
      }
      throw new Error('notification application domains are only partially published');
    }

    registrationPhase = 'registering';
    try {
      applicationContext.registerMany(applicationDomains);
      registrationFailure = null;
      registrationPhase = 'registered';
    } catch (error) {
      registrationFailure = error;
      registrationPhase = 'failed';
      throw error;
    }
  }

  function isBusyForStateReplacement() {
    return !!(notificationService.isBusyForStateReplacement
      && notificationService.isBusyForStateReplacement())
      || !!(pwaNotificationService.isBusyForStateReplacement
        && pwaNotificationService.isBusyForStateReplacement());
  }

  return Object.freeze({
    notificationService,
    notificationCenterService,
    pwaNotificationService,
    shareMediaHooks,
    applicationDomainEntries,
    registerApplicationDomains,
    isBusyForStateReplacement,
    clearNotificationRuntimeState:notificationService.clearRuntimeState,
    clearNotificationCenterRuntimeState:notificationCenterService.clearRuntimeState,
    clearPwaNotificationRuntimeState:pwaNotificationService.clearRuntimeState,
  });
}

module.exports = { NOTIFICATION_CONTEXT_DOMAINS, createNotificationApplication };
