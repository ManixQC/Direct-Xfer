'use strict';

// Final HTTP/PWA/process-lifecycle composition boundary. The lower-level HTTP,
// PWA and lifecycle services stay independently testable; this module owns only
// their startup order and the narrow cross-domain adapters needed to connect them.
const { createHttpApplication } = require('./http-application');
const { createPwaApplication } = require('./pwa-application');
const { createLifecycleService } = require('./lifecycle-service');
const { attachWindowsLauncherRoutes } = require('./windows-launcher-routes');

const PWA_CONTEXT_DOMAINS = Object.freeze([
  'pwa-device', 'pwa-photo', 'pwa-webauthn', 'pwa-event',
]);
const PWA_REGISTRY_SERVICES = Object.freeze(['device', 'photo', 'webauthn', 'event']);
const UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function requireObject(value, label) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Array.isArray(value)) {
    throw new TypeError(`http-pwa-lifecycle application requires ${label}`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`http-pwa-lifecycle application requires ${label}`);
  return value;
}

function requireRootDir(value) {
  const rootDir = String(value || '').trim();
  if (!rootDir) throw new TypeError('http-pwa-lifecycle application requires rootDir');
  return rootDir;
}

function requireDomain(context, name) {
  const service = context.current(name);
  if (!service) throw new TypeError(`http-pwa-lifecycle application context is missing ${name}`);
  return service;
}

function stableValue(source, name, label) {
  requireObject(source, label);
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
    throw new TypeError(`http-pwa-lifecycle application ${label} is missing stable ${name}`);
  }
  return descriptor.value;
}

function stableFunction(source, name, label) {
  const fn = stableValue(source, name, label);
  if (typeof fn !== 'function') {
    throw new TypeError(`http-pwa-lifecycle application ${label}.${name} must be a function`);
  }
  return fn.bind(source);
}

function assertSafeName(name, label) {
  const value = String(name || '').trim();
  if (!value || UNSAFE_NAMES.has(value)) throw new TypeError(`invalid ${label}: ${name}`);
  return value;
}

// PWA composition needs http-application to be visible while it builds its route
// facades, but publishing that domain to the shared application context before the
// PWA bootstrap succeeds would poison a retry. Stage context and deferred-registry
// mutations, then publish them only after the complete PWA graph has been built.
function createContextTransaction(baseContext, seed = {}) {
  const context = requireObject(baseContext, 'application context');
  for (const method of ['current', 'register']) requireFunction(context[method], `application context.${method}`);
  const staged = new Map();
  let state = 'open';

  function requireOpen(action) {
    if (state !== 'open') throw new Error(`application context transaction cannot ${action} from state ${state}`);
  }

  function stage(name, source) {
    requireOpen('stage');
    const domain = assertSafeName(name, 'application context domain');
    requireObject(source, `application context domain ${domain}`);
    if (staged.has(domain) || context.current(domain) != null) {
      throw new Error(`application context domain already registered: ${domain}`);
    }
    staged.set(domain, source);
    return source;
  }

  for (const [name, source] of Object.entries(seed)) stage(name, source);

  const transaction = Object.freeze({
    current(name) {
      const domain = assertSafeName(name, 'application context domain');
      return staged.has(domain) ? staged.get(domain) : context.current(domain);
    },
    register:stage,
  });

  function preflight() {
    requireOpen('preflight');
    for (const [name] of staged) {
      if (context.current(name) != null) throw new Error(`application context domain already registered: ${name}`);
    }
    return true;
  }

  function commit() {
    requireOpen('commit');
    preflight();
    state = 'committing';
    try {
      for (const [name, source] of staged) context.register(name, source);
      state = 'committed';
      return true;
    } catch (error) {
      state = 'failed';
      throw error;
    }
  }

  return Object.freeze({
    context:transaction,
    entries:() => Object.freeze([...staged]),
    preflight,
    commit,
    state:() => state,
  });
}

function createRegistryTransaction(baseRegistry) {
  const registry = requireObject(baseRegistry, 'PWA service registry');
  for (const method of ['bind', 'current', 'validate']) requireFunction(registry[method], `PWA service registry.${method}`);
  const staged = new Map();
  let state = 'open';

  function requireOpen(action) {
    if (state !== 'open') throw new Error(`PWA service registry transaction cannot ${action} from state ${state}`);
  }

  const transaction = Object.freeze({
    current(name) {
      const key = String(name || '');
      return staged.has(key) ? staged.get(key) : registry.current(key);
    },
    validate(name, service) {
      const key = String(name || '');
      if (staged.has(key) && staged.get(key) !== service) throw new Error(`PWA service already bound: ${key}`);
      return registry.validate(key, service);
    },
    bind(name, service) {
      requireOpen('stage');
      const key = String(name || '');
      registry.validate(key, service);
      if (staged.has(key) && staged.get(key) !== service) throw new Error(`PWA service already bound: ${key}`);
      if (!staged.has(key) && registry.current(key) != null) throw new Error(`PWA service already bound: ${key}`);
      staged.set(key, service);
      return service;
    },
  });

  function preflight() {
    requireOpen('preflight');
    for (const [name, service] of staged) {
      if (registry.current(name) != null) throw new Error(`PWA service already bound: ${name}`);
      registry.validate(name, service);
    }
    return true;
  }

  function commit() {
    requireOpen('commit');
    preflight();
    state = 'committing';
    try {
      for (const [name, service] of staged) registry.bind(name, service);
      state = 'committed';
      return true;
    } catch (error) {
      state = 'failed';
      throw error;
    }
  }

  return Object.freeze({
    registry:transaction,
    entries:() => Object.freeze([...staged]),
    preflight,
    commit,
    state:() => state,
  });
}

function validatePwaApplicationResult(value) {
  const application = requireObject(value, 'PWA application result');
  const device = requireObject(stableValue(application, 'device', 'PWA application'), 'PWA device service');
  const photo = requireObject(stableValue(application, 'photo', 'PWA application'), 'PWA photo service');
  const webauthn = requireObject(stableValue(application, 'webauthn', 'PWA application'), 'PWA WebAuthn service');
  const event = requireObject(stableValue(application, 'event', 'PWA application'), 'PWA event service');
  const pairTickets = stableValue(application, 'pairTickets', 'PWA application');
  if (!(pairTickets instanceof Map)) throw new TypeError('http-pwa-lifecycle application requires PWA pair-ticket Map');
  const devicePairTickets = stableValue(device, 'pwaPairTickets', 'PWA device service');
  if (devicePairTickets !== pairTickets) throw new Error('http-pwa-lifecycle PWA pair-ticket identity mismatch');
  const stop = stableFunction(application, 'stop', 'PWA application');
  stableFunction(event, 'clearRuntimeState', 'PWA event service');
  return Object.freeze({ application, device, photo, webauthn, event, pairTickets, stop });
}



const REQUIRED_LIFECYCLE_METHODS = Object.freeze(['start', 'shutdown', 'getServer', 'getServerScheme']);

function validateLifecycleServiceResult(value) {
  const service = requireObject(value, 'lifecycle service result');
  for (const name of REQUIRED_LIFECYCLE_METHODS) stableFunction(service, name, 'lifecycle service');
  return service;
}

function createHttpPwaLifecycleApplication(options = {}) {
  const context = requireObject(options.context, 'application context');
  for (const method of ['current', 'register']) requireFunction(context[method], `application context.${method}`);
  const rootDir = requireRootDir(options.rootDir);
  const bootstrap = requireObject(options.bootstrap, 'runtime bootstrap');
  const pwaRegistry = requireObject(options.pwaRegistry, 'PWA service registry');
  const rootRoutes = requireObject(options.rootRoutes, 'root routes');
  const adminApplication = requireObject(options.adminApplication, 'administrator application');
  const requestContext = requireObject(options.requestContext, 'request context');
  const bus = requireObject(options.bus, 'lifecycle event bus');
  const live = requireObject(options.live, 'PWA live bindings');
  const bridges = requireObject(options.bridges, 'lifecycle bridges');

  requireFunction(requestContext.run, 'requestContext.run');
  requireFunction(bus.on, 'lifecycle event bus.on');
  const shutdown = requireFunction(bridges.shutdown, 'bridges.shutdown');
  const getServer = requireFunction(bridges.getServer, 'bridges.getServer');
  requireFunction(adminApplication.attachLateRoutes, 'administrator application.attachLateRoutes');
  requireObject(adminApplication.adminRouter, 'administrator router');
  for (const name of ['getState', 'setState', 'getSearchIndexBuilding', 'getUniversalSearchIndex', 'getWebpush']) {
    requireFunction(live[name], `live.${name}`);
  }
  for (const name of ['sendLocalCaCertificate', 'handleLogin', 'handleHealthz', 'handleMeta']) {
    requireFunction(rootRoutes[name], `rootRoutes.${name}`);
  }
  if (context.current('http-application') != null) {
    throw new Error('http-pwa-lifecycle application context domain already registered: http-application');
  }
  for (const name of PWA_CONTEXT_DOMAINS) {
    if (context.current(name) != null) throw new Error(`http-pwa-lifecycle application context domain already registered: ${name}`);
  }
  for (const name of PWA_REGISTRY_SERVICES) {
    if (pwaRegistry.current(name) != null) throw new Error(`http-pwa-lifecycle PWA service already bound: ${name}`);
  }

  // Resolve the entire cross-domain contract before mutating Express. This keeps a
  // missing service/method as a clean startup error rather than a half-attached app.
  const config = requireDomain(context, 'config');
  const platform = requireDomain(context, 'platform');
  const coreUtils = requireDomain(context, 'core-utils');
  const settings = requireDomain(context, 'settings');
  const account = requireDomain(context, 'account');
  const network = requireDomain(context, 'network');
  const activity = requireDomain(context, 'activity');
  const audit = requireDomain(context, 'audit');
  const notificationCenter = requireDomain(context, 'notification-center');
  const stateStore = requireDomain(context, 'state-store');
  const session = requireDomain(context, 'session');
  const auth = requireDomain(context, 'auth');
  const publicShare = requireDomain(context, 'public-share');
  const maintenance = requireDomain(context, 'maintenance');
  const tlsManager = requireDomain(context, 'tls-manager');
  const searchCompat = requireDomain(context, 'search-compat');
  const early = requireDomain(context, 'early-adapters');

  const express = stableValue(platform, 'express', 'platform');
  if (typeof express !== 'function' || typeof express.json !== 'function' || typeof express.static !== 'function') {
    throw new TypeError('http-pwa-lifecycle application requires Express with json/static helpers');
  }
  const crypto = stableValue(platform, 'crypto', 'platform');
  const path = stableValue(platform, 'path', 'platform');
  const downloadRouter = stableValue(publicShare, 'downloadRouter', 'public-share');
  if (typeof downloadRouter !== 'function' && (!downloadRouter || typeof downloadRouter.handle !== 'function')) {
    throw new TypeError('http-pwa-lifecycle application requires public-share.downloadRouter');
  }

  const getSettings = stableFunction(settings, 'getSettings', 'settings');
  const publicIpDiscoveryEnabled = stableFunction(settings, 'publicIpDiscoveryEnabled', 'settings');
  const clientIp = stableFunction(early, 'clientIp', 'early-adapters');
  const sendError = stableFunction(early, 'sendError', 'early-adapters');
  const ipInList = stableFunction(coreUtils, 'ipInList', 'core-utils');
  const isLoopback = stableFunction(coreUtils, 'isLoopback', 'core-utils');
  const parseIpList = stableFunction(coreUtils, 'parseIpList', 'core-utils');
  const isLocalNetwork = stableFunction(network, 'isLocalNetwork', 'network');
  const getPublicIP = stableFunction(network, 'getPublicIP', 'network');
  const checkForUpdate = stableFunction(network, 'checkForUpdate', 'network');
  const localCaModeActive = stableFunction(tlsManager, 'localCaModeActive', 'tls-manager');
  const loadTlsOptions = stableFunction(tlsManager, 'loadTlsOptions', 'tls-manager');
  const refreshLocalTlsServerContext = stableFunction(tlsManager, 'refreshLocalTlsServerContext', 'tls-manager');
  const refreshProvidedTlsServerContext = stableFunction(tlsManager, 'refreshProvidedTlsServerContext', 'tls-manager');
  const clearSessionsOfAccount = stableFunction(session, 'clearSessionsOfAccount', 'session');
  const ownerAccount = stableFunction(account, 'ownerAccount', 'account');
  const setAccountPassword = stableFunction(auth, 'setAccountPassword', 'auth');
  const logAudit = stableFunction(audit, 'logAudit', 'audit');
  const flushNow = stableFunction(stateStore, 'flushNow', 'state-store');
  const initUniversalSearchIndex = stableFunction(searchCompat, 'initUniversalSearchIndex', 'search-compat');
  const closeActivityPresenceStreams = stableFunction(activity, 'closeActivityPresenceStreams', 'activity');
  const noteCenterLifecycleStart = stableFunction(notificationCenter, 'noteCenterLifecycleStart', 'notification-center');
  const noteCenterInstalledVersion = stableFunction(notificationCenter, 'noteCenterInstalledVersion', 'notification-center');
  const checkCenterLinkStates = stableFunction(notificationCenter, 'checkCenterLinkStates', 'notification-center');
  const checkCenterSystemHealth = stableFunction(notificationCenter, 'checkCenterSystemHealth', 'notification-center');
  const noteCenterCleanShutdown = stableFunction(notificationCenter, 'noteCenterCleanShutdown', 'notification-center');

  requireFunction(bootstrap.ensureWindowsPortableFirewallAccess, 'runtime bootstrap.ensureWindowsPortableFirewallAccess');
  const dataWritable = requireFunction(bootstrap.dataWritable, 'runtime bootstrap.dataWritable').bind(bootstrap);
  const storageConnectorJobService = requireObject(adminApplication.storageConnectorJobService, 'connector job service');
  requireFunction(storageConnectorJobService.abortAll, 'connector job service.abortAll');
  requireFunction(storageConnectorJobService.waitForIdle, 'connector job service.waitForIdle');
  const accountService = account;
  for (const name of ['ownerLoginUsername', 'isEnvironmentPasswordManaged', 'hasFreshInitialPassword', 'initialPassword']) {
    requireFunction(accountService[name], `account.${name}`);
  }
  requireFunction(maintenance.start, 'maintenance.start');
  requireFunction(maintenance.stop, 'maintenance.stop');

  // Build every parser used by the root/admin surface before the first route is
  // attached. Express parser factories can fail under a broken/mocked runtime; a
  // failure here must not leave the PWA context published or the router half-built.
  const jsonParser = express.json({ limit:'256kb' });
  requireFunction(jsonParser, 'Express administrator JSON parser');

  const httpApplication = createHttpApplication({
    ADMIN_ALLOW_ANY:config.ADMIN_ALLOW_ANY,
    ADMIN_ALLOWED_IPS:config.ADMIN_ALLOWED_IPS,
    ASVS_L3_MODE:config.ASVS_L3_MODE,
    TRUST_PROXY:config.TRUST_PROXY,
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
    rootDir,
    sendError,
  });
  const { app, adminGuard, attachPublicAssetRoutes, attachAdminSpaAndFallbacks } = httpApplication;

  // Keep the HTTP/PWA publications transactional. Express is still private to this
  // call until the returned composition is published by server.js.
  const contextTx = createContextTransaction(context, { 'http-application':httpApplication });
  const registryTx = createRegistryTransaction(pwaRegistry);

  app.get('/direct-xfer-local-ca.cer', rootRoutes.sendLocalCaCertificate);

  attachWindowsLauncherRoutes({
    APP_NAME:config.APP_NAME,
    APP_VERSION:config.APP_VERSION,
    ADMIN_USERNAME:stableValue(account, 'adminUsername', 'account'),
    DX_WINDOWS_LAUNCHER_TOKEN:config.DX_WINDOWS_LAUNCHER_TOKEN,
    accountService,
    app,
    clearSessionsOfAccount,
    crypto,
    express,
    logAudit,
    ownerAccount,
    setAccountPassword,
    shutdown,
  });

  app.use('/', downloadRouter);
  attachPublicAssetRoutes();

  let pwaApplication = null;
  let pwaRuntime = null;
  let lifecycleService = null;
  try {
    pwaApplication = createPwaApplication({
      context:contextTx.context,
      registry:registryTx.registry,
      rootDir,
      live,
    });
    // Validate every value consumed after publication while the PWA graph is still
    // private. The previous composition checked event cleanup only after committing
    // shared context/registry slots, so a future PWA contract regression could leak
    // the retention timer and poison startup before throwing.
    pwaRuntime = validatePwaApplicationResult(pwaApplication);

    // createPwaApplication must publish exactly the four deferred service slots and
    // their context domains. Unexpected omissions/additions are a composition error.
    const stagedContextNames = contextTx.entries().map(([name]) => name);
    const expectedContext = ['http-application', ...PWA_CONTEXT_DOMAINS];
    if (stagedContextNames.length !== expectedContext.length || expectedContext.some((name) => !stagedContextNames.includes(name))) {
      throw new Error('http-pwa-lifecycle PWA context publication contract mismatch');
    }
    const stagedRegistryNames = registryTx.entries().map(([name]) => name);
    if (stagedRegistryNames.length !== PWA_REGISTRY_SERVICES.length || PWA_REGISTRY_SERVICES.some((name) => !stagedRegistryNames.includes(name))) {
      throw new Error('http-pwa-lifecycle PWA registry publication contract mismatch');
    }

    // Construct the lifecycle object before any shared PWA publication or late admin
    // route mutation. createLifecycleService is side-effect-free until start(), so a
    // missing lifecycle contract can still unwind the private PWA scheduler cleanly.
    lifecycleService = createLifecycleService({
      app,
      config,
      bootstrap,
      tlsManager,
      maintenanceService:maintenance,
      storageConnectorJobService,
      pwaEventService:pwaRuntime.event,
      stopPwaApplication:pwaRuntime.stop,
      accountService,
      bus,
      getSettings,
      dataWritable,
      initUniversalSearchIndex,
      flushNow,
      closeActivityPresenceStreams,
      liveActivityClients:stableValue(activity, 'liveActivityClients', 'activity'),
      presenceClients:stableValue(activity, 'presenceClients', 'activity'),
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
    // The PWA/context transactions must not commit a graph whose lifecycle cannot
    // satisfy the methods the outer composition root immediately relies on. Validate
    // the stable own-function surface while the PWA graph is still private.
    validateLifecycleServiceResult(lifecycleService);

    // Revalidate both targets immediately before the irreversible shared-context
    // publication. Node composition is synchronous, so no code can interleave after
    // this preflight and before the commits below.
    contextTx.preflight();
    registryTx.preflight();
    registryTx.commit();
    contextTx.commit();
  } catch (error) {
    if (pwaApplication && typeof pwaApplication.stop === 'function') {
      try { pwaApplication.stop(); } catch (_) {}
    }
    throw error;
  }

  try {
    // Root API order is security-sensitive: login is LAN-gated before its JSON
    // parser, public health/meta remain credential-free, then protected admin routes.
    app.post('/api/login', adminGuard, jsonParser, rootRoutes.handleLogin);
    app.get('/healthz', rootRoutes.handleHealthz);
    app.get('/api/meta', rootRoutes.handleMeta);

    adminApplication.attachLateRoutes({ shutdown, getServer });
    app.use('/api', adminGuard, jsonParser, adminApplication.adminRouter);
    attachAdminSpaAndFallbacks();
  } catch (error) {
    // Published context slots intentionally remain fail-stop: retrying a partially
    // attached Express/admin graph in-process is unsupported. We can still release
    // the only pre-start timer so tests/embedders do not retain a leaked scheduler.
    try { pwaRuntime.stop(); } catch (_) {}
    throw error;
  }

  return Object.freeze({
    app,
    httpApplication,
    pwaApplication,
    lifecycleService,
    device:pwaApplication.device,
    webauthn:pwaApplication.webauthn,
    event:pwaApplication.event,
    pairTickets:pwaApplication.pairTickets,
  });
}

module.exports = {
  PWA_CONTEXT_DOMAINS,
  PWA_REGISTRY_SERVICES,
  createContextTransaction,
  createRegistryTransaction,
  validatePwaApplicationResult,
  REQUIRED_LIFECYCLE_METHODS,
  validateLifecycleServiceResult,
  createHttpPwaLifecycleApplication,
};
