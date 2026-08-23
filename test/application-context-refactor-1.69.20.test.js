'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ROUTE_DEPENDENCIES,
  createApplicationContext,
  createBoundFacade,
} = require('../lib/server/application-context');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');

test('point 7 centralizes route composition and removes forwarding/dependency-list noise from server.js', () => {
  const server = read('server.js');
  const context = read('lib/server/application-context.js');
  assert.match(server, /createApplicationContext/);
  assert.match(server, /applicationContext\.route\('receptionCollaboration'/);
  assert.match(server, /applicationContext\.route\('adminShareCore'/);
  assert.match(server, /applicationContext\.route\('adminDiagnostics'/);
  assert.match(server, /applicationContext\.bind\(shareService/);
  assert.match(server, /applicationContext\.bind\(stateStore/);
  assert.match(context, /const ROUTE_DEPENDENCIES = Object\.freeze/);
  assert.match(context, /ambiguous application dependency/);
  assert.ok(server.split('\n').length < 2800, 'composition-root noise should remain below 2800 lines after point 7');

  const bootstrapBridges = new Set([
    'persist', 'persistNow', 'scheduleFlush', 'getById', 'getByToken', 'isActive', 'listShares',
    'normalizeShareColor', 'normalizeDescriptionMd', 'shareFirstUseDeadline', 'shareInactiveDeadline',
    'shareEffectiveExpiry', 'parseMaxVisitors', 'centerPublicVisitorDeviceLabel',
    'scheduleSearchReindex', 'receptionThreadEnabled',
  ]);
  const wrappers = [...server.matchAll(/^function\s+([A-Za-z_$][\w$]*)\(\.\.\.args\)/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(wrappers)].sort(), [...bootstrapBridges].sort(), 'only documented hoisted bootstrap bridges should remain');
  assert.doesNotMatch(server, /function\s+buildUniversalSearchIndex\s*\(\.\.\.args\)/);
  assert.doesNotMatch(server, /function\s+runExpiredLinkLifecycle\s*\(\.\.\.args\)/);
});

test('bound façades preserve method ownership, aliases and immutability', () => {
  const source = {
    prefix:'dx',
    join(value) { return `${this.prefix}:${value}`; },
    plain:7,
  };
  const facade = createBoundFacade(source, { renamed:'join', value:'plain' });
  const detached = facade.renamed;
  assert.equal(detached('ok'), 'dx:ok');
  assert.equal(facade.value, 7);
  assert.equal(Object.isFrozen(facade), true);
  assert.throws(() => { facade.value = 8; }, TypeError);
  assert.throws(() => createBoundFacade(source, { nope:'missing' }), /dependency is missing/);
  assert.throws(() => createBoundFacade(source, { constructor:'plain' }), /unsafe application dependency/);
});

test('route façades preserve callable-module identity and static helpers', () => {
  function expressLike() { return 'app'; }
  expressLike.json = () => 'json-parser';
  const ctx = createApplicationContext();
  ctx.register('platform', { express:expressLike });
  const facade = ctx.facade(['platform']);
  assert.equal(facade.express, expressLike);
  assert.equal(facade.express.json(), 'json-parser');
});

test('application context rejects ambiguity but explicit route overrides disambiguate first', () => {
  const ctx = createApplicationContext();
  ctx.register('one', { shared:'one', onlyOne:1 });
  ctx.register('two', { shared:'two', onlyTwo:2 });
  const ambiguous = ctx.facade(['one', 'two']);
  assert.throws(() => ambiguous.shared, /ambiguous application dependency shared/);

  const override = { shared:'override' };
  const resolved = ctx.facade(['one', 'two'], override);
  assert.equal(resolved.shared, 'override');
  assert.equal(resolved.onlyOne, 1);
  assert.equal(resolved.onlyTwo, 2);
  assert.deepEqual(Object.keys(resolved).sort(), ['onlyOne', 'onlyTwo', 'shared']);
});

test('route profiles fail fast for missing/undefined dependencies and accept complete domains', () => {
  const required = ROUTE_DEPENDENCIES.adminAccount;
  const complete = Object.fromEntries(required.map((name) => [name, name === 'live' ? {} : true]));
  const ctx = createApplicationContext();
  ctx.register('complete', complete);
  const route = ctx.route('adminAccount', ['complete']);
  assert.equal(route.adminRouter, true);

  const missing = createApplicationContext();
  const incomplete = { ...complete };
  delete incomplete.persistNow;
  missing.register('incomplete', incomplete);
  assert.throws(() => missing.route('adminAccount', ['incomplete']), /adminAccount is missing persistNow/);

  const undefinedValue = createApplicationContext();
  undefinedValue.register('undefined-value', { ...complete, persistNow:undefined });
  assert.throws(() => undefinedValue.route('adminAccount', ['undefined-value']), /adminAccount is missing persistNow/);
  assert.throws(() => ctx.route('not-a-profile', ['complete']), /unknown application route profile/);
});

function dependencyBlock(file, functionName) {
  const source = read(`lib/server/${file}`);
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `missing ${functionName}`);
  const match = source.slice(start).match(/const\s*\{([\s\S]*?)\}\s*=\s*deps\s*;/);
  assert.ok(match, `missing deps destructuring in ${functionName}`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return body.split(',').map((item) => {
    const found = item.trim().match(/^([A-Za-z_$][\w$]*)/);
    return found ? found[1] : '';
  }).filter(Boolean);
}

test('route profiles stay synchronized with route-module dependency contracts', () => {
  const profiles = [
    ['receptionCollaboration', 'reception-collaboration-routes.js', 'attachReceptionCollaborationRoutes'],
    ['adminAccount', 'admin-account-routes.js', 'attachAdminAccountRoutes'],
    ['adminSecurity', 'admin-security-routes.js', 'attachAdminSecurityRoutes'],
    ['adminStorage', 'admin-storage-routes.js', 'attachAdminStorageRoutes'],
    ['adminShareCore', 'admin-share-routes.js', 'attachAdminShareCoreRoutes'],
    ['adminShare', 'admin-share-routes.js', 'attachAdminShareRoutes'],
    ['adminSettings', 'admin-settings-routes.js', 'attachAdminSettingsRoutes'],
    ['adminPhoto', 'admin-photo-routes.js', 'attachAdminPhotoRoutes'],
    ['adminDashboard', 'admin-dashboard-routes.js', 'attachAdminDashboardRoutes'],
    ['adminDiagnostics', 'admin-diagnostics-routes.js', 'attachAdminDiagnosticsRoutes'],
  ];
  for (const [profile, file, functionName] of profiles) {
    const actual = dependencyBlock(file, functionName);
    assert.deepEqual([...ROUTE_DEPENDENCIES[profile]].sort(), [...actual].sort(), `${profile} profile drifted from ${functionName}`);
    assert.equal(new Set(actual).size, actual.length, `${functionName} has duplicate dependencies`);
  }
});

test('reception context includes the network domain required for geolocation', () => {
  const server = read('server.js');
  const call = server.match(/attachReceptionCollaborationRoutes\(applicationContext\.route\('receptionCollaboration',[\s\S]*?\]\s*,\s*\{[\s\S]*?live:/);
  assert.ok(call, 'reception context call should be present');
  assert.match(call[0], /'network'/);
});


test('runtime constants are explicitly composed for photo and dashboard routes', () => {
  const server = read('server.js');
  assert.match(server, /applicationContext\.register\('runtime-constants', Object\.freeze\(\{ DAY_MS, ACTIVITY_HISTORY_MAX, UNDO_LOG_MAX \}\)\)/);
  const photoCall = server.match(/attachAdminPhotoRoutes\(applicationContext\.route\('adminPhoto',[\s\S]*?\]\s*,\s*\{\s*getState:/);
  assert.ok(photoCall, 'adminPhoto composition should be present');
  assert.match(photoCall[0], /'runtime-constants'/);
  const dashboardCall = server.match(/attachAdminDashboardRoutes\(applicationContext\.route\('adminDashboard',[\s\S]*?\]\s*,\s*\{\s*getState:/);
  assert.ok(dashboardCall, 'adminDashboard composition should be present');
  assert.match(dashboardCall[0], /'runtime-constants'/);
});
