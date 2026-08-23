'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  ROUTE_SERVICE_EXPORTS,
  composePwaRouteDependencies,
  createPwaServiceRegistry,
} = require('../lib/server/pwa-composition-service');

function routeService(name) {
  const service = {};
  for (const operation of ROUTE_SERVICE_EXPORTS[name]) service[operation] = () => operation;
  return service;
}

function routeServices() {
  const services = {};
  for (const name of Object.keys(ROUTE_SERVICE_EXPORTS)) services[name] = routeService(name);
  services.device.pwaPairTickets = new Map();
  services.device.PWA_INSTALL_HEARTBEAT_MAX_AGE_MS = 456;
  services.event.inboxEventSubs = new Map();
  services.photo.PWA_IMG_EXT = /^(jpg|png)$/;
  services.webauthn.PASSKEY_MANAGEMENT_FRESH_MS = 1;
  services.webauthn.WEBAUTHN_CHALLENGE_TTL = 2;
  services.webauthn.webauthnLoginChallenges = new Map();
  services.webauthn.webauthnRegChallenges = new Map();
  services.share.shareLogicalBytesCache = new Map();
  services.media.adminPhotoFullWrites = new Set();
  services.notificationCenter.CUSTOM_NOTIFICATION_RULE_METRICS = ['views'];
  services.notificationCenter.NOTIFICATION_MUTABLE_CATEGORIES = ['images'];
  return services;
}

test('deferred PWA facades resolve startup callbacks against the service bound later', () => {
  const registry = createPwaServiceRegistry();
  const deferred = registry.device.pwaDevices;
  assert.throws(() => deferred(), /pwa-service-not-ready:device\.pwaDevices/);

  const devices = [{ id:'device-1' }];
  const service = { pwaDevices:() => devices, PWA_INSTALL_HEARTBEAT_MAX_AGE_MS:123 };
  assert.equal(registry.bind('device', service), service);
  assert.equal(deferred(), devices);
  assert.equal(registry.device.PWA_INSTALL_HEARTBEAT_MAX_AGE_MS, 123);
  assert.throws(() => registry.bind('device', {}), /already bound/);
  assert.throws(() => registry.bind('unknown', {}), /unknown PWA service/);
  assert.throws(() => registry.current('unknown'), /unknown PWA service/);
  assert.equal(Promise.resolve(registry.photo) instanceof Promise, true, 'deferred facades must not become thenables');
});

test('deferred PWA contracts reject misspelled or inherited startup callbacks before binding', () => {
  const registry = createPwaServiceRegistry();
  const deferred = registry.event.misspelledCallback;
  assert.equal(typeof deferred, 'function');
  assert.throws(
    () => registry.bind('event', Object.create({ misspelledCallback() {} })),
    /pwa-service-contract-mismatch:event\.misspelledCallback/
  );
  assert.equal(registry.current('event'), null, 'a rejected service must not be installed partially');
  const service = { misspelledCallback:() => 'bound' };
  registry.bind('event', service);
  assert.equal(deferred(), 'bound');
});

test('route composition projects only declared service APIs and rejects ambiguous facades', () => {
  const services = routeServices();

  const dependencies = composePwaRouteDependencies(services, { runtime:{ customRuntimeValue:42 } });
  assert.equal(dependencies.issuePwaDevice(), 'issuePwaDevice');
  assert.equal(dependencies.customRuntimeValue, 42);
  assert.equal('clearRuntimeState' in dependencies, false);
  assert.throws(
    () => composePwaRouteDependencies(services, { bad:{ issuePwaDevice:() => null } }),
    /duplicate PWA route dependency: issuePwaDevice/
  );
  delete services.event.pwaOwnerKeys;
  assert.throws(() => composePwaRouteDependencies(services, {}), /event service is missing pwaOwnerKeys/);
});

test('route composition rejects inherited, malformed and accessor dependencies at startup', () => {
  assert.throws(() => composePwaRouteDependencies(null, {}), /requires a services object/);
  assert.throws(() => composePwaRouteDependencies({}, null), /requires a facades object/);
  const inheritedServices = routeServices();
  delete inheritedServices.event.pwaOwnerKeys;
  Object.setPrototypeOf(inheritedServices.event, { pwaOwnerKeys() {} });
  assert.throws(() => composePwaRouteDependencies(inheritedServices, {}), /event service is missing pwaOwnerKeys/);

  const malformedServices = routeServices();
  malformedServices.photo.PWA_IMG_EXT = '.jpg';
  assert.throws(() => composePwaRouteDependencies(malformedServices, {}), /photo\.PWA_IMG_EXT must be a RegExp/);

  const accessorFacade = {};
  Object.defineProperty(accessorFacade, 'changing', { enumerable:true, get:() => 1 });
  assert.throws(
    () => composePwaRouteDependencies(routeServices(), { runtime:accessorFacade }),
    /must be a data property; use live bindings for accessors/
  );
});

test('PWA application owns grouped route facades and server only supplies live composition callbacks', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const application = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'pwa-application.js'), 'utf8');
  const finalHttp = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'final-http-application.js'), 'utf8');
  const composition = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'http-pwa-lifecycle-application.js'), 'utf8');
  assert.match(server, /createFinalHttpApplication\(\{/);
  assert.match(finalHttp, /createHttpPwaLifecycleApplication\(\{/);
  assert.match(composition, /createPwaApplication\(\{/);
  assert.doesNotMatch(server, /const pwaRouteFacades = Object\.freeze\(\{/);
  assert.match(application, /const PWA_ROUTE_FACADE_CONTEXT = Object\.freeze\(\{/);
  for (const group of ['runtime','identity','state','shares','activity','policyAndSearch']) {
    assert.match(application, new RegExp(`${group}: Object\\.freeze\\(\\{`));
  }
  assert.match(application, /registry\.validate\('device', pwaDeviceService\)/);
  assert.ok(application.indexOf("registry.validate('device', pwaDeviceService)") < application.indexOf('attachPwaRoutes({'),
    'PWA deferred contracts should validate before route registration');
  assert.ok(application.indexOf('attachPwaRoutes({') < application.indexOf("registry.bind('device', pwaDeviceService)"),
    'PWA deferred services should bind only after route composition succeeds');
  assert.doesNotMatch(server, /function \w+\(\.\.\.args\) \{ return (?:pwaDeviceService|pwaPhotoService|pwaEventService|webauthnService)\./);
  assert.ok(server.split('\n').length < 2400, 'PWA bootstrap extraction should keep server.js compact');
});



test('share/media PWA hook facade is lazy, stable and validated by deferred service binding', () => {
  const registry = createPwaServiceRegistry();
  // Generic registry users pay no share/media contract cost until this projection is requested.
  assert.equal(registry.current('device'), null);
  const hooks = registry.shareMediaHooks;
  assert.strictEqual(registry.shareMediaHooks, hooks);
  assert.equal(Object.isFrozen(hooks), true);
  assert.deepEqual(Object.keys(hooks).sort(), [
    'activityPrincipal', 'canManagePwaImage', 'cleanDeviceLabel', 'getPwaPublicDevice',
    'pwaDeviceCreatorAccount', 'pwaDeviceOwnerAccount', 'pwaDeviceResolvedAccount',
    'requestClientDeviceName', 'shareOwnerAccount',
  ].sort());

  assert.throws(
    () => registry.bind('device', { pwaDeviceResolvedAccount() {} }),
    /pwa-service-contract-mismatch:device\./,
  );
  const device = {
    marker:'device',
    pwaDeviceResolvedAccount() { return this.marker; },
    getPwaPublicDevice() { return this.marker; },
    pwaDeviceCreatorAccount() { return this.marker; },
    pwaDeviceOwnerAccount() { return this.marker; },
    requestClientDeviceName() { return this.marker; },
    cleanDeviceLabel(value) { return `${this.marker}:${value}`; },
  };
  const event = {
    marker:'event',
    activityPrincipal() { return this.marker; },
    shareOwnerAccount() { return this.marker; },
  };
  const photo = {
    marker:'photo',
    canManagePwaImage() { return this.marker; },
  };
  registry.bind('device', device);
  registry.bind('event', event);
  registry.bind('photo', photo);
  assert.equal(hooks.cleanDeviceLabel('x'), 'device:x');
  assert.equal(hooks.activityPrincipal(), 'event');
  assert.equal(hooks.canManagePwaImage(), 'photo');
});

test('share/media PWA hooks keep live receiver semantics even when the facade is first requested after bind', () => {
  const registry = createPwaServiceRegistry();
  const device = {
    marker:'first',
    pwaDeviceResolvedAccount() { return this.marker; },
    getPwaPublicDevice() { return this.marker; },
    pwaDeviceCreatorAccount() { return this.marker; },
    pwaDeviceOwnerAccount() { return this.marker; },
    requestClientDeviceName() { return this.marker; },
    cleanDeviceLabel(value) { return `${this.marker}:${value}`; },
  };
  const event = {
    marker:'event',
    activityPrincipal() { return this.marker; },
    shareOwnerAccount() { return this.marker; },
  };
  const photo = { marker:'photo', canManagePwaImage() { return this.marker; } };
  registry.bind('device', device);
  registry.bind('event', event);
  registry.bind('photo', photo);

  const hooks = registry.shareMediaHooks;
  const hook = hooks.cleanDeviceLabel;
  assert.equal(hook('x'), 'first:x');
  device.marker = 'second';
  device.cleanDeviceLabel = function replacement(value) { return `${this.marker.toUpperCase()}:${value}`; };
  assert.equal(hook('y'), 'SECOND:y', 'late facade construction must not capture the first bound method');
});

test('share/media PWA hooks fail closed when a bound service loses its own callable contract', () => {
  const registry = createPwaServiceRegistry();
  const hooks = registry.shareMediaHooks;
  const device = {
    pwaDeviceResolvedAccount() {}, getPwaPublicDevice() {}, pwaDeviceCreatorAccount() {},
    pwaDeviceOwnerAccount() {}, requestClientDeviceName() {}, cleanDeviceLabel(value) { return value; },
  };
  const event = { activityPrincipal() {}, shareOwnerAccount() {} };
  const photo = { canManagePwaImage() {} };
  registry.bind('device', device);
  registry.bind('event', event);
  registry.bind('photo', photo);

  delete device.cleanDeviceLabel;
  Object.setPrototypeOf(device, { cleanDeviceLabel() { return 'prototype-bypass'; } });
  assert.throws(() => hooks.cleanDeviceLabel('x'), /pwa-service-contract-mismatch:device\.cleanDeviceLabel/);
  Object.defineProperty(device, 'cleanDeviceLabel', { configurable:true, get() { return () => 'accessor-bypass'; } });
  assert.throws(() => hooks.cleanDeviceLabel('x'), /pwa-service-contract-mismatch:device\.cleanDeviceLabel/);
});

test('failed share/media PWA facade preflight does not leak deferred requirements into later binds', () => {
  const registry = createPwaServiceRegistry();
  registry.bind('photo', {}); // Valid before the share/media projection asks for canManagePwaImage.
  assert.throws(() => registry.shareMediaHooks, /PWA share\/media hooks require photo\.canManagePwaImage/);

  // A failed projection was never published, so unrelated deferred services must
  // still be bindable with their pre-existing (empty) contracts.
  assert.doesNotThrow(() => registry.bind('device', {}));
  assert.doesNotThrow(() => registry.bind('event', {}));
});

test('generic deferred PWA callbacks cannot fall through to prototype methods after bind', () => {
  const registry = createPwaServiceRegistry();
  const deferred = registry.device.someOperation;
  const service = { marker:'own', someOperation() { return this.marker; } };
  registry.bind('device', service);
  assert.equal(deferred(), 'own');
  delete service.someOperation;
  Object.setPrototypeOf(service, { someOperation() { return 'prototype-bypass'; } });
  assert.throws(() => deferred(), /pwa-service-contract-mismatch:device\.someOperation/);
});
