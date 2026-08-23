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
  assert.match(server, /createPwaApplication\(\{/);
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

