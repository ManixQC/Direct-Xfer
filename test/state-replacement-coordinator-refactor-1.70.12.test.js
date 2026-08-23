'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStateReplacementCoordinator } = require('../lib/server/state-replacement-coordinator');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

test('state replacement coordinator preflights the complete step graph without invoking late services', () => {
  let calls = 0;
  const coordinator = createStateReplacementCoordinator({
    busyChecks:[['late-busy', () => { calls += 1; return false; }]],
    resetSteps:[['late-reset', () => { calls += 1; }]],
  });
  assert.equal(calls, 0, 'composition must not dereference late services');
  assert.equal(coordinator.isBusyForStateReplacement(), false);
  coordinator.clearRuntimeAfterRestore();
  assert.equal(calls, 2);
  assert.throws(
    () => createStateReplacementCoordinator({ busyChecks:[['x', () => false], ['x', () => false]], resetSteps:[['r', () => {}]] }),
    /duplicate busyChecks name: x/,
  );
  assert.throws(
    () => createStateReplacementCoordinator({ busyChecks:[['x', null]], resetSteps:[['r', () => {}]] }),
    /busyChecks requires x\(\)/,
  );
});

test('state replacement busy checks preserve historical short-circuit order', () => {
  const calls = [];
  let maintenanceBusy = false;
  const coordinator = createStateReplacementCoordinator({
    busyChecks:[
      ['backup', () => { calls.push('backup'); return false; }],
      ['transfers', () => { calls.push('transfers'); return false; }],
      ['maintenance', () => { calls.push('maintenance'); return maintenanceBusy; }],
      ['security', () => { calls.push('security'); return true; }],
    ],
    resetSteps:[['noop', () => {}]],
  });
  assert.equal(coordinator.isBusyForStateReplacement(), true);
  assert.deepEqual(calls, ['backup', 'transfers', 'maintenance', 'security']);
  calls.length = 0;
  maintenanceBusy = true;
  assert.equal(coordinator.isBusyForStateReplacement(), true);
  assert.deepEqual(calls, ['backup', 'transfers', 'maintenance']);
});

test('runtime reset attempts every boundary and aggregates failures under the existing restore contract', () => {
  const calls = [];
  const first = new Error('security failed');
  const second = new Error('maintenance failed');
  const coordinator = createStateReplacementCoordinator({
    busyChecks:[['idle', () => false]],
    resetSteps:[
      ['security', () => { calls.push('security'); throw first; }],
      ['transfers', () => calls.push('transfers')],
      ['maintenance', () => { calls.push('maintenance'); throw second; }],
      ['search', () => calls.push('search')],
    ],
  });
  assert.throws(
    () => coordinator.clearRuntimeAfterRestore(),
    (error) => {
      assert.equal(error.code, 'RESTORE_RUNTIME_RESET_FAILED');
      assert.match(error.message, /security,maintenance/);
      assert.deepEqual(error.failures, [
        { name:'security', error:first },
        { name:'maintenance', error:second },
      ]);
      return true;
    },
  );
  assert.deepEqual(calls, ['security', 'transfers', 'maintenance', 'search']);
});

test('core-state and restore depend on one replacement coordinator instead of per-domain reset callbacks', () => {
  const server = read('server.js');
  const core = read('lib/server/core-state-application.js');
  const lifecycle = read('lib/server/state-lifecycle-application.js');
  const restore = read('lib/server/restore-service.js');
  assert.match(server, /createStateLifecycleApplication\(\{/);
  assert.match(lifecycle, /createStateReplacementCoordinator\(\{/);
  assert.match(lifecycle, /coreStateApplication\.initializeStateLifecycle\(\{[\s\S]*stateReplacementCoordinator,/);
  assert.doesNotMatch(lifecycle, /initializeStateLifecycle\(\{[\s\S]*clearSecurityRuntimeState:/);
  assert.doesNotMatch(core, /clearSecurityRuntimeState|isSecurityStateReplacementBusy|clearConnectorJobRuntimeState/);
  assert.match(core, /stateReplacementCoordinator:lifecycleDeps\.stateReplacementCoordinator/);
  assert.match(restore, /stateReplacementCoordinator\.isBusyForStateReplacement\(\)/);
  assert.match(restore, /stateReplacementCoordinator\.clearRuntimeAfterRestore\(\)/);
});
