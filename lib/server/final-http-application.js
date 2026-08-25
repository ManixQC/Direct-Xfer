'use strict';

/**
 * Final administrator/HTTP/PWA composition boundary.
 *
 * server.js owns the global bootstrap order; this module owns the last cohesive
 * stage once every domain needed by the HTTP surface has been published. It
 * creates the root handlers, composes the administrator application, publishes
 * its bootstrap references, then builds the HTTP/PWA/process-lifecycle graph.
 */
const { createRootRoutes } = require('./root-routes');
const { createAdminApplication } = require('./admin-application');
const {
  PWA_CONTEXT_DOMAINS,
  PWA_REGISTRY_SERVICES,
  createHttpPwaLifecycleApplication,
} = require('./http-pwa-lifecycle-application');

function requireObject(value, label) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Array.isArray(value)) {
    throw new TypeError(`final-http application requires ${label}`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`final-http application requires ${label}()`);
  return value;
}

function ownValue(source, name, label) {
  requireObject(source, label);
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
    throw new TypeError(`final-http application requires ${label}.${name} as an own data property`);
  }
  return descriptor.value;
}

function ownFunction(source, name, label) {
  const value = ownValue(source, name, label);
  if (typeof value !== 'function') throw new TypeError(`final-http application requires ${label}.${name}()`);
  return value;
}

// Deferred PWA facades are Proxies by design: reading a missing operation records
// its contract for the concrete service that will be bound later. Unlike ordinary
// application/service objects, they intentionally do not expose own descriptors.
function deferredFacadeFunction(source, name, label) {
  requireObject(source, label);
  const value = source[name];
  if (typeof value !== 'function') throw new TypeError(`final-http application requires ${label}.${name}()`);
  return value;
}

function requireDomain(context, name) {
  const value = context.current(name);
  if (!value) throw new TypeError(`final-http application context is missing ${name}`);
  return value;
}



const FINAL_ADMIN_CONTEXT_DOMAINS = Object.freeze([
  'admin-boundary', 'service-refs', 'admin-adapters', 'storage-jobs', 'storage-adapters',
  'share-route-adapters', 'share-core-output', 'diagnostics', 'system-health',
  'late-service-refs', 'late-adapters',
]);
const FINAL_CONTEXT_TARGETS = Object.freeze([
  ...FINAL_ADMIN_CONTEXT_DOMAINS,
  'http-application',
  ...PWA_CONTEXT_DOMAINS,
]);
const FINAL_BOOTSTRAP_TARGETS = Object.freeze(['admin', 'adminShareCore']);

function preflightFinalPublicationTargets({ context, bootstrapReferences, pwaRegistry }) {
  const currentDomain = requireFunction(context && context.current, 'application context.current');
  const currentBootstrap = requireFunction(bootstrapReferences && bootstrapReferences.current, 'bootstrap references.current');
  const currentPwa = requireFunction(pwaRegistry && pwaRegistry.current, 'PWA service registry.current');

  for (const name of FINAL_CONTEXT_TARGETS) {
    if (currentDomain.call(context, name) != null) {
      throw new Error(`final-http application context target already registered: ${name}`);
    }
  }
  for (const name of FINAL_BOOTSTRAP_TARGETS) {
    if (currentBootstrap.call(bootstrapReferences, name) != null) {
      throw new Error(`final-http bootstrap reference target already bound: ${name}`);
    }
  }
  for (const name of PWA_REGISTRY_SERVICES) {
    if (currentPwa.call(pwaRegistry, name) != null) {
      throw new Error(`final-http PWA service target already bound: ${name}`);
    }
  }
}

function validateFinalLifecycleService(value) {
  const lifecycleService = requireObject(value, 'lifecycle service');
  for (const name of ['start', 'shutdown', 'getServer', 'getServerScheme']) {
    ownFunction(lifecycleService, name, 'lifecycle service');
  }
  return lifecycleService;
}

function requireRootDir(value) {
  const rootDir = String(value || '').trim();
  if (!rootDir) throw new TypeError('final-http application requires rootDir');
  return rootDir;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`final-http application requires ${label} to be a non-negative integer`);
  }
  return value;
}

function createFinalHttpApplication(options = {}) {
  const context = requireObject(options.context, 'application context');
  for (const method of ['current', 'register']) requireFunction(context[method], `application context.${method}`);
  const rootDir = requireRootDir(options.rootDir);
  const bootstrap = requireObject(options.bootstrap, 'runtime bootstrap');
  const bootstrapReferences = requireObject(options.bootstrapReferences, 'bootstrap references');
  const bindAdmin = requireFunction(bootstrapReferences.bindAdmin, 'bootstrap references.bindAdmin');
  requireFunction(bootstrapReferences.current, 'bootstrap references.current');
  const pwaRegistry = requireObject(options.pwaRegistry, 'PWA service registry');
  requireFunction(pwaRegistry.current, 'PWA service registry.current');
  const requestContext = requireObject(options.requestContext, 'request context');
  requireFunction(requestContext.run, 'request context.run');
  const bus = requireObject(options.bus, 'lifecycle event bus');
  requireFunction(bus.on, 'lifecycle event bus.on');
  const applications = requireObject(options.applications, 'applications');
  const shareMediaTransferApplication = requireObject(
    applications.shareMediaTransferApplication,
    'applications.shareMediaTransferApplication'
  );
  const publicHttpApplication = requireObject(
    applications.publicHttpApplication,
    'applications.publicHttpApplication'
  );
  const live = requireObject(options.live, 'live bindings');
  const runtime = requireObject(options.runtime, 'runtime bindings');

  const getState = requireFunction(live.getState, 'live.getState');
  const setState = requireFunction(live.setState, 'live.setState');
  const getWebpush = requireFunction(live.getWebpush, 'live.getWebpush');
  const getServerScheme = requireFunction(runtime.getServerScheme, 'runtime.getServerScheme');
  const shutdown = requireFunction(runtime.shutdown, 'runtime.shutdown');
  const getServer = requireFunction(runtime.getServer, 'runtime.getServer');
  const undoLogMax = requireNonNegativeInteger(runtime.undoLogMax, 'runtime.undoLogMax');

  // Every context dependency needed by the root/admin/final HTTP stage is resolved
  // before the administrator application starts publishing its own domains.
  const config = requireDomain(context, 'config');
  const platform = requireDomain(context, 'platform');
  const accountService = requireDomain(context, 'account');
  const networkServices = requireDomain(context, 'network');
  const authService = requireDomain(context, 'auth');
  const tlsManager = requireDomain(context, 'tls-manager');

  const fs = ownValue(platform, 'fs', 'platform');
  const crypto = ownValue(platform, 'crypto', 'platform');
  const forge = ownValue(platform, 'forge', 'platform');
  const attemptLogin = ownFunction(authService, 'attemptLogin', 'auth');
  const accountNeedsPwChange = ownFunction(accountService, 'accountNeedsPasswordChange', 'account');
  const dataWritable = ownFunction(bootstrap, 'dataWritable', 'runtime bootstrap');
  const updateState = ownValue(networkServices, 'updateState', 'network');

  const getSearchIndexBuilding = ownFunction(
    shareMediaTransferApplication,
    'getSearchIndexBuilding',
    'share-media-transfer application'
  );
  const getSearchIndexError = ownFunction(
    shareMediaTransferApplication,
    'getSearchIndexError',
    'share-media-transfer application'
  );
  const getUniversalSearchIndex = ownFunction(
    shareMediaTransferApplication,
    'getUniversalSearchIndex',
    'share-media-transfer application'
  );
  const visitorFeedbackMax = requireNonNegativeInteger(
    ownValue(publicHttpApplication, 'VISITOR_FEEDBACK_MAX', 'public-http application'),
    'public-http application.VISITOR_FEEDBACK_MAX'
  );

  // Reject every known shared publication conflict before the administrator
  // application starts registering domains. This keeps deterministic stale/retry
  // conflicts from poisoning the context before the final stage has even started.
  preflightFinalPublicationTargets({ context, bootstrapReferences, pwaRegistry });

  const pwaDevice = requireObject(ownValue(pwaRegistry, 'device', 'PWA service registry'), 'PWA device facade');
  const pwaEvent = requireObject(ownValue(pwaRegistry, 'event', 'PWA service registry'), 'PWA event facade');
  const pwaAdminAdapters = Object.freeze({
    pwaDeviceResolvedAccount:deferredFacadeFunction(pwaDevice, 'pwaDeviceResolvedAccount', 'PWA device facade'),
    cleanupPwaCapabilityScopes:deferredFacadeFunction(pwaDevice, 'cleanupPwaCapabilityScopes', 'PWA device facade'),
    inboxReceivedFiles:deferredFacadeFunction(pwaEvent, 'inboxReceivedFiles', 'PWA event facade'),
    stampPhotoUploadDevice:deferredFacadeFunction(pwaDevice, 'stampPhotoUploadDevice', 'PWA device facade'),
    photoUploadDeviceName:deferredFacadeFunction(pwaDevice, 'photoUploadDeviceName', 'PWA device facade'),
  });

  // Deferred facade reads can register PWA method requirements. Recheck every
  // publication target afterwards so a re-entrant/custom registry cannot mutate
  // a shared slot between the first preflight and administrator composition.
  preflightFinalPublicationTargets({ context, bootstrapReferences, pwaRegistry });

  const rootRoutes = createRootRoutes({
    APP_NAME:ownValue(config, 'APP_NAME', 'config'),
    APP_VERSION:ownValue(config, 'APP_VERSION', 'config'),
    APP_YEAR:ownValue(config, 'APP_YEAR', 'config'),
    RELEASE_DATE:ownValue(config, 'RELEASE_DATE', 'config'),
    STORAGE_SETUP:ownValue(bootstrap, 'storageSetup', 'runtime bootstrap'),
    ASVS_L3_MODE:ownValue(config, 'ASVS_L3_MODE', 'config') === true,
    fs, crypto, forge,
    attemptLogin, accountNeedsPwChange, accountService, dataWritable,
    updateState,
    tlsManager,
    localCaFeatureRelevant:ownFunction(tlsManager, 'localCaFeatureRelevant', 'tls-manager'),
    localCaModeActive:ownFunction(tlsManager, 'localCaModeActive', 'tls-manager'),
    localCaPaths:ownFunction(tlsManager, 'localCaPaths', 'tls-manager'),
    validateLocalCaCertificate:ownFunction(tlsManager, 'validateLocalCaCertificate', 'tls-manager'),
    certificateFingerprint256:ownFunction(tlsManager, 'certificateFingerprint256', 'tls-manager'),
    readLocalCaCertificateOnly:ownFunction(tlsManager, 'readLocalCaCertificateOnly', 'tls-manager'),
    ensureLocalCa:ownFunction(tlsManager, 'ensureLocalCa', 'tls-manager'),
  });

  // Admin is composed before PWA, but its diagnostics route needs the pair-ticket
  // Map only after PWA publication. Keep exactly one late cell inside this boundary.
  let pwaPairTickets = null;
  const adminApplication = createAdminApplication({
    context,
    bootstrap,
    live:{
      getState,
      setState,
      getSearchIndexBuilding,
      getSearchIndexError,
      getUniversalSearchIndex,
      getPwaPairTickets:() => pwaPairTickets,
    },
    pwa:pwaAdminAdapters,
    runtime:{ getServerScheme, undoLogMax, visitorFeedbackMax },
    rootRoutes,
  });
  bindAdmin.call(bootstrapReferences, adminApplication);

  const httpPwaLifecycleApplication = createHttpPwaLifecycleApplication({
    context,
    rootDir,
    bootstrap,
    pwaRegistry,
    rootRoutes,
    adminApplication,
    requestContext,
    bus,
    live:{ getState, setState, getSearchIndexBuilding, getUniversalSearchIndex, getWebpush },
    bridges:{ shutdown, getServer },
  });

  // Revalidate the two values consumed by this outer boundary. The lower HTTP/PWA
  // composition validates the same lifecycle surface before committing shared PWA
  // state; this second check prevents a future return-shape regression from escaping
  // the boundary and failing later at server.js lifecycleService.start().
  pwaPairTickets = ownValue(httpPwaLifecycleApplication, 'pairTickets', 'HTTP/PWA lifecycle application');
  if (!(pwaPairTickets instanceof Map)) {
    throw new TypeError('final-http application requires HTTP/PWA pairTickets to be a Map');
  }
  const lifecycleService = validateFinalLifecycleService(
    ownValue(httpPwaLifecycleApplication, 'lifecycleService', 'HTTP/PWA lifecycle application')
  );

  return Object.freeze({
    rootRoutes,
    adminApplication,
    httpPwaLifecycleApplication,
    lifecycleService,
  });
}

module.exports = {
  FINAL_ADMIN_CONTEXT_DOMAINS,
  FINAL_CONTEXT_TARGETS,
  FINAL_BOOTSTRAP_TARGETS,
  preflightFinalPublicationTargets,
  validateFinalLifecycleService,
  createFinalHttpApplication,
};
