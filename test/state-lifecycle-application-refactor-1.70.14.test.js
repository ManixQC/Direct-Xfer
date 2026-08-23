'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStateLifecycleApplication } = require('../lib/server/state-lifecycle-application');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fixture(overrides = {}) {
  const calls = [];
  const activeTransfers = new Map();
  const shareService = { clearRuntimeState:() => calls.push('share-clear') };
  const photoService = {
    normalizePhotoHistory:() => calls.push('photo-normalize'),
    migrateLegacyPhotoStorage:() => calls.push('photo-migrate'),
  };
  const dlpService = {
    sanitizeDlpQuarantineState:() => calls.push('dlp-sanitize'),
    reconcileDlpQuarantineFiles:() => calls.push('dlp-reconcile'),
    cleanupDlpQuarantineOrphans:() => calls.push('dlp-cleanup'),
  };
  const transferService = {
    activeTransfers,
    clearRuntimeState:() => calls.push('transfers-clear'),
    trimLogIfNeeded:() => calls.push('log-trim'),
    pruneHistory:() => calls.push('history-prune'),
  };
  const searchService = { resetAfterRestore:(delay) => calls.push(`search-reset:${delay}`) };
  const shareFacade = {
    sanitizeUndoLog:() => calls.push('undo-sanitize'),
    migrateLegacyFirstUseExpiryState:() => calls.push('first-use-migrate'),
    reindex:() => calls.push('reindex'),
  };
  const shareMediaTransferApplication = {
    shareService, photoService, dlpService, transferService, searchService, shareFacade,
    isBusyForStateReplacement:() => { calls.push('share-busy'); return false; },
    clearMediaRuntimeState:() => calls.push('media-clear'),
  };
  const notificationApplication = {
    isBusyForStateReplacement:() => { calls.push('notifications-busy'); return false; },
    clearNotificationRuntimeState:() => calls.push('notifications-clear'),
    clearNotificationCenterRuntimeState:() => calls.push('notification-center-clear'),
    clearPwaNotificationRuntimeState:() => calls.push('pwa-notifications-clear'),
  };
  const activityPresenceService = { closeActivityPresenceStreams:() => calls.push('activity-presence-clear') };
  const accountService = { clearInitialPassword:() => calls.push('account-bootstrap-clear') };

  const lateCalls = { runtime:0, publicHttp:0, security:0, admin:0, pwa:0 };
  const runtimeServicesApplication = {
    isBackupInFlight:() => { calls.push('backup-busy'); return false; },
    hasActiveUploads:() => { calls.push('uploads-busy'); return false; },
    isMaintenanceStateReplacementBusy:() => { calls.push('maintenance-busy'); return false; },
    clearUploadRuntimeAfterRestore:() => calls.push('uploads-clear'),
    clearMaintenanceRuntimeState:() => calls.push('maintenance-clear'),
  };
  const publicHttpApplication = {
    isBusyForStateReplacement:() => { calls.push('public-http-busy'); return false; },
    clearRuntimeState:() => calls.push('downloads-clear'),
  };
  const securityAuthApplication = {
    isBusyForStateReplacement:() => { calls.push('security-busy'); return false; },
    clearRuntimeState:() => calls.push('security-clear'),
  };
  const adminApplication = {
    storageConnectorJobService:{
      isBusyForStateReplacement:() => { calls.push('connector-jobs-busy'); return false; },
      clearRuntimeAfterRestore:() => calls.push('connector-jobs-clear'),
    },
    systemHealthService:{ clearRuntimeState:() => calls.push('system-health-clear') },
  };
  const httpPwaLifecycleApplication = {
    pairTickets:{ clear:() => calls.push('pwa-pair-tickets-clear') },
    webauthn:{ clearRuntimeState:() => calls.push('webauthn-clear') },
    event:{ clearRuntimeState:() => calls.push('pwa-events-clear') },
  };

  let lifecycleDeps = null;
  let initializeCalls = 0;
  let cachedLifecycle = null;
  const restoreService = {};
  const stateBootstrapService = {};
  const coreStateApplication = overrides.coreStateApplication || {
    initializeStateLifecycle:(deps) => {
      initializeCalls += 1;
      if (cachedLifecycle) return cachedLifecycle;
      lifecycleDeps = deps;
      cachedLifecycle = Object.freeze({
        stateReplacementCoordinator:deps.stateReplacementCoordinator,
        restoreService,
        stateBootstrapService,
      });
      return cachedLifecycle;
    },
  };

  const late = {
    runtimeServicesApplication:() => { lateCalls.runtime += 1; return runtimeServicesApplication; },
    publicHttpApplication:() => { lateCalls.publicHttp += 1; return publicHttpApplication; },
    securityAuthApplication:() => { lateCalls.security += 1; return securityAuthApplication; },
    adminApplication:() => { lateCalls.admin += 1; return adminApplication; },
    httpPwaLifecycleApplication:() => { lateCalls.pwa += 1; return httpPwaLifecycleApplication; },
    ...(overrides.late || {}),
  };

  const options = {
    coreStateApplication,
    config:{ LOG_FILE:'/tmp/transfers.log' },
    services:{ shareMediaTransferApplication, notificationApplication, activityPresenceService, accountService },
    late,
    process:overrides.process || { exit:() => {}, defer:(fn) => fn(), logger:{ log(){}, warn(){}, error(){} } },
  };
  const application = createStateLifecycleApplication(options);

  return {
    application, options, calls, lateCalls, activeTransfers, shareService, lifecycleDeps,
    getLifecycleDeps:() => lifecycleDeps,
    getInitializeCalls:() => initializeCalls,
    restoreService, stateBootstrapService,
  };
}

test('state lifecycle application derives lifecycle hooks without resolving late applications during startup composition', () => {
  const f = fixture();
  assert.equal(f.getInitializeCalls(), 1);
  assert.deepEqual(f.lateCalls, { runtime:0, publicHttp:0, security:0, admin:0, pwa:0 });
  assert.equal(f.application.restoreService, f.restoreService);
  assert.equal(f.application.stateBootstrapService, f.stateBootstrapService);

  const deps = f.getLifecycleDeps();
  assert.equal(deps.LOG_FILE, '/tmp/transfers.log');
  assert.equal(typeof deps.stateReplacementCoordinator.isBusyForStateReplacement, 'function');
  assert.equal(typeof deps.stateReplacementCoordinator.clearRuntimeAfterRestore, 'function');
  for (const name of [
    'normalizePhotoHistory', 'sanitizeUndoLog', 'sanitizeDlpQuarantineState',
    'reconcileDlpQuarantineFiles', 'migrateLegacyFirstUseExpiryState',
    'clearShareRuntimeState', 'cleanupDlpQuarantineOrphans', 'migrateLegacyPhotoStorage',
    'reindex', 'trimLogIfNeeded', 'pruneHistory',
  ]) assert.equal(typeof deps[name], 'function', name);
});

test('busy checks preserve the historical order and short-circuit before later providers', () => {
  const f = fixture();
  assert.equal(f.application.stateReplacementCoordinator.isBusyForStateReplacement(), false);
  assert.deepEqual(f.calls, [
    'backup-busy', 'uploads-busy', 'share-busy', 'public-http-busy', 'maintenance-busy',
    'connector-jobs-busy', 'security-busy', 'notifications-busy',
  ]);
  assert.equal(f.lateCalls.pwa, 0);

  f.calls.length = 0;
  f.activeTransfers.set('t1', {});
  assert.equal(f.application.stateReplacementCoordinator.isBusyForStateReplacement(), true);
  assert.deepEqual(f.calls, ['backup-busy']);
});

test('runtime reset preserves all 17 historical reset steps in order and resolves late owners on demand', () => {
  const f = fixture();
  f.application.stateReplacementCoordinator.clearRuntimeAfterRestore();
  assert.deepEqual(f.calls, [
    'security-clear', 'transfers-clear', 'downloads-clear', 'media-clear', 'uploads-clear',
    'pwa-pair-tickets-clear', 'webauthn-clear', 'notifications-clear', 'pwa-events-clear',
    'activity-presence-clear', 'notification-center-clear', 'pwa-notifications-clear',
    'maintenance-clear', 'connector-jobs-clear', 'system-health-clear',
    'account-bootstrap-clear', 'search-reset:1000',
  ]);
  assert.ok(f.lateCalls.runtime >= 2);
  assert.ok(f.lateCalls.publicHttp >= 1);
  assert.ok(f.lateCalls.security >= 1);
  assert.ok(f.lateCalls.admin >= 2);
  assert.ok(f.lateCalls.pwa >= 3);
});

test('a missing late application fails closed through the coordinator instead of being dereferenced during composition', () => {
  const f = fixture({ late:{ runtimeServicesApplication:() => null } });
  assert.throws(
    () => f.application.stateReplacementCoordinator.isBusyForStateReplacement(),
    (error) => error && error.code === 'STATE_REPLACEMENT_BUSY_CHECK_FAILED' && error.step === 'backup'
  );
});


test('share runtime reset keeps the historical live-method and receiver semantics', () => {
  const f = fixture();
  let firstThis = null;
  let secondThis = null;
  f.shareService.clearRuntimeState = function first() { firstThis = this; };
  f.getLifecycleDeps().clearShareRuntimeState();
  assert.strictEqual(firstThis, f.shareService);

  f.shareService.clearRuntimeState = function second() { secondThis = this; };
  f.getLifecycleDeps().clearShareRuntimeState();
  assert.strictEqual(secondThis, f.shareService, 'restore must resolve the current share-service method instead of a stale capture');
});

test('state lifecycle application cannot expose a split-brain coordinator when the core lifecycle is already initialized', () => {
  const f = fixture();
  const second = createStateLifecycleApplication(f.options);
  assert.equal(f.getInitializeCalls(), 2);
  assert.strictEqual(second.restoreService, f.application.restoreService);
  assert.strictEqual(second.stateBootstrapService, f.application.stateBootstrapService);
  assert.strictEqual(
    second.stateReplacementCoordinator,
    f.application.stateReplacementCoordinator,
    'recomposition must publish the coordinator actually owned by the existing restore lifecycle',
  );
});

test('logger contract is preflighted before core lifecycle initialization can become one-shot', () => {
  let initializeCalls = 0;
  assert.throws(
    () => fixture({
      coreStateApplication:{ initializeStateLifecycle() { initializeCalls += 1; return {}; } },
      process:{ exit:() => {}, defer:(fn) => fn(), logger:{} },
    }),
    /process\.logger\.error\(\)/,
  );
  assert.equal(initializeCalls, 0);
});

test('server delegates the full state lifecycle graph to the extracted application boundary', () => {
  const server = read('server.js');
  const lifecycle = read('lib/server/state-lifecycle-application.js');
  assert.match(server, /createStateLifecycleApplication\(\{/);
  assert.doesNotMatch(server, /createStateReplacementCoordinator\(\{/);
  assert.doesNotMatch(server, /coreStateApplication\.initializeStateLifecycle\(\{/);
  assert.match(lifecycle, /createStateReplacementCoordinator\(\{/);
  assert.match(lifecycle, /coreStateApplication\.initializeStateLifecycle\(\{/);
  for (const name of ['backup','transfers','uploads','share-http','maintenance','connector-jobs','security','notifications']) {
    assert.match(lifecycle, new RegExp(`\\['${name}'`), name);
  }
  for (const name of ['pwa-pair-tickets','webauthn','pwa-events','activity-presence','system-health','account-bootstrap','search']) {
    assert.match(lifecycle, new RegExp(`\\['${name}'`), name);
  }
  assert.ok(server.split('\n').length < 780, `server.js should shrink after state lifecycle extraction (${server.split('\n').length} lines)`);
});

test('Windows runtime integrity protects the state lifecycle application boundary', () => {
  const rel = 'lib/server/state-lifecycle-application.js';
  const source = read(rel).replace(/\r\n?/g, '\n');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  assert.match(read('windows-server-host/Program.cs'), new RegExp(`\\{ "${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", "${hash}" \\}`));
});
