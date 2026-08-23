'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const {
  PWA_CONTEXT_DOMAIN_TARGETS,
  PWA_REGISTRY_SERVICE_TARGETS,
  PWA_ROUTE_FACADE_CONTEXT,
  bindStableServiceMethod,
  createPwaApplication,
  createPwaRouteFacades,
  mergeStableFacade,
} = require('../lib/server/pwa-application');
const {
  ROUTE_SERVICE_EXPORTS,
  createPwaServiceRegistry,
} = require('../lib/server/pwa-composition-service');

function marker() { return null; }

function fakeApp() {
  const routes = [];
  const app = { routes };
  for (const method of ['get', 'post', 'delete', 'put', 'patch', 'use', 'head', 'options']) {
    app[method] = (...args) => { routes.push({ method, args }); return app; };
  }
  return app;
}

function fakeExpress() { return fakeApp(); }
fakeExpress.json = () => marker;
fakeExpress.raw = () => marker;
fakeExpress.static = () => marker;

function routeService(name) {
  const service = Object.create(null);
  for (const operation of ROUTE_SERVICE_EXPORTS[name]) service[operation] = marker;
  return service;
}

function createFixture() {
  const app = fakeApp();
  const domains = Object.create(null);

  for (const spec of Object.values(PWA_ROUTE_FACADE_CONTEXT)) {
    for (const [, [domain, property]] of Object.entries(spec)) {
      if (!domains[domain]) domains[domain] = Object.create(null);
      if (!Object.prototype.hasOwnProperty.call(domains[domain], property)) domains[domain][property] = marker;
    }
  }

  domains.platform = Object.assign(domains.platform || Object.create(null), {
    fs, path, crypto, express:fakeExpress, QRCode:{ toString() {} },
  });
  domains['http-application'] = Object.assign(domains['http-application'] || Object.create(null), { app, adminGuard:marker });
  domains.config = Object.assign(domains.config || Object.create(null), {
    APP_NAME:'Direct-Xfer', PUBLIC_URL:'', INBOX_DIR:path.join(ROOT, 'tmp-inbox'),
  });
  domains['runtime-constants'] = Object.assign(domains['runtime-constants'] || Object.create(null), {
    DAY_MS:86400000, ACTIVITY_HISTORY_MAX:100, TRANSFER_STALL_MS:45000, UNDO_LOG_MAX:25,
  });
  domains.transfer = Object.assign(domains.transfer || Object.create(null), {
    activeTransfers:new Map(), listTransfers:marker,
  });
  domains.account = Object.assign(domains.account || Object.create(null), {
    normalizeUsername:(value) => String(value || '').toLowerCase(),
    accountNeedsPasswordChange:marker, getAccountById:marker, findAccountByName:marker, accountList:marker,
  });
  domains['state-store'] = Object.assign(domains['state-store'] || Object.create(null), {
    scheduleFlush:marker, persistNow:marker, persist:marker,
  });
  domains['core-utils'] = Object.assign(domains['core-utils'] || Object.create(null), {
    timingSafeEqualStr:(a, b) => a === b,
  });
  domains['early-adapters'] = Object.assign(domains['early-adapters'] || Object.create(null), {
    parseCookies:() => ({}), secureCookie:() => '', clientIp:() => '', resolveWithin:(root, rel) => path.join(root, rel),
  });
  domains.session = Object.assign(domains.session || Object.create(null), {
    getSession:marker, destroySession:marker, createSession:marker, invalidateSessionSid:marker,
  });
  domains['share-presentation'] = Object.assign(domains['share-presentation'] || Object.create(null), {
    externalProto:() => 'http', primaryBase:() => '', decorateShare:marker,
  });
  domains.audit = Object.assign(domains.audit || Object.create(null), { auditReq:marker, logAudit:marker });
  domains.activity = Object.assign(domains.activity || Object.create(null), {
    pubIp:(value) => value, presenceSessionValidator:() => () => true,
  });
  domains['public-access'] = Object.assign(domains['public-access'] || Object.create(null), { makeSharePassword:() => ({}) });
  domains['public-share'] = Object.assign(domains['public-share'] || Object.create(null), { parseHotlinkHosts:() => [] });
  domains['share-route-adapters'] = Object.assign(domains['share-route-adapters'] || Object.create(null), { normalizeTags:() => [] });
  domains['search-compat'] = Object.assign(domains['search-compat'] || Object.create(null), { scheduleSearchReindex:marker });
  domains.dlp = Object.assign(domains.dlp || Object.create(null), { dlpEffectiveAction:() => 'log' });

  const share = routeService('share');
  Object.assign(share, { parseExpiry:marker, destroyShareManagedData:marker, detachActiveShare:marker, shareLogicalBytesCache:new Map() });
  domains.share = share;

  const photo = routeService('media');
  Object.assign(photo, {
    adminPhotoFullWrites:new Set(), pwaImagesForRequest:marker, photoLastPublicViewAt:marker,
    photoStatsOf:marker, pwaPhotoPayload:marker, photoManagedBytes:marker,
  });
  domains.photo = photo;

  domains.settings = routeService('settings');
  const notificationCenter = routeService('notificationCenter');
  notificationCenter.CUSTOM_NOTIFICATION_RULE_METRICS = ['views'];
  notificationCenter.NOTIFICATION_MUTABLE_CATEGORIES = ['images'];
  domains['notification-center'] = notificationCenter;

  const pwaNotification = routeService('notification');
  pwaNotification.sendPwaPush = marker;
  domains['pwa-notification'] = pwaNotification;
  domains.notification = Object.assign(domains.notification || Object.create(null), {
    getVapidKeys:marker, pushSubs:marker, sendWebPushAwaited:marker,
  });

  for (const name of ['upload', 'download', 'share-core-output', 'photo-utils', 'public-pages', 'storage-connectors']) {
    if (!domains[name]) domains[name] = Object.create(null);
  }
  // Fill context-only route dependencies after concrete domain overrides.
  for (const spec of Object.values(PWA_ROUTE_FACADE_CONTEXT)) {
    for (const [, [domain, property]] of Object.entries(spec)) {
      if (!Object.prototype.hasOwnProperty.call(domains[domain], property)) domains[domain][property] = marker;
    }
  }

  const context = {
    current(name) { return domains[name] || null; },
    register(name, value) {
      if (domains[name]) throw new Error(`duplicate context domain: ${name}`);
      domains[name] = value;
      return value;
    },
  };
  const registry = createPwaServiceRegistry();
  // Match the real server's early deferred bridge requests.
  for (const operation of ['pwaDevices', 'pwaDeviceCreatorAccount', 'pwaDeviceOwnerAccount', 'pwaDeviceResolvedAccount', 'stampPwaRecordOwner']) {
    void registry.device[operation];
  }
  void registry.event.emitPwaOwnerEvent;

  const state = { meta:{ pwaDevices:[] }, shares:[], trash:[], settings:{}, photoHistory:[] };
  const live = {
    getState:() => state,
    setState:() => {},
    getSearchIndexBuilding:() => false,
    getUniversalSearchIndex:() => null,
    getWebpush:() => null,
  };
  return { app, context, domains, registry, state, live };
}

function assertPwaUnpublished(fixture) {
  for (const name of PWA_REGISTRY_SERVICE_TARGETS) assert.equal(fixture.registry.current(name), null, `${name} registry slot must remain empty`);
  for (const name of PWA_CONTEXT_DOMAIN_TARGETS) assert.equal(fixture.context.current(name), null, `${name} context domain must remain unpublished`);
}

test('PWA application commits routes, deferred services and context domains only after full composition succeeds', () => {
  const fixture = createFixture();
  const pwa = createPwaApplication({ context:fixture.context, registry:fixture.registry, rootDir:ROOT, live:fixture.live });
  assert.equal(fixture.app.routes.length, 106);
  for (const name of PWA_REGISTRY_SERVICE_TARGETS) assert.ok(fixture.registry.current(name), `${name} should be bound`);
  for (const name of PWA_CONTEXT_DOMAIN_TARGETS) assert.ok(fixture.context.current(name), `${name} should be registered`);
  assert.doesNotThrow(() => pwa.stop());
  assert.doesNotThrow(() => pwa.stop(), 'PWA application cleanup must be idempotent');
});

test('a late PWA service dependency failure does not poison deferred services, context or routes', () => {
  const fixture = createFixture();
  delete fixture.domains.photo.pwaImagesForRequest;
  assert.throws(
    () => createPwaApplication({ context:fixture.context, registry:fixture.registry, rootDir:ROOT, live:fixture.live }),
    /photo is missing stable pwaImagesForRequest/
  );
  assert.equal(fixture.app.routes.length, 0);
  assertPwaUnpublished(fixture);
});

test('occupied PWA publication targets fail during preflight before route registration', () => {
  const contextCollision = createFixture();
  contextCollision.domains['pwa-device'] = { stale:true };
  assert.throws(
    () => createPwaApplication({ context:contextCollision.context, registry:contextCollision.registry, rootDir:ROOT, live:contextCollision.live }),
    /context domain already registered: pwa-device/
  );
  assert.equal(contextCollision.app.routes.length, 0);
  for (const name of PWA_REGISTRY_SERVICE_TARGETS) assert.equal(contextCollision.registry.current(name), null);

  const registryCollision = createFixture();
  registryCollision.registry.bind('photo', {});
  assert.throws(
    () => createPwaApplication({ context:registryCollision.context, registry:registryCollision.registry, rootDir:ROOT, live:registryCollision.live }),
    /registry service already bound: photo/
  );
  assert.equal(registryCollision.app.routes.length, 0);
  for (const name of PWA_CONTEXT_DOMAIN_TARGETS) assert.equal(registryCollision.context.current(name), null);
});

test('registry validate checks deferred contracts without installing a service', () => {
  const registry = createPwaServiceRegistry();
  const deferred = registry.device.pwaDevices;
  assert.equal(typeof deferred, 'function');
  const service = { pwaDevices() { return []; } };
  assert.equal(registry.validate('device', service), service);
  assert.equal(registry.current('device'), null);
  assert.throws(() => deferred(), /pwa-service-not-ready:device\.pwaDevices/);
  registry.bind('device', service);
  assert.deepEqual(deferred(), []);
});

test('PWA facade locals cannot shadow context dependencies or smuggle accessors', () => {
  const fixture = createFixture();
  assert.throws(
    () => createPwaRouteFacades(fixture.context, { crypto }),
    /duplicate runtime facade dependency: crypto/
  );
  const accessor = {};
  Object.defineProperty(accessor, 'late', { enumerable:true, get:() => 1 });
  assert.throws(() => mergeStableFacade({}, accessor, 'audit'), /must be stable/);
});

test('bound intra-PWA methods preserve receiver semantics', () => {
  const service = { value:41, next() { return this.value + 1; } };
  const bound = bindStableServiceMethod(service, 'next', 'receiver-test');
  assert.equal(bound(), 42);
  assert.throws(() => bindStableServiceMethod(Object.create({ next() {} }), 'next', 'receiver-test'), /missing stable method next/);
});

test('PWA retention scheduler rolls back a partially-created timer when startup timer creation fails', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { createPwaPhotoService } = require(${JSON.stringify(path.join(ROOT, 'lib/server/pwa-photo-service.js'))});
    let intervals = 0, clearedIntervals = 0;
    global.setInterval = () => ({ unref() {}, id:++intervals });
    global.clearInterval = () => { clearedIntervals += 1; };
    global.setTimeout = () => { throw new Error('timer-pressure'); };
    global.clearTimeout = () => {};
    const service = createPwaPhotoService({ getState:() => ({}) });
    assert.throws(() => service.startRetentionScheduler(), /timer-pressure/);
    assert.equal(intervals, 1);
    assert.equal(clearedIntervals, 1);
    service.stopRetentionScheduler();
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
