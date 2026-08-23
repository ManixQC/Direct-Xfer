'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createContextTransaction,
  createRegistryTransaction,
  validatePwaApplicationResult,
} = require('../lib/server/http-pwa-lifecycle-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function fakeContext(initial = {}) {
  const domains = new Map(Object.entries(initial));
  return {
    current(name) { return domains.get(String(name)) || null; },
    register(name, source) {
      name = String(name);
      if (domains.has(name)) throw new Error(`application context domain already registered: ${name}`);
      domains.set(name, source);
      return source;
    },
    domains,
  };
}

function fakeRegistry() {
  const slots = new Map();
  return {
    current(name) { return slots.get(String(name)) || null; },
    validate(name, service) {
      if (!service || typeof service !== 'object') throw new TypeError(`invalid service: ${name}`);
      const existing = slots.get(String(name));
      if (existing && existing !== service) throw new Error(`PWA service already bound: ${name}`);
      return service;
    },
    bind(name, service) {
      this.validate(name, service);
      slots.set(String(name), service);
      return service;
    },
    slots,
  };
}

test('server delegates final HTTP, PWA and process lifecycle wiring to one composition boundary', () => {
  const server = read('server.js');
  const finalHttp = read('lib/server/final-http-application.js');
  const composition = read('lib/server/http-pwa-lifecycle-application.js');
  assert.match(server, /require\('\.\/lib\/server\/final-http-application'\)/);
  assert.match(server, /createFinalHttpApplication\(\{/);
  assert.match(finalHttp, /require\('\.\/http-pwa-lifecycle-application'\)/);
  assert.match(finalHttp, /createHttpPwaLifecycleApplication\(\{/);
  for (const direct of [
    'createHttpApplication', 'createPwaApplication', 'createLifecycleService', 'attachWindowsLauncherRoutes',
  ]) {
    assert.doesNotMatch(server, new RegExp(`\\b${direct}\\(`), `${direct} must not be composed directly by server.js`);
    assert.match(composition, new RegExp(`\\b${direct}\\(`), `${direct} must be owned by the final composition boundary`);
  }
  for (const rel of ['http-application', 'pwa-application', 'lifecycle-service', 'windows-launcher-routes']) {
    assert.match(composition, new RegExp(`require\\('\\./${rel}'\\)`));
  }
  assert.ok(server.split('\n').length < 1000, `server.js remains too large (${server.split('\n').length} lines)`);
});

test('final route and lifecycle order remains explicit and security-sensitive', () => {
  const finalHttp = read('lib/server/final-http-application.js');
  const composition = read('lib/server/http-pwa-lifecycle-application.js');
  const tokens = [
    'createHttpApplication({',
    "app.get('/direct-xfer-local-ca.cer'",
    'attachWindowsLauncherRoutes({',
    "app.use('/', downloadRouter)",
    'attachPublicAssetRoutes()',
    'createPwaApplication({',
    'validatePwaApplicationResult(pwaApplication)',
    'createLifecycleService({',
    'registryTx.commit()',
    'contextTx.commit()',
    "app.post('/api/login'",
    "app.get('/healthz'",
    "app.get('/api/meta'",
    'adminApplication.attachLateRoutes({ shutdown, getServer })',
    "app.use('/api', adminGuard, jsonParser, adminApplication.adminRouter)",
    'attachAdminSpaAndFallbacks()',
  ];
  const positions = tokens.map((token) => composition.indexOf(token));
  assert.ok(positions.every((value) => value >= 0), `missing composition token: ${tokens[positions.findIndex((v) => v < 0)]}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('context transaction keeps HTTP/PWA domains private until commit and fails closed on collisions', () => {
  const base = fakeContext({ config:{ ok:true } });
  const http = { app:{} };
  const tx = createContextTransaction(base, { 'http-application':http });
  assert.equal(base.current('http-application'), null);
  assert.equal(tx.context.current('http-application'), http);
  tx.context.register('pwa-device', { id:'device' });
  assert.equal(base.current('pwa-device'), null);
  tx.preflight();
  tx.commit();
  assert.equal(base.current('http-application'), http);
  assert.equal(base.current('pwa-device').id, 'device');

  const conflicting = fakeContext();
  const blocked = createContextTransaction(conflicting, { 'http-application':{ app:{} } });
  conflicting.register('http-application', { app:{ other:true } });
  assert.throws(() => blocked.commit(), /already registered/);
  assert.equal(conflicting.domains.size, 1);
});

test('PWA registry transaction validates deferred services without publishing them early', () => {
  const base = fakeRegistry();
  const tx = createRegistryTransaction(base);
  const device = { id:'device' };
  tx.registry.bind('device', device);
  assert.equal(base.current('device'), null);
  assert.equal(tx.registry.current('device'), device);
  tx.preflight();
  tx.commit();
  assert.equal(base.current('device'), device);

  const conflicting = fakeRegistry();
  const blocked = createRegistryTransaction(conflicting);
  blocked.registry.bind('photo', { id:'staged' });
  conflicting.bind('photo', { id:'other' });
  assert.throws(() => blocked.commit(), /already bound/);
  assert.equal(conflicting.current('photo').id, 'other');
});

test('Windows ServerHost integrity manifest protects the final HTTP/PWA/lifecycle composition boundary', () => {
  const rel = 'lib/server/http-pwa-lifecycle-application.js';
  const hash = crypto.createHash('sha256').update(read(rel)).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "${rel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}", "${hash}" \\}`));
});


test('composition transactions seal after publication and fail closed after an interrupted commit', () => {
  const contextBase = fakeContext();
  const contextTx = createContextTransaction(contextBase, { alpha:{ ok:true } });
  assert.equal(contextTx.state(), 'open');
  contextTx.commit();
  assert.equal(contextTx.state(), 'committed');
  assert.throws(() => contextTx.context.register('beta', { ok:true }), /state committed/);
  assert.throws(() => contextTx.commit(), /state committed/);

  let registerCalls = 0;
  const faultyContext = {
    current() { return null; },
    register(name) {
      registerCalls += 1;
      if (name === 'second') throw new Error('injected-register-failure');
    },
  };
  const failedContextTx = createContextTransaction(faultyContext);
  failedContextTx.context.register('first', { ok:true });
  failedContextTx.context.register('second', { ok:true });
  assert.throws(() => failedContextTx.commit(), /injected-register-failure/);
  assert.equal(registerCalls, 2);
  assert.equal(failedContextTx.state(), 'failed');
  assert.throws(() => failedContextTx.context.register('third', { ok:true }), /state failed/);

  const registryBase = fakeRegistry();
  const registryTx = createRegistryTransaction(registryBase);
  registryTx.registry.bind('device', { ok:true });
  registryTx.commit();
  assert.equal(registryTx.state(), 'committed');
  assert.throws(() => registryTx.registry.bind('photo', { ok:true }), /state committed/);
});

test('PWA result contract is validated before publication, including cleanup and pair-ticket identity', () => {
  const pairTickets = new Map();
  const device = { pwaPairTickets:pairTickets };
  const event = { clearRuntimeState() {} };
  const valid = {
    device,
    photo:{},
    webauthn:{},
    event,
    pairTickets,
    stop() {},
  };
  const checked = validatePwaApplicationResult(valid);
  assert.equal(checked.application, valid);
  assert.equal(checked.event, event);
  assert.equal(checked.pairTickets, pairTickets);
  assert.equal(typeof checked.stop, 'function');

  assert.throws(() => validatePwaApplicationResult({ ...valid, event:{} }), /clearRuntimeState/);
  assert.throws(() => validatePwaApplicationResult({ ...valid, pairTickets:new Map() }), /pair-ticket identity mismatch/);
  assert.throws(() => validatePwaApplicationResult({ ...valid, stop:null }), /stop/);
});

test('administrator JSON parser and lifecycle contracts are built before PWA publication or late-route mutation', () => {
  const finalHttp = read('lib/server/final-http-application.js');
  const composition = read('lib/server/http-pwa-lifecycle-application.js');
  const parser = composition.indexOf("const jsonParser = express.json({ limit:'256kb' })");
  const pwa = composition.indexOf('createPwaApplication({');
  const validate = composition.indexOf('validatePwaApplicationResult(pwaApplication)');
  const lifecycle = composition.indexOf('createLifecycleService({');
  const publish = composition.indexOf('registryTx.commit()');
  const rootRoute = composition.indexOf("app.post('/api/login'");
  const lateAdmin = composition.indexOf('adminApplication.attachLateRoutes({ shutdown, getServer })');
  assert.ok([parser, pwa, validate, lifecycle, publish, rootRoute, lateAdmin].every((n) => n >= 0));
  assert.ok(parser < pwa);
  assert.ok(pwa < validate && validate < lifecycle);
  assert.ok(lifecycle < publish && publish < rootRoute && rootRoute < lateAdmin);
});
