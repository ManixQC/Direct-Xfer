'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBootstrapReferenceRegistry } = require('../lib/server/bootstrap-reference-registry');

test('1.70.20 lazy references follow the live provider surface without reviving stale methods', () => {
  const registry = createBootstrapReferenceRegistry({ share:['getById'] });
  const source = {
    prefix:'old',
    getById(id) { return `${this.prefix}:${id}:old`; },
  };
  const getById = registry.refs.share.getById;
  registry.bind('share', source);
  assert.equal(getById('a'), 'old:a:old');

  source.prefix = 'new';
  source.getById = function getByIdReplacement(id) { return `${this.prefix}:${id}:new`; };
  assert.equal(getById('b'), 'new:b:new', 'the lazy facade must preserve the old live-forwarder semantics');

  let getterRuns = 0;
  Object.defineProperty(source, 'getById', {
    configurable:true,
    get() { getterRuns += 1; return () => 'unsafe'; },
  });
  assert.throws(() => getById('c'), /share\.getById must be an own function/);
  assert.equal(getterRuns, 0, 'fail-closed validation must not execute a replacement accessor');

  delete source.getById;
  assert.throws(() => getById('d'), /share\.getById must be an own function/);
});

test('1.70.20 conflicting bind batches are rejected before candidate provider introspection', () => {
  const registry = createBootstrapReferenceRegistry({ alpha:['run'], beta:['run'] });
  const boundBeta = { run() { return 'bound'; } };
  registry.bind('beta', boundBeta);

  let alphaDescriptorReads = 0;
  const alpha = new Proxy({ run() { return 'alpha'; } }, {
    getOwnPropertyDescriptor(target, property) {
      alphaDescriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const conflictingBeta = new Proxy({ run() { return 'conflict'; } }, {
    getOwnPropertyDescriptor() {
      throw new Error('conflicting provider must never be introspected');
    },
  });

  assert.throws(
    () => registry.bindMany([['alpha', alpha], ['beta', conflictingBeta]]),
    /namespace already bound: beta/,
  );
  assert.equal(alphaDescriptorReads, 0, 'no provider in a doomed batch should be inspected');
  assert.equal(registry.current('alpha'), null);
  assert.strictEqual(registry.current('beta'), boundBeta);
});

test('1.70.20 same-source rebinding revalidates the current provider contract', () => {
  const registry = createBootstrapReferenceRegistry({ runtime:['ready', 'reset'] });
  const source = { ready() { return true; }, reset() { return true; } };
  registry.bind('runtime', source);
  delete source.reset;

  assert.throws(() => registry.bind('runtime', source), /runtime\.reset must be an own function/);
  assert.throws(() => registry.refs.runtime.reset(), /runtime\.reset must be an own function/);
  assert.strictEqual(registry.current('runtime'), source, 'a failed revalidation must not replace the existing provider identity');
});
