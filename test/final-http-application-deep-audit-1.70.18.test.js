'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const {
  FINAL_CONTEXT_TARGETS,
  FINAL_BOOTSTRAP_TARGETS,
  preflightFinalPublicationTargets,
  validateFinalLifecycleService,
} = require('../lib/server/final-http-application');
const {
  PWA_REGISTRY_SERVICES,
  validateLifecycleServiceResult,
} = require('../lib/server/http-pwa-lifecycle-application');

function cleanTargets(overrides = {}) {
  const contextValues = new Map(Object.entries(overrides.context || {}));
  const bootstrapValues = new Map(Object.entries(overrides.bootstrap || {}));
  const pwaValues = new Map(Object.entries(overrides.pwa || {}));
  return {
    context:{ current(name) { return contextValues.get(name) || null; } },
    bootstrapReferences:{ current(name) { return bootstrapValues.get(name) || null; } },
    pwaRegistry:{ current(name) { return pwaValues.get(name) || null; } },
  };
}

function lifecycle() {
  return Object.freeze({
    start() {}, shutdown() {}, getServer() { return null; }, getServerScheme() { return 'http'; },
  });
}

test('final HTTP preflight rejects all shared publication conflicts before administrator composition', () => {
  for (const name of FINAL_CONTEXT_TARGETS) {
    assert.throws(
      () => preflightFinalPublicationTargets(cleanTargets({ context:{ [name]:{} } })),
      new RegExp(`context target already registered: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  }
  for (const name of FINAL_BOOTSTRAP_TARGETS) {
    assert.throws(
      () => preflightFinalPublicationTargets(cleanTargets({ bootstrap:{ [name]:{} } })),
      new RegExp(`bootstrap reference target already bound: ${name}`),
    );
  }
  for (const name of PWA_REGISTRY_SERVICES) {
    assert.throws(
      () => preflightFinalPublicationTargets(cleanTargets({ pwa:{ [name]:{} } })),
      new RegExp(`PWA service target already bound: ${name}`),
    );
  }
  assert.doesNotThrow(() => preflightFinalPublicationTargets(cleanTargets()));
});

test('final lifecycle contract requires stable own functions and rejects inherited/accessor fallbacks', () => {
  const good = lifecycle();
  assert.equal(validateFinalLifecycleService(good), good);
  assert.equal(validateLifecycleServiceResult(good), good);

  const inherited = Object.create(good);
  assert.throws(() => validateFinalLifecycleService(inherited), /lifecycle service\.start as an own data property/);
  assert.throws(() => validateLifecycleServiceResult(inherited), /missing stable start/);

  const accessor = { shutdown() {}, getServer() {}, getServerScheme() {} };
  Object.defineProperty(accessor, 'start', { get() { throw new Error('must-not-run'); } });
  assert.throws(() => validateFinalLifecycleService(accessor), /lifecycle service\.start as an own data property/);
  assert.throws(() => validateLifecycleServiceResult(accessor), /missing stable start/);
});

test('publication preflight precedes Admin mutation and lifecycle validation precedes PWA commits', () => {
  const finalHttp = read('lib/server/final-http-application.js');
  const httpPwa = read('lib/server/http-pwa-lifecycle-application.js');
  const preflight = finalHttp.indexOf('preflightFinalPublicationTargets({ context, bootstrapReferences, pwaRegistry });');
  const root = finalHttp.indexOf('const rootRoutes = createRootRoutes({');
  const admin = finalHttp.indexOf('const adminApplication = createAdminApplication({');
  assert.ok(preflight >= 0 && root > preflight && admin > root);

  const validate = httpPwa.indexOf('validateLifecycleServiceResult(lifecycleService);');
  const registryCommit = httpPwa.indexOf('registryTx.commit();');
  const contextCommit = httpPwa.indexOf('contextTx.commit();');
  assert.ok(validate >= 0 && registryCommit > validate && contextCommit > registryCommit);
});
