'use strict';

/**
 * Final application-domain publication boundary.
 *
 * Domain-producing applications are composed earlier, but their route-facing
 * namespaces become visible together here. The complete graph is prevalidated
 * against an isolated application context (including the reception/collaboration
 * route contract) before the production context is mutated once via registerMany.
 */
const { createApplicationContext } = require('./application-context');
const { DIRECT_APPLICATION_DOMAINS, createApplicationDomainEntries } = require('./register-application-domains');
const { RUNTIME_CONTEXT_DOMAINS } = require('./runtime-services-application');
const { NOTIFICATION_CONTEXT_DOMAINS } = require('./notification-application');
const { SHARE_MEDIA_CONTEXT_DOMAINS } = require('./share-media-transfer-application');
const { PUBLIC_CONTEXT_DOMAINS } = require('./public-http-application');
const { attachReceptionCollaborationRoutes } = require('./reception-collaboration-routes');

const RECEPTION_COLLABORATION_DOMAINS = Object.freeze([
  'config', 'platform', 'core-utils', 'state-store', 'settings', 'activity', 'audit',
  'notification', 'notification-center', 'share', 'photo', 'search-compat', 'transfer',
  'network', 'public-pages', 'public-access', 'public-abuse', 'download', 'public-share', 'upload',
  'maintenance', 'early-adapters',
]);

const APPLICATION_ORDER = Object.freeze([
  'runtimeServicesApplication',
  'notificationApplication',
  'shareMediaTransferApplication',
  'publicHttpApplication',
]);
const APPLICATION_DOMAIN_CONTRACTS = Object.freeze({
  runtimeServicesApplication:RUNTIME_CONTEXT_DOMAINS,
  notificationApplication:NOTIFICATION_CONTEXT_DOMAINS,
  shareMediaTransferApplication:SHARE_MEDIA_CONTEXT_DOMAINS,
  publicHttpApplication:PUBLIC_CONTEXT_DOMAINS,
});

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`application publication requires ${label}`);
  }
  return value;
}

function ownMethod(source, name, label) {
  requiredObject(source, label);
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`application publication requires ${label}.${name}()`);
  }
  return descriptor.value.bind(source);
}

function requiredOwnValue(source, name, label) {
  requiredObject(source, label);
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value == null) {
    throw new TypeError(`application publication requires ${label}.${name}`);
  }
  return descriptor.value;
}

function validateEntryBatch(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError(`application publication requires a non-empty ${label} domain batch`);
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError(`application publication ${label} domains must contain [name, source] pairs`);
    }
  }
  return entries;
}

function createRoutePreflightRouter() {
  const router = Object.create(null);
  for (const verb of ['get', 'post']) {
    Object.defineProperty(router, verb, {
      enumerable:true,
      value(routePath, ...handlers) {
        const paths = Array.isArray(routePath) ? routePath : [routePath];
        if (!paths.length || paths.some((item) => typeof item !== 'string' || !item)) {
          throw new TypeError(`reception/collaboration preflight requires a ${verb.toUpperCase()} route path`);
        }
        if (!handlers.length || handlers.some((handler) => typeof handler !== 'function')) {
          throw new TypeError(`reception/collaboration preflight found an invalid ${verb.toUpperCase()} handler for ${routePath}`);
        }
        return router;
      },
    });
  }
  return Object.freeze(router);
}


function findDataMethod(source, name) {
  if ((typeof source !== 'object' || source === null) && typeof source !== 'function') return null;
  let cursor = source;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') return null;
      return descriptor.value;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return null;
}

function validateReceptionRouter(router) {
  if (!findDataMethod(router, 'get') || !findDataMethod(router, 'post')) {
    throw new TypeError('application publication requires reception downloadRouter.get() and downloadRouter.post()');
  }
  return router;
}

function receptionOverrides(reception, downloadRouter = undefined) {
  const source = requiredObject(reception, 'reception options');
  const overrides = {
    PENDING_DIR:requiredOwnValue(source, 'PENDING_DIR', 'reception options'),
    live:requiredOwnValue(source, 'live', 'reception options'),
  };
  if (downloadRouter !== undefined) overrides.downloadRouter = downloadRouter;
  return Object.freeze(overrides);
}

function collectApplicationEntries(applications) {
  const source = requiredObject(applications, 'applications');
  const batches = [];
  for (const name of APPLICATION_ORDER) {
    const application = requiredOwnValue(source, name, 'applications');
    const getEntries = ownMethod(application, 'applicationDomainEntries', `applications.${name}`);
    const entries = validateEntryBatch(getEntries(), `applications.${name}`);
    const actualNames = entries.map((entry) => entry[0]);
    const expectedNames = APPLICATION_DOMAIN_CONTRACTS[name];
    if (actualNames.length !== expectedNames.length
      || actualNames.some((domain, index) => domain !== expectedNames[index])) {
      throw new Error(`application publication domain contract mismatch for ${name}: expected ${expectedNames.join(',')}`);
    }
    batches.push(entries);
  }
  return batches;
}

function publishApplicationGraph(options = {}) {
  const applicationContext = requiredObject(options.applicationContext, 'applicationContext');
  const registerMany = ownMethod(applicationContext, 'registerMany', 'applicationContext');
  const route = ownMethod(applicationContext, 'route', 'applicationContext');
  const domains = ownMethod(applicationContext, 'domains', 'applicationContext');
  const baselineDomains = domains();
  if (!Array.isArray(baselineDomains) || baselineDomains.some((name) => typeof name !== 'string')) {
    throw new TypeError('application publication requires applicationContext.domains() to return domain names');
  }
  const baselineDomainNames = Object.freeze([...baselineDomains]);

  const direct = requiredObject(options.direct, 'direct domain options');
  const directEntries = validateEntryBatch(
    createApplicationDomainEntries(direct),
    'direct',
  );
  if (directEntries.length !== DIRECT_APPLICATION_DOMAINS.length
    || directEntries.some((entry, index) => entry[0] !== DIRECT_APPLICATION_DOMAINS[index])) {
    throw new Error('application publication direct-domain contract mismatch');
  }
  const applicationBatches = collectApplicationEntries(options.applications);

  // Preserve the historical namespace insertion order: runtime domains were
  // published first, then direct/root domains, then notification/share/public.
  const [runtimeEntries, notificationEntries, shareEntries, publicEntries] = applicationBatches;
  const entries = [
    ...runtimeEntries,
    ...directEntries,
    ...notificationEntries,
    ...shareEntries,
    ...publicEntries,
  ];

  // Prevalidate both the complete namespace transaction and the writable-link
  // route facade using an isolated registry. The *real* downloadRouter is resolved
  // first so an ambiguity/missing registrar cannot be hidden by the side-effect-free
  // router used to dry-run handler construction.
  const preflightContext = createApplicationContext();
  preflightContext.registerMany(entries);
  const actualPreflightFacade = preflightContext.route(
    'receptionCollaboration',
    RECEPTION_COLLABORATION_DOMAINS,
    receptionOverrides(options.reception),
  );
  validateReceptionRouter(actualPreflightFacade.downloadRouter);

  const preflightFacade = preflightContext.route(
    'receptionCollaboration',
    RECEPTION_COLLABORATION_DOMAINS,
    receptionOverrides(options.reception, createRoutePreflightRouter()),
  );
  attachReceptionCollaborationRoutes(preflightFacade);

  // Handler construction can call parser factories supplied by the composed
  // platform. Re-resolve the actual facade after that dry run so a source mutated
  // during preflight cannot become visible without a final contract check.
  const finalPreflightFacade = preflightContext.route(
    'receptionCollaboration',
    RECEPTION_COLLABORATION_DOMAINS,
    receptionOverrides(options.reception),
  );
  validateReceptionRouter(finalPreflightFacade.downloadRouter);

  // Nothing involved in the isolated preflight is allowed to publish into the
  // production context. registerMany() detects reentrance during its own validation,
  // but mutations that happened *before* that call need this outer guard.
  const currentDomains = domains();
  if (!Array.isArray(currentDomains)
    || currentDomains.length !== baselineDomainNames.length
    || currentDomains.some((name, index) => name !== baselineDomainNames[index])) {
    throw new Error('application context changed during application publication preflight');
  }

  const publishedDomains = registerMany(entries);
  const receptionFacade = route(
    'receptionCollaboration',
    RECEPTION_COLLABORATION_DOMAINS,
    receptionOverrides(options.reception),
  );
  attachReceptionCollaborationRoutes(receptionFacade);

  return Object.freeze({
    publishedDomains,
    receptionFacade,
  });
}

module.exports = {
  APPLICATION_DOMAIN_CONTRACTS,
  APPLICATION_ORDER,
  RECEPTION_COLLABORATION_DOMAINS,
  publishApplicationGraph,
};
