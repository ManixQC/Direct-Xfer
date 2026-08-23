'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBootstrapReferenceRegistry } = require('../lib/server/bootstrap-reference-registry');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

test('lazy bootstrap references stay stable before binding and preserve provider this', () => {
  const registry = createBootstrapReferenceRegistry({ share:['getById', 'listShares'] });
  const getById = registry.refs.share.getById;
  assert.strictEqual(getById, registry.refs.share.getById);
  assert.throws(() => getById('a'), /bootstrap-reference-not-ready:share\.getById/);

  const source = Object.freeze({
    prefix:'share',
    getById(id) { return `${this.prefix}:${id}`; },
    listShares() { return [this.prefix]; },
  });
  assert.strictEqual(registry.bind('share', source), source);
  assert.equal(getById('a'), 'share:a');
  assert.deepEqual(registry.refs.share.listShares(), ['share']);
  assert.strictEqual(registry.current('share'), source);
});

test('binding validates the complete namespace before publishing anything', () => {
  const registry = createBootstrapReferenceRegistry({ runtime:['folderMetrics', 'normExtList'] });
  const partial = { folderMetrics() {} };
  assert.throws(
    () => registry.bind('runtime', partial),
    /runtime\.normExtList must be an own function/,
  );
  assert.equal(registry.current('runtime'), null);
  assert.throws(
    () => registry.refs.runtime.folderMetrics(),
    /bootstrap-reference-not-ready:runtime\.folderMetrics/,
  );

  const accessor = {};
  Object.defineProperty(accessor, 'folderMetrics', { enumerable:true, get() { return () => {}; } });
  Object.defineProperty(accessor, 'normExtList', { enumerable:true, value() {} });
  assert.throws(
    () => registry.bind('runtime', accessor),
    /runtime\.folderMetrics must be an own function/,
  );
  assert.equal(registry.current('runtime'), null);
});


test('bindMany prevalidates every namespace and publishes the batch atomically', () => {
  const registry = createBootstrapReferenceRegistry({
    share:['getById'],
    search:['scheduleReindex'],
  });
  const share = { getById() { return 'share'; } };
  const brokenSearch = {};
  assert.throws(
    () => registry.bindMany([['share', share], ['search', brokenSearch]]),
    /search\.scheduleReindex must be an own function/,
  );
  assert.equal(registry.current('share'), null);
  assert.equal(registry.current('search'), null);

  const search = { scheduleReindex() { return 'search'; } };
  registry.bindMany([['share', share], ['search', search]]);
  assert.equal(registry.refs.share.getById(), 'share');
  assert.equal(registry.refs.search.scheduleReindex(), 'search');
});

test('bindMany aborts if validation re-enters the registry without losing the external binding', () => {
  const registry = createBootstrapReferenceRegistry({ alpha:['run'], external:['run'] });
  const external = { run() { return 'external'; } };
  let reentered = false;
  const alpha = new Proxy({ run() { return 'alpha'; } }, {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'run' && !reentered) {
        reentered = true;
        registry.bind('external', external);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  assert.throws(
    () => registry.bindMany([['alpha', alpha]]),
    /changed during binding preflight/,
  );
  assert.equal(registry.current('alpha'), null);
  assert.strictEqual(registry.current('external'), external);
});

test('registry rejects contract typos, unsafe names and conflicting rebinds', () => {
  assert.throws(
    () => createBootstrapReferenceRegistry({ share:['getById', 'getById'] }),
    /duplicate bootstrap reference operation: share\.getById/,
  );
  assert.throws(
    () => createBootstrapReferenceRegistry({ constructor:['x'] }),
    /invalid bootstrap reference namespace/,
  );
  assert.throws(
    () => createBootstrapReferenceRegistry({ share:['__proto__'] }),
    /invalid bootstrap reference operation/,
  );

  const registry = createBootstrapReferenceRegistry({ search:['scheduleReindex'] });
  const first = { scheduleReindex() {} };
  const second = { scheduleReindex() {} };
  registry.bind('search', first);
  assert.strictEqual(registry.bind('search', first), first, 'same-source bind is idempotent');
  assert.throws(() => registry.bind('search', second), /namespace already bound: search/);
  assert.strictEqual(registry.current('search'), first);
  assert.throws(() => registry.current('typo'), /unknown bootstrap reference namespace: typo/);
});

test('point 6 replaces hoisted server bridges with one validated lazy reference registry', () => {
  const server = read('server.js');
  const finalHttp = read('lib/server/final-http-application.js');
  assert.match(server, /createServerBootstrapReferences\(\)/);
  assert.match(server, /bootstrapReferences\.bindShareMediaTransfer\(shareMediaTransferApplication\)/);
  assert.match(server, /bootstrapReferences\.bindRuntime\(runtimeServicesApplication\)/);
  assert.match(finalHttp, /bindAdmin\.call\(bootstrapReferences, adminApplication\)/);
  const registrySource = read('lib/server/bootstrap-reference-registry.js');
  for (const binding of [
    "['share', application.shareService]",
    "['search', application.searchService]",
    "['photo', application.photoService]",
    "['transfer', application.transferService]",
  ]) assert.ok(registrySource.includes(binding), `missing atomic bootstrap binding ${binding}`);
  assert.doesNotMatch(server, /function getById\(\.\.\.args\)/);
  assert.doesNotMatch(server, /function getByToken\(\.\.\.args\)/);
  assert.doesNotMatch(server, /function listShares\(\.\.\.args\)/);
  assert.doesNotMatch(server, /function scheduleSearchReindex\(\.\.\.args\)/);
  assert.doesNotMatch(server, /function receptionThreadEnabled\(\.\.\.args\)/);
  assert.doesNotMatch(server, /function requireAdminApplication\(/);
  assert.doesNotMatch(server, /function requireRuntimeServicesApplication\(/);
});
