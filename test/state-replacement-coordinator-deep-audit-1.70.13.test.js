'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStateReplacementCoordinator } = require('../lib/server/state-replacement-coordinator');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

test('1.70.20 busy-probe failures identify the failing boundary and async probes cannot masquerade as ordinary busy state', () => {
  const expected = new Error('late service unavailable');
  const throwing = createStateReplacementCoordinator({
    busyChecks:[['late-service', () => { throw expected; }]],
    resetSteps:[['noop', () => {}]],
  });
  assert.throws(
    () => throwing.isBusyForStateReplacement(),
    (error) => {
      assert.equal(error.code, 'STATE_REPLACEMENT_BUSY_CHECK_FAILED');
      assert.equal(error.step, 'late-service');
      assert.equal(error.cause, expected);
      return true;
    },
  );

  const asyncProbe = createStateReplacementCoordinator({
    busyChecks:[['async-service', () => Promise.resolve(false)]],
    resetSteps:[['noop', () => {}]],
  });
  assert.throws(
    () => asyncProbe.isBusyForStateReplacement(),
    (error) => error
      && error.code === 'STATE_REPLACEMENT_BUSY_CHECK_FAILED'
      && error.step === 'async-service'
      && /returned a Promise/.test(String(error.cause && error.cause.message)),
  );
});

test('1.70.20 runtime reset rejects async and reentrant steps instead of exposing a partially cleared runtime', () => {
  const calls = [];
  const asyncReset = createStateReplacementCoordinator({
    busyChecks:[['idle', () => false]],
    resetSteps:[
      ['async', () => Promise.resolve().then(() => calls.push('async-late'))],
      ['after', () => calls.push('after')],
    ],
  });
  assert.throws(
    () => asyncReset.clearRuntimeAfterRestore(),
    (error) => error
      && error.code === 'RESTORE_RUNTIME_RESET_FAILED'
      && error.failures.length === 1
      && error.failures[0].name === 'async'
      && error.failures[0].error.code === 'STATE_REPLACEMENT_ASYNC_RESET_UNSUPPORTED',
  );
  assert.deepEqual(calls, ['after']);

  let reentrant;
  reentrant = createStateReplacementCoordinator({
    busyChecks:[['idle', () => false]],
    resetSteps:[
      ['nested', () => reentrant.clearRuntimeAfterRestore()],
      ['after-nested', () => calls.push('after-nested')],
    ],
  });
  assert.throws(
    () => reentrant.clearRuntimeAfterRestore(),
    (error) => error
      && error.code === 'RESTORE_RUNTIME_RESET_FAILED'
      && error.failures[0].name === 'nested'
      && error.failures[0].error.code === 'STATE_REPLACEMENT_RESET_REENTRANT',
  );
  assert.ok(calls.includes('after-nested'));
});

test('1.70.20 restore readiness fails closed around the coordinator contract', () => {
  const restore = read('lib/server/restore-service.js');
  const coordinator = read('lib/server/state-replacement-coordinator.js');
  assert.match(restore, /state replacement readiness check failed; refusing restore/);
  assert.match(restore, /catch \(error\)[\s\S]*return true;/);
  assert.match(coordinator, /STATE_REPLACEMENT_BUSY_CHECK_FAILED/);
  assert.match(coordinator, /STATE_REPLACEMENT_ASYNC_RESET_UNSUPPORTED/);
  assert.match(coordinator, /STATE_REPLACEMENT_RESET_REENTRANT/);
});
