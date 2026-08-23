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

function completeProfile(profile) {
  return Object.fromEntries(ROUTE_DEPENDENCIES[profile].map((name) => [name, name === 'live' ? {} : true]));
}

test('route profiles are least-privilege facades and do not expose unrelated domain members', () => {
  const required = ROUTE_DEPENDENCIES.adminAccount;
  const source = { ...completeProfile('adminAccount'), secretInternalHelper: () => 'secret' };
  const ctx = createApplicationContext();
  ctx.register('domain', source);
  const route = ctx.route('adminAccount', ['domain']);

  assert.deepEqual(Object.keys(route).sort(), [...required].sort());
  assert.equal(route.secretInternalHelper, undefined);
  assert.equal('secretInternalHelper' in route, false);
  assert.equal(Object.isFrozen(route), true);
  assert.throws(() => { route.persistNow = null; }, TypeError);
});

test('composition rejects duplicate providers even when their current values are identical', () => {
  const sharedFn = () => true;
  const ctx = createApplicationContext();
  ctx.register('one', { samePrimitive:'x', sameFunction:sharedFn });
  ctx.register('two', { samePrimitive:'x', sameFunction:sharedFn });

  const facade = ctx.facade(['one', 'two']);
  assert.throws(() => facade.samePrimitive, /ambiguous application dependency samePrimitive: one, two/);
  assert.throws(() => facade.sameFunction, /ambiguous application dependency sameFunction: one, two/);

  const explicit = ctx.facade(['one', 'two'], { samePrimitive:'canonical', sameFunction:sharedFn });
  assert.equal(explicit.samePrimitive, 'canonical');
  assert.equal(explicit.sameFunction, sharedFn);
});

test('generic facades keep accessor-backed values live instead of caching the first read', () => {
  let value = 1;
  const source = {};
  Object.defineProperty(source, 'current', { enumerable:true, get:() => value });
  const ctx = createApplicationContext();
  ctx.register('live', source);
  const facade = ctx.facade(['live']);

  assert.equal(facade.current, 1);
  value = 2;
  assert.equal(facade.current, 2);
  assert.deepEqual(Object.keys(facade), ['current']);
  assert.equal(facade.current, 2);
});

test('bind rejects accessors so a dynamic dependency cannot be silently snapshotted', () => {
  let value = 1;
  const source = {};
  Object.defineProperty(source, 'dynamic', { enumerable:true, get:() => value });
  assert.throws(() => createBoundFacade(source, ['dynamic']), /dependency is dynamic: dynamic/);
  value = 2;
  assert.equal(source.dynamic, 2);
});

test('duplicate domain registration and duplicate facade selections fail fast', () => {
  const ctx = createApplicationContext();
  const source = { value:1 };
  ctx.register('one', source);
  assert.throws(() => ctx.register('one', source), /domain already registered: one/);
  assert.throws(() => ctx.facade(['one', 'one']), /facade contains duplicate domains/);
});


test('route profiles reject top-level accessors so live state cannot be frozen at attach time', () => {
  const source = completeProfile('adminAccount');
  let writes = 1;
  Object.defineProperty(source, 'persistNow', { enumerable:true, configurable:true, get:() => () => writes++ });
  const ctx = createApplicationContext();
  ctx.register('dynamic', source);
  assert.throws(
    () => ctx.route('adminAccount', ['dynamic']),
    /adminAccount dependency persistNow is dynamic/,
  );
});

test('bind rejects scalar binding-name inputs instead of interpreting strings character-by-character', () => {
  assert.throws(
    () => createBoundFacade({ method() {} }, 'method'),
    /binding names must be an array or alias object/,
  );
});

test('server explicitly disambiguates known cross-domain aliases from point 7', () => {
  const server = read('server.js');
  const admin = read('lib/server/admin-application.js');
  const publication = read('lib/server/application-publication.js');
  assert.match(server, /publishApplicationGraph\(\{[\s\S]*?reception:\{ PENDING_DIR:configPaths\.PENDING_DIR, live:liveState \}/);
  assert.match(publication, /route\(\s*'receptionCollaboration',[\s\S]*?receptionOverrides/);
  assert.match(admin, /attachAdminShareRoutes\(context\.route\('adminShare', ROUTE_DOMAINS\.share,[\s\S]*?PENDING_DIR:config\.PENDING_DIR,[\s\S]*?live:adminShareRouteLiveBindings/);
  assert.match(admin, /attachAdminStorageRoutes\(context\.route\('adminStorage', ROUTE_DOMAINS\.storage,[\s\S]*?storageConnectorService,[\s\S]*?connectorHttpStatus:early\.connectorHttpStatus/);

  const lateAdapters = admin.match(/context\.register\('late-adapters',\s*\{([\s\S]*?)\}\);/);
  assert.ok(lateAdapters, 'late-adapters registration should exist');
  assert.doesNotMatch(lateAdapters[1], /\brootDir\b/);
  assert.doesNotMatch(lateAdapters[1], /\bnormalizeLinkBase\b/);
});
