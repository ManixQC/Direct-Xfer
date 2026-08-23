'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const coreUtils = require('../lib/core-utils');
const { createCoreStateApplication } = require('../lib/server/core-state-application');

function makeCore({ platformFs = fs } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-core-state-audit-'));
  const dataDir = path.join(temp, 'data');
  const hostRoot = path.join(temp, 'host');
  fs.mkdirSync(dataDir, { recursive:true });
  fs.mkdirSync(hostRoot, { recursive:true });
  const bridges = {
    getServerScheme:() => 'http', clientIp:() => '127.0.0.1', scheduleSearchReindex:() => {}, resetMailerCache:() => {},
    onSettingsChanged:() => {}, emailSendable:() => false, pushSubs:() => [],
    normalizeLinkBase:(value) => String(value || '').trim(), cleanBrokerUrl:(value) => String(value || '').trim(),
    parseHotlinkHosts:() => [], normalizeShareColor:(value) => value || '', normalizeTags:() => [],
    normalizeDescriptionMd:(value) => String(value || ''), normExtList:() => [],
    addAdminCenterNotification:() => null, noteCenterServiceState:() => null,
    getShareService:() => null, getPhotoService:() => null, getPwaDeviceService:() => null,
    pubIp:(ip) => ip, getShareById:() => null, getTrashItems:() => [], getPwaDevices:() => [],
    isSessionActive:() => false, getActiveTransfers:() => new Map(),
  };
  const app = createCoreStateApplication({
    platform:{ fs:platformFs, path, crypto, os, net, tls, forge:null, nodemailer:null, webpush:null },
    config:{
      APP_NAME:'Direct-Xfer', APP_VERSION:'1.70.4', AUDIT_MAX:500,
      DATA_DIR:dataDir, DATA_KEY:'', HOST_ROOT:hostRoot,
      BIND:'127.0.0.1', PUBLIC_HOST:'', PUBLIC_URL:'', LOCAL_IP:'127.0.0.1',
      PORT:55750, TRUST_PROXY:false, UPDATE_REPO:'', UPDATE_TAG:'',
      SHUTDOWN_AFTER_DOWNLOAD:false, GOOGLE_OAUTH_BROKER_URL_ENV:'', WEBHOOK_URL:'',
      SMTP_URL:'', ADMIN_ALLOWED_IPS:[], UPDATE_CHECK:false, PUBLIC_IP_DISCOVERY:false,
      MAX_UPLOAD_BYTES:0, HISTORY_MAX:100, SECRETS_DIR:path.join(dataDir, 'secrets'),
    },
    runtimeBootstrap:{ ensureBaseDirectories() {} },
    utils:coreUtils,
    bridges,
    env:{},
  });
  return {
    app, temp, dataDir,
    close() {
      try { app.initializePersistence().stateStore.close(); } catch (_) {}
      fs.rmSync(temp, { recursive:true, force:true });
    },
  };
}

function lifecycleDeps(temp, overrides = {}) {
  const noop = () => {};
  return {
    LOG_FILE:path.join(temp, 'transfers.log'),
    stateReplacementCoordinator:{
      isBusyForStateReplacement:() => false,
      clearRuntimeAfterRestore:noop,
    },
    normalizePhotoHistory:(value) => Array.isArray(value) ? value : [],
    sanitizeUndoLog:(value) => Array.isArray(value) ? value : [],
    sanitizeDlpQuarantineState:() => false,
    reconcileDlpQuarantineFiles:() => false,
    migrateLegacyFirstUseExpiryState:() => false,
    clearShareRuntimeState:noop,
    cleanupDlpQuarantineOrphans:noop,
    migrateLegacyPhotoStorage:async () => {},
    reindex:noop,
    trimLogIfNeeded:noop,
    pruneHistory:noop,
    exit:noop,
    defer:(fn) => setImmediate(fn),
    logger:{ error:noop, warn:noop },
    ...overrides,
  };
}

test('1.70.4 live root-state adapters fail closed until persistence is ready', () => {
  const f = makeCore();
  try {
    assert.throws(() => f.app.liveState.state, /root state is not initialized/);
    f.app.initializePersistence();
    assert.strictEqual(f.app.liveState.state, f.app.getState());
  } finally { f.close(); }
});

test('1.70.4 persistence initialization cannot leave a usable phantom root after state-store construction fails', () => {
  const f = makeCore({ platformFs:{ ...fs, writeFile:null } });
  try {
    assert.throws(() => f.app.initializePersistence(), /state-store requires fs/);
    assert.throws(() => f.app.getState(), /root state is not initialized/);
    assert.throws(() => f.app.initializePersistence(), /previously failed; restart is required/);
  } finally { f.close(); }
});

test('1.70.4 lifecycle dependency preflight is side-effect free and remains retryable before composition starts', () => {
  const f = makeCore();
  try {
    f.app.initializePersistence();
    assert.throws(() => f.app.initializeStateLifecycle({}), /stateLifecycle\.stateReplacementCoordinator/);
    assert.throws(
      () => f.app.initializeStateLifecycle({ stateReplacementCoordinator:{} }),
      /stateLifecycle\.stateReplacementCoordinator\.isBusyForStateReplacement/,
    );
  } finally { f.close(); }
});


test('core lifecycle publishes the exact coordinator facade used by restore and keeps it stable when queried again', () => {
  const f = makeCore();
  try {
    f.app.initializePersistence();
    const deps = lifecycleDeps(f.temp);
    const lifecycle = f.app.initializeStateLifecycle(deps);
    assert.equal(lifecycle.stateReplacementCoordinator.isBusyForStateReplacement(), false);
    assert.equal(typeof lifecycle.stateReplacementCoordinator.clearRuntimeAfterRestore, 'function');
    const ignoredCoordinator = { isBusyForStateReplacement:() => true, clearRuntimeAfterRestore() {} };
    assert.strictEqual(
      f.app.initializeStateLifecycle({ ...deps, stateReplacementCoordinator:ignoredCoordinator }),
      lifecycle,
    );
    assert.equal(lifecycle.stateReplacementCoordinator.isBusyForStateReplacement(), false);
  } finally { f.close(); }
});

test('1.70.4 intercepted fatal store bootstrap is never published and cannot be replayed after partial lifecycle composition', () => {
  const f = makeCore();
  try {
    const persistence = f.app.initializePersistence();
    fs.writeFileSync(persistence.storeFile, JSON.stringify({ version:1, settings:{} }), 'utf8');
    let exitCalls = 0;
    const deps = lifecycleDeps(f.temp, { exit:() => { exitCalls += 1; } });
    assert.throws(
      () => f.app.initializeStateLifecycle(deps),
      (error) => error && error.code === 'CORE_STATE_BOOTSTRAP_INCOMPLETE',
    );
    assert.equal(exitCalls, 1);
    assert.throws(
      () => f.app.initializeStateLifecycle(deps),
      (error) => /previously failed; restart is required/.test(error.message)
        && error.cause && error.cause.code === 'CORE_STATE_BOOTSTRAP_INCOMPLETE',
    );
    assert.equal(exitCalls, 1, 'a failed bootstrap must not be executed twice');
  } finally { f.close(); }
});
