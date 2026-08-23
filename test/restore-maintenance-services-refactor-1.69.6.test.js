'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createRestoreService } = require('../lib/server/restore-service');
const { createStateReplacementCoordinator } = require('../lib/server/state-replacement-coordinator');
const { createMaintenanceService } = require('../lib/server/maintenance-service');
const { attachAdminDiagnosticsRoutes } = require('../lib/server/admin-diagnostics-routes');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

function restoreFixture(persistResults = [true], overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-restore-service-'));
  const data = path.join(tmp, 'data');
  const secrets = path.join(data, 'secrets');
  const tls = path.join(data, 'tls');
  const log = path.join(data, 'transfers.log');
  const auditChain = path.join(data, 'audit-chain.log');
  const auditHead = path.join(data, 'audit-head.json');
  fs.mkdirSync(secrets, { recursive:true });
  fs.writeFileSync(path.join(secrets, 'old-secret.dxe'), 'old-secret');
  fs.writeFileSync(log, 'old-journal\n');

  let state = {
    version:1,
    shares:[{ id:'old' }],
    trash:[], settings:{ marker:'old' }, history:[], photoHistory:[], stats:{},
    meta:{ secrets:{ 'old-secret':{ expiresAt:Date.now() + 60000 } } },
    audit:[], ipNames:{}, undoLog:[], activityLog:[],
  };
  let historyRevision = 7;
  let persistIndex = 0;
  const calls = [];
  const noop = () => {};
  const callback = (name, fallback) => typeof overrides[name] === 'function' ? overrides[name] : fallback;
  const stateReplacementCoordinator = overrides.stateReplacementCoordinator || createStateReplacementCoordinator({
    busyChecks:[
      ['backup', callback('isBackupInFlight', () => false)],
      ['transfers', () => callback('getActiveTransferCount', () => 0)() > 0],
      ['uploads', callback('hasActiveUploads', () => false)],
      ['share-http', callback('isShareStateReplacementBusy', () => false)],
      ['maintenance', callback('isMaintenanceStateReplacementBusy', () => false)],
      ['connector-jobs', callback('isConnectorJobStateReplacementBusy', () => false)],
      ['security', callback('isSecurityStateReplacementBusy', () => false)],
      ['notifications', callback('isNotificationStateReplacementBusy', () => false)],
    ],
    resetSteps:[
      ['security', callback('clearSecurityRuntimeState', callback('clearAllSessions', () => calls.push('sessions')))],
      ['transfers', callback('clearTransferRuntimeState', () => calls.push('transfers'))],
      ['downloads', callback('clearDownloadRuntimeState', () => calls.push('downloads'))],
      ['media', callback('clearMediaRuntimeState', () => calls.push('media'))],
      ['uploads', callback('clearUploadRuntimeAfterRestore', () => calls.push('uploads'))],
      ['pwa-pair-tickets', callback('clearPwaPairTickets', noop)],
      ['webauthn', callback('clearWebauthnRuntimeState', noop)],
      ['notifications', callback('clearNotificationRuntimeState', noop)],
      ['pwa-events', callback('clearPwaEventRuntimeState', noop)],
      ['activity-presence', callback('closeActivityPresenceStreams', callback('closeLiveActivityClients', noop))],
      ['notification-center', callback('clearNotificationCenterRuntimeState', noop)],
      ['pwa-notifications', callback('clearPwaNotificationRuntimeState', noop)],
      ['maintenance', callback('clearMaintenanceRuntimeState', noop)],
      ['connector-jobs', callback('clearConnectorJobRuntimeState', () => calls.push('connector-jobs'))],
      ['system-health', callback('clearSystemHealthRuntimeState', noop)],
      ['account-bootstrap', callback('clearAccountBootstrapRuntime', () => calls.push('account-bootstrap'))],
      ['search', () => callback('resetSearchAfterRestore', noop)(1000)],
    ],
  });
  const service = createRestoreService({
    fs, path, crypto, forge:null,
    DATA_DIR:data, SECRETS_DIR:secrets, LOG_FILE:log,
    AUDIT_CHAIN_FILE:auditChain, AUDIT_HEAD_FILE:auditHead,
    DEFAULT_SETTINGS:{ marker:'default' }, HISTORY_MAX:10, AUDIT_MAX:10,
    getState:() => state,
    replaceState:(next) => { state = next; },
    getHistoryViewRevision:() => historyRevision,
    setHistoryViewRevision:(next) => { historyRevision = next; },
    parseAuditChainText:() => ({ entries:[], malformed:false }),
    validateAuditRestoreEntries:() => ({ ok:true }),
    ensureAuditChainKey:() => Buffer.alloc(32),
    auditKeyId:() => 'key', timingSafeEqualStr:(a, b) => a === b,
    verifyAuditSnapshot:() => ({ ok:true }), verifyAuditChain:() => ({ ok:true }),
    parseAuditChainFile:() => ({ entries:[{ hash:'legacy' }] }),
    replaceChainForRestore:(entries) => entries,
    stateReplacementCoordinator,
    tlsDirPath:() => tls, validateLocalCaCertificate:noop, validateLeafCertificate:noop,
    markTlsRestartRequired:noop,
    normalizePhotoHistory:(value) => Array.isArray(value) ? value : [],
    sanitizeUndoLog:(value) => Array.isArray(value) ? value : [],
    sanitizeActivityLog:(value) => Array.isArray(value) ? value : [],
    sanitizeDlpQuarantineState:noop, reconcileDlpQuarantineFiles:noop,
    syncLiveActivityCache:noop,
    buildLegacyActivityLog:() => [{ kind:'legacy' }],
    migrateLegacyFirstUseExpiryState:noop, clearShareRuntimeState:noop,
    persistNow:() => persistResults[Math.min(persistIndex++, persistResults.length - 1)],
    cleanupDlpQuarantineOrphans:noop,
    migrateLegacyPhotoStorage:() => Promise.resolve(),
    defer:(fn) => fn(),
    logger:{ error:noop, warn:noop },
    ...overrides,
  });
  return {
    tmp, data, secrets, tls, log, service, calls,
    get state() { return state; },
    get historyRevision() { return historyRevision; },
    close() { fs.rmSync(tmp, { recursive:true, force:true }); },
  };
}

function backupBundle() {
  return {
    kind:'dxbackup',
    v:3,
    store:{
      shares:[{ id:'restored' }], trash:[], settings:{ marker:'restored' },
      history:[{ id:'h1' }], photoHistory:[], stats:{}, meta:{ secrets:{} },
      audit:[], ipNames:{}, undoLog:[], activityLog:[],
    },
    journal:'new-journal\n',
    secrets:{},
  };
}

test('restore and maintenance implementations live behind explicit service boundaries', () => {
  const server = read('server.js');
  const core = read('lib/server/core-state-application.js');
  const restore = read('lib/server/restore-service.js');
  const replacementCoordinator = read('lib/server/state-replacement-coordinator.js');
  const stateLifecycle = read('lib/server/state-lifecycle-application.js');
  const maintenance = read('lib/server/maintenance-service.js');
  const runtimeServices = read('lib/server/runtime-services-application.js');
  const lifecycle = read('lib/server/lifecycle-service.js');
  const finalHttp = read('lib/server/final-http-application.js');
  const httpComposition = read('lib/server/http-pwa-lifecycle-application.js');
  assert.match(server, /createStateLifecycleApplication\(\{/);
  assert.match(stateLifecycle, /coreStateApplication\.initializeStateLifecycle\(\{/);
  assert.match(core, /createRestoreService\(\{/);
  assert.match(server, /createRuntimeServicesApplication/);
  assert.match(runtimeServices, /createMaintenanceService/);
  assert.match(httpComposition, /createLifecycleService/);
  assert.match(lifecycle, /maintenanceService\.start\(\)/);
  assert.match(lifecycle, /maintenanceService\.stop\(\)/);
  assert.match(stateLifecycle, /\['connector-jobs',[\s\S]*storageConnectorJobService[\s\S]*isBusyForStateReplacement/);
  assert.match(stateLifecycle, /\['connector-jobs',[\s\S]*storageConnectorJobService[\s\S]*clearRuntimeAfterRestore/);
  assert.match(replacementCoordinator, /function createStateReplacementCoordinator\(options = \{\}\)/);
  for (const name of ['applyRestore', 'restoredAuditEntries', 'recoverInterruptedCoreRestore', 'recoverInterruptedSecretRestore', 'recoverInterruptedTlsRestore']) {
    assert.doesNotMatch(server, new RegExp(`function ${name}\\(`));
    assert.match(restore, new RegExp(`function ${name}\\(`));
  }
  for (const name of ['purgeExpiredSecrets', 'purgeOldLog', 'purgeOldInbox', 'purgeExpiredFiles', 'blockRansomwareClient']) {
    assert.doesNotMatch(server, new RegExp(`function ${name}\\(`));
    assert.match(maintenance, new RegExp(`function ${name}\\(`));
  }
  assert.doesNotMatch(restore, /process\.platform === 'win32'[\s\S]{0,100}unlinkSync/);
  assert.ok(server.split('\n').length < 6600);
});

test('composition order keeps late notification, upload, transfer and PWA dependencies lazy', () => {
  const server = read('server.js');
  const config = read('lib/server/config.js');
  const shareMediaTransfer = read('lib/server/share-media-transfer-application.js');
  const notificationApplication = read('lib/server/notification-application.js');
  const coreStateBridges = read('lib/server/core-state-bridges.js');
  const finalHttp = read('lib/server/final-http-application.js');
  const httpComposition = read('lib/server/http-pwa-lifecycle-application.js');
  assert.match(coreStateBridges, /addAdminCenterNotification:ref\('addAdminCenterNotification'\)/);
  assert.match(coreStateBridges, /noteCenterServiceState:ref\('noteCenterServiceState'\)/);
  assert.match(server, /bootstrapReferences\.bindNotification\(notificationApplication\)/);
  assert.match(config, /const PENDING_DIR = path\.join\(INBOX_DIR, '\.dxpending'\)/);
  assert.match(shareMediaTransfer, /pruneHistory:lazyServiceMethod\(\(\) => transferService, 'transferService', 'pruneHistory'\)/);
  assert.match(config, /const PWA_IMG_EXT = \/\^\(jpg\|png\|gif\|webp\|bmp\|avif\)\$\//);
  assert.match(notificationApplication, /\['pwa-notification', pwaNotificationService\]/);
  assert.match(server, /createFinalHttpApplication\(\{[\s\S]*?rootDir:__dirname/);
  assert.match(finalHttp, /createHttpPwaLifecycleApplication\(\{[\s\S]*?rootDir,/);
  assert.match(httpComposition, /createPwaApplication\(\{[\s\S]*?rootDir,/);
});

test('transactional restore replaces the live root and commits staged secrets and journal', () => {
  const fixture = restoreFixture([true]);
  try {
    const previous = fixture.state;
    assert.equal(fixture.service.applyRestore(backupBundle()), true);
    assert.notStrictEqual(fixture.state, previous);
    assert.equal(fixture.state.shares[0].id, 'restored');
    assert.equal(fixture.state.settings.marker, 'restored');
    assert.equal(fixture.state.audit[0].hash, 'legacy');
    assert.equal(fixture.historyRevision, 8);
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), 'new-journal\n');
    assert.deepEqual(fs.readdirSync(fixture.secrets), []);
  } finally {
    fixture.close();
  }
});

test('failed durable restore commit rolls state, journal and secret bytes back', () => {
  const fixture = restoreFixture([false, true]);
  try {
    const previous = fixture.state;
    assert.throws(() => fixture.service.applyRestore(backupBundle()), /restore-store-write-failed/);
    assert.strictEqual(fixture.state, previous);
    assert.equal(fixture.state.shares[0].id, 'old');
    assert.equal(fixture.historyRevision, 7);
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), 'old-journal\n');
    assert.equal(fs.readFileSync(path.join(fixture.secrets, 'old-secret.dxe'), 'utf8'), 'old-secret');
  } finally {
    fixture.close();
  }
});

test('account-state preflight rejects an unsafe backup before any root or filesystem swap', () => {
  let candidateSeen = null;
  const bundle = backupBundle();
  bundle.store.meta.accounts = [{ id:'backup-owner', username:'backup-owner', role:'owner', ah:'hash' }];
  const fixture = restoreFixture([true], {
    prepareAccountState:(candidate) => {
      candidateSeen = candidate;
      candidate.meta.accounts[0].username = 'mutated-candidate';
      throw new Error('invalid-account-state:owner-missing');
    },
  });
  try {
    const previous = fixture.state;
    assert.throws(
      () => fixture.service.applyRestore(bundle),
      /invalid-account-state:owner-missing/,
    );
    assert.ok(candidateSeen);
    assert.equal(bundle.store.meta.accounts[0].username, 'backup-owner');
    assert.strictEqual(fixture.state, previous);
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), 'old-journal\n');
    assert.equal(fs.readFileSync(path.join(fixture.secrets, 'old-secret.dxe'), 'utf8'), 'old-secret');
  } finally {
    fixture.close();
  }
});

test('failed rollback persistence leaves durable recovery markers and reports a fatal restore error', () => {
  const fixture = restoreFixture([false, false]);
  try {
    assert.throws(
      () => fixture.service.applyRestore(backupBundle()),
      (error) => error && error.code === 'RESTORE_ROLLBACK_FAILED',
    );
    assert.equal(fs.existsSync(path.join(fixture.data, '.restore-transaction.json')), true);
    assert.equal(fs.existsSync(path.join(fixture.data, '.secrets-restore-transaction.json')), true);
  } finally {
    fixture.close();
  }
});

test('restore staging fails closed when durable file synchronization fails', () => {
  const failingFs = Object.create(fs);
  failingFs.fsyncSync = () => { throw Object.assign(new Error('durability unavailable'), { code:'EIO' }); };
  const fixture = restoreFixture([true], { fs:failingFs });
  try {
    const previous = fixture.state;
    assert.throws(() => fixture.service.applyRestore(backupBundle()), /durability unavailable/);
    assert.strictEqual(fixture.state, previous);
    assert.equal(fs.existsSync(path.join(fixture.data, '.restore-transaction.json')), false);
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), 'old-journal\n');
  } finally {
    fixture.close();
  }
});

function writeCoreRestoreMarker(fixture, id, phase = 'prepared') {
  const journalStage = fixture.log + '.restore-stage-123-aaaaaaaaaa';
  const files = {};
  for (const kind of ['journal', 'audit-chain', 'audit-head']) {
    const backup = path.join(fixture.data, `.restore-snapshot-${kind}-${id}`);
    fs.writeFileSync(backup, `old-${kind}\n`);
    files[kind] = { backup, exists:true };
  }
  fs.writeFileSync(journalStage, 'staged-journal\n');
  fs.writeFileSync(path.join(fixture.data, '.restore-transaction.json'), JSON.stringify({
    v:1, id, journalStage, files, phase,
  }));
  return { journalStage, files };
}

test('startup recovery restores journal and audit snapshots when the core commit never became durable', () => {
  const fixture = restoreFixture([true]);
  try {
    const id = '1111222233334444';
    const transaction = writeCoreRestoreMarker(fixture, id);
    fs.writeFileSync(fixture.log, 'new-journal\n');
    fs.writeFileSync(path.join(fixture.data, 'audit-chain.log'), 'new-chain\n');
    fs.writeFileSync(path.join(fixture.data, 'audit-head.json'), 'new-head\n');

    fixture.service.recoverInterruptedCoreRestore();
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), 'old-journal\n');
    assert.equal(fs.readFileSync(path.join(fixture.data, 'audit-chain.log'), 'utf8'), 'old-audit-chain\n');
    assert.equal(fs.readFileSync(path.join(fixture.data, 'audit-head.json'), 'utf8'), 'old-audit-head\n');
    assert.equal(fs.existsSync(transaction.journalStage), false);
    assert.equal(fs.existsSync(path.join(fixture.data, '.restore-transaction.json')), false);
  } finally {
    fixture.close();
  }
});

test('startup recovery preserves committed journal and audit files and only removes core rollback material', () => {
  const fixture = restoreFixture([true]);
  try {
    const id = 'aaaabbbbccccdddd';
    const transaction = writeCoreRestoreMarker(fixture, id);
    fixture.state.meta.restoreCommitId = id;
    fs.writeFileSync(fixture.log, 'new-journal\n');
    fs.writeFileSync(path.join(fixture.data, 'audit-chain.log'), 'new-chain\n');
    fs.writeFileSync(path.join(fixture.data, 'audit-head.json'), 'new-head\n');

    fixture.service.recoverInterruptedCoreRestore();
    assert.equal(fs.readFileSync(fixture.log, 'utf8'), 'new-journal\n');
    assert.equal(fs.readFileSync(path.join(fixture.data, 'audit-chain.log'), 'utf8'), 'new-chain\n');
    assert.equal(fs.readFileSync(path.join(fixture.data, 'audit-head.json'), 'utf8'), 'new-head\n');
    for (const entry of Object.values(transaction.files)) assert.equal(fs.existsSync(entry.backup), false);
    assert.equal(fs.existsSync(path.join(fixture.data, '.restore-transaction.json')), false);
  } finally {
    fixture.close();
  }
});

test('startup recovery rolls back an interrupted uncommitted secret-directory swap', () => {
  const fixture = restoreFixture([true]);
  try {
    const id = '0123456789abcdef';
    const stage = fixture.secrets + '.restore-stage-123-aaaaaaaaaa';
    const old = fixture.secrets + '.restore-old-123-bbbbbbbbbb';
    fs.renameSync(fixture.secrets, old);
    fs.mkdirSync(fixture.secrets, { recursive:true });
    fs.writeFileSync(path.join(fixture.secrets, 'new-secret.dxe'), 'uncommitted');
    fs.mkdirSync(stage, { recursive:true });
    fs.writeFileSync(path.join(fixture.data, '.secrets-restore-transaction.json'), JSON.stringify({
      v:1, id, stage, old, hadOld:true, phase:'swapped',
    }));

    fixture.service.recoverInterruptedSecretRestore();
    assert.equal(fs.readFileSync(path.join(fixture.secrets, 'old-secret.dxe'), 'utf8'), 'old-secret');
    assert.equal(fs.existsSync(path.join(fixture.secrets, 'new-secret.dxe')), false);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.join(fixture.data, '.secrets-restore-transaction.json')), false);
  } finally {
    fixture.close();
  }
});

test('startup recovery keeps committed secret material and removes the rollback directory', () => {
  const fixture = restoreFixture([true]);
  try {
    const id = 'fedcba9876543210';
    const stage = fixture.secrets + '.restore-stage-123-cccccccccc';
    const old = fixture.secrets + '.restore-old-123-dddddddddd';
    fs.renameSync(fixture.secrets, old);
    fs.mkdirSync(fixture.secrets, { recursive:true });
    fs.writeFileSync(path.join(fixture.secrets, 'new-secret.dxe'), 'committed');
    fs.mkdirSync(stage, { recursive:true });
    fixture.state.meta.secretsRestoreCommitId = id;
    fs.writeFileSync(path.join(fixture.data, '.secrets-restore-transaction.json'), JSON.stringify({
      v:1, id, stage, old, hadOld:true, phase:'swapped',
    }));

    fixture.service.recoverInterruptedSecretRestore();
    assert.equal(fs.readFileSync(path.join(fixture.secrets, 'new-secret.dxe'), 'utf8'), 'committed');
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.existsSync(path.join(fixture.data, '.secrets-restore-transaction.json')), false);
  } finally {
    fixture.close();
  }
});

function writeTlsRestoreMarker(fixture, id, committed) {
  const stage = fixture.tls + '.restore-stage-123-eeeeeeeeee';
  const old = fixture.tls + '.restore-old-123-ffffffffff';
  fs.mkdirSync(stage, { recursive:true });
  fs.writeFileSync(path.join(stage, 'stage.pem'), 'stage');
  fs.mkdirSync(old, { recursive:true });
  fs.writeFileSync(path.join(old, 'old.pem'), 'old');
  fs.mkdirSync(fixture.tls, { recursive:true });
  fs.writeFileSync(path.join(fixture.tls, 'new.pem'), 'new');
  if (committed) fixture.state.meta.tlsRestoreCommitId = id;
  fs.writeFileSync(path.join(fixture.data, '.tls-restore-transaction.json'), JSON.stringify({
    v:1, id, stage, old, hadOld:true, phase:'swapped',
  }));
  return { stage, old };
}

test('startup TLS recovery restores old material for an uncommitted directory swap', () => {
  const fixture = restoreFixture([true]);
  try {
    const paths = writeTlsRestoreMarker(fixture, '0123456789abcdef', false);
    fixture.service.recoverInterruptedTlsRestore();
    assert.equal(fs.readFileSync(path.join(fixture.tls, 'old.pem'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(fixture.tls, 'new.pem')), false);
    assert.equal(fs.existsSync(paths.old), false);
    assert.equal(fs.existsSync(paths.stage), false);
    assert.equal(fs.existsSync(path.join(fixture.data, '.tls-restore-transaction.json')), false);
  } finally {
    fixture.close();
  }
});

test('startup TLS recovery keeps new material after the store commit point', () => {
  const fixture = restoreFixture([true]);
  try {
    const paths = writeTlsRestoreMarker(fixture, 'fedcba9876543210', true);
    fixture.service.recoverInterruptedTlsRestore();
    assert.equal(fs.readFileSync(path.join(fixture.tls, 'new.pem'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(fixture.tls, 'old.pem')), false);
    assert.equal(fs.existsSync(paths.old), false);
    assert.equal(fs.existsSync(paths.stage), false);
    assert.equal(fs.existsSync(path.join(fixture.data, '.tls-restore-transaction.json')), false);
  } finally {
    fixture.close();
  }
});

test('restore busy state includes asynchronous maintenance and runtime reset attempts every boundary', () => {
  const calls = [];
  const fixture = restoreFixture([true], {
    isMaintenanceStateReplacementBusy:() => true,
    isConnectorJobStateReplacementBusy:() => true,
    clearAllSessions:() => { calls.push('sessions'); throw new Error('session reset failed'); },
    clearTransferRuntimeState:() => calls.push('transfers'),
    clearDownloadRuntimeState:() => calls.push('downloads'),
    clearMediaRuntimeState:() => calls.push('media'),
    clearUploadRuntimeAfterRestore:() => calls.push('uploads'),
    clearMaintenanceRuntimeState:() => calls.push('maintenance'),
    clearConnectorJobRuntimeState:() => calls.push('connector-jobs'),
    clearAccountBootstrapRuntime:() => calls.push('account-bootstrap'),
    resetSearchAfterRestore:() => calls.push('search'),
  });
  try {
    assert.equal(fixture.service.restoreIsBusy(), true);
    assert.throws(
      () => fixture.service.clearRuntimeAfterRestore(),
      (error) => error && error.code === 'RESTORE_RUNTIME_RESET_FAILED' && /security/.test(error.message),
    );
    assert.deepEqual(calls, ['sessions', 'transfers', 'downloads', 'media', 'uploads', 'maintenance', 'connector-jobs', 'account-bootstrap', 'search']);
  } finally {
    fixture.close();
  }
});

test('restore readiness failures fail closed instead of escaping the streamed request boundary', () => {
  const logs = [];
  const expected = Object.assign(new Error('late coordinator dependency unavailable'), {
    code:'STATE_REPLACEMENT_BUSY_CHECK_FAILED',
    step:'late-service',
  });
  const fixture = restoreFixture([true], {
    stateReplacementCoordinator:{
      isBusyForStateReplacement:() => { throw expected; },
      clearRuntimeAfterRestore:() => {},
    },
    logger:{ error:(...args) => logs.push(args), warn:() => {} },
  });
  try {
    assert.equal(fixture.service.restoreIsBusy(), true);
    assert.equal(logs.length, 1);
    assert.match(String(logs[0][0]), /readiness check failed/);
    assert.match(String(logs[0][1]), /late coordinator dependency unavailable/);
  } finally {
    fixture.close();
  }
});

test('restore refuses state replacement while notification delivery can still mutate persisted state', () => {
  let notificationBusy = false;
  const fixture = restoreFixture([true], {
    isNotificationStateReplacementBusy:() => notificationBusy,
  });
  try {
    assert.equal(fixture.service.restoreIsBusy(), false);
    notificationBusy = true;
    assert.equal(fixture.service.restoreIsBusy(), true);
  } finally {
    fixture.close();
  }
});

test('restore refuses state replacement while the security/auth boundary has asynchronous work in flight', () => {
  let securityBusy = false;
  const fixture = restoreFixture([true], {
    isSecurityStateReplacementBusy:() => securityBusy,
  });
  try {
    assert.equal(fixture.service.restoreIsBusy(), false);
    securityBusy = true;
    assert.equal(fixture.service.restoreIsBusy(), true);
  } finally {
    fixture.close();
  }
});

function maintenanceFixture(timerOverrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-maintenance-service-'));
  const inbox = path.join(tmp, 'inbox');
  const secrets = path.join(tmp, 'secrets');
  const log = path.join(tmp, 'transfers.log');
  fs.mkdirSync(inbox, { recursive:true });
  fs.mkdirSync(secrets, { recursive:true });
  fs.writeFileSync(log, '');
  let state = { meta:{} };
  const settings = {
    logRetentionDays:0, inboxRetentionDays:0, trashRetentionDays:0,
    ransomwareProtection:true, ransomwareBlockMinutes:30, ransomwareSuspendLink:true,
  };
  const center = [];
  const noOp = () => {};
  const service = createMaintenanceService({
    fs, path, crypto, APP_NAME:'Direct-Xfer', DAY_MS:86400000,
    INBOX_DIR:inbox, LOG_FILE:log, SECRETS_DIR:secrets,
    FAIL_WINDOW_MS:60000, GEO_TTL:60000,
    getState:() => state, getSettings:() => settings,
    persist:noOp, persistNow:() => true, scheduleFlush:noOp,
    sessionCleanup:noOp, authCleanup:noOp, unlockFails:new Map(), geoCache:new Map(),
    pruneCenterTrackers:noOp, runExpiredLinkLifecycle:() => Promise.resolve(),
    maybeCleanupOrphanPendingFiles:noOp, trashItems:() => [],
    purgeTrashRecordById:() => Promise.resolve(), checkCenterLinkStates:noOp,
    checkExpiringShares:noOp, maybeSendDigest:noOp, maybeRunScheduledBackup:noOp,
    releaseReceptionManagedBytes:() => null, addShareCenterNotification:noOp,
    noteCenterCleanup:noOp, scheduleSearchReindex:noOp,
    notificationAccountIdForShare:() => 'account-1',
    receptionMetadataPath:(file) => file,
    safeManagedInboxFilePath:(file) => {
      const resolved = path.resolve(String(file || ''));
      return resolved.startsWith(path.resolve(inbox) + path.sep) ? resolved : null;
    },
    addCenterNotification:(...args) => center.push(args),
    clientIp:(request) => request.ip, isLoopback:(ip) => ip === '127.0.0.1',
    getById:(id) => id === 'share-1' ? { id, name:'Inbox' } : null,
    acceptsUpload:(share) => !!share, logAudit:noOp, dispatch:noOp,
    logger:{ error:noOp, warn:noOp },
    ...timerOverrides,
  });
  return {
    tmp, inbox, secrets, service, settings, center,
    get state() { return state; },
    replaceState(next) { state = next; },
    close() { service.stop(); fs.rmSync(tmp, { recursive:true, force:true }); },
  };
}

test('maintenance expiry follows the replaced state root and cannot delete outside inbox', () => {
  const fixture = maintenanceFixture();
  try {
    const expiredSecret = 'expired-token';
    fs.writeFileSync(path.join(fixture.secrets, expiredSecret + '.dxe'), 'ciphertext');
    fixture.replaceState({ meta:{ secrets:{ [expiredSecret]:{ expiresAt:Date.now() - 1 } } } });
    fixture.service.purgeExpiredSecrets();
    assert.equal(fs.existsSync(path.join(fixture.secrets, expiredSecret + '.dxe')), false);
    assert.deepEqual(fixture.state.meta.secrets, {});

    const upload = path.join(fixture.inbox, 'self-destruct.bin');
    fs.writeFileSync(upload, 'payload');
    fixture.service.recordFileExpiry(upload, 1, { id:'share-1' }, 'self-destruct.bin');
    fixture.state.meta.fileExpiry[upload].expiresAt = Date.now() - 1;
    fixture.service.purgeExpiredFiles();
    assert.equal(fs.existsSync(upload), false);
    assert.equal(fixture.center.length, 1);

    const outside = path.join(fixture.tmp, 'outside.bin');
    fs.writeFileSync(outside, 'keep');
    fixture.state.meta.fileExpiry[outside] = { expiresAt:Date.now() - 1 };
    fixture.service.purgeExpiredFiles();
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.equal(Object.hasOwn(fixture.state.meta.fileExpiry, outside), false);

    const oldMap = fixture.service.fileExpiryMap();
    fixture.replaceState({ meta:{} });
    assert.notStrictEqual(fixture.service.fileExpiryMap(), oldMap);

    fixture.replaceState({ meta:{ fileExpiry:[] } });
    assert.equal(Array.isArray(fixture.service.fileExpiryMap()), false);
  } finally {
    fixture.close();
  }
});

test('maintenance ignores an expiry path rejected by reception metadata normalization', () => {
  const fixture = maintenanceFixture({ receptionMetadataPath:() => null });
  try {
    fixture.service.recordFileExpiry(path.join(fixture.tmp, 'outside.bin'), 30, null, 'outside.bin');
    assert.deepEqual(fixture.state.meta.fileExpiry, {});
  } finally {
    fixture.close();
  }
});

test('corrupt expiry metadata is non-destructive and invalid secret tokens cannot escape the managed directory', () => {
  const fixture = maintenanceFixture();
  try {
    const secret = path.join(fixture.secrets, 'valid-token.dxe');
    fs.writeFileSync(secret, 'keep-secret');
    const outsideSecret = path.join(fixture.tmp, 'outside.dxe');
    fs.writeFileSync(outsideSecret, 'keep-outside');
    fixture.replaceState({
      meta:{
        secrets:{
          'valid-token':{ expiresAt:'not-a-time' },
          '../outside':{ expiresAt:Date.now() - 1 },
        },
      },
    });
    fixture.service.purgeExpiredSecrets();
    assert.equal(fs.readFileSync(secret, 'utf8'), 'keep-secret');
    assert.equal(fixture.state.meta.secrets['valid-token'].expiresAt, null);
    assert.equal(Object.hasOwn(fixture.state.meta.secrets, '../outside'), false);
    assert.equal(fs.readFileSync(outsideSecret, 'utf8'), 'keep-outside');

    const upload = path.join(fixture.inbox, 'keep-upload.bin');
    fs.writeFileSync(upload, 'keep-upload');
    fixture.state.meta.fileExpiry = { [upload]:{ expiresAt:'invalid' } };
    fixture.service.purgeExpiredFiles();
    assert.equal(fs.readFileSync(upload, 'utf8'), 'keep-upload');
    assert.deepEqual(fixture.state.meta.fileExpiry, {});

    fixture.replaceState({ meta:{ secrets:'corrupt', fileExpiry:['corrupt'] } });
    fixture.service.purgeExpiredSecrets();
    fixture.service.purgeExpiredFiles();
    assert.deepEqual(fixture.state.meta.secrets, {});
    assert.deepEqual(fixture.state.meta.fileExpiry, {});
  } finally {
    fixture.close();
  }
});

test('file-expiry state remains bounded and keeps the soonest self-destruct timers', () => {
  const fixture = maintenanceFixture();
  try {
    const farFuture = Date.now() + 90 * 86400000;
    const map = {};
    for (let i = 0; i < 20000; i += 1) {
      map[path.join(fixture.inbox, `future-${i}.bin`)] = { expiresAt:farFuture };
    }
    fixture.replaceState({ meta:{ fileExpiry:map } });
    const priority = path.join(fixture.inbox, 'priority.bin');
    fixture.service.recordFileExpiry(priority, 1, null, 'priority.bin');
    assert.equal(Object.keys(fixture.state.meta.fileExpiry).length, 20000);
    assert.equal(Object.hasOwn(fixture.state.meta.fileExpiry, priority), true);
  } finally {
    fixture.close();
  }
});

test('expired-file metadata is finalized even when notification delivery throws', () => {
  const fixture = maintenanceFixture({
    addCenterNotification:() => { throw new Error('notification unavailable'); },
  });
  try {
    const upload = path.join(fixture.inbox, 'expired.bin');
    fs.writeFileSync(upload, 'expired');
    fixture.replaceState({
      meta:{ fileExpiry:{
        [upload]:{ expiresAt:Date.now() - 1, accountId:'account-1', name:'expired.bin' },
      } },
    });
    fixture.service.purgeExpiredFiles();
    assert.equal(fs.existsSync(upload), false);
    assert.deepEqual(fixture.state.meta.fileExpiry, {});
  } finally {
    fixture.close();
  }
});

test('trash retention purges sequentially and exposes its state-replacement barrier', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  let persisted = 0;
  const old = Date.now() - 3 * 86400000;
  const fixture = maintenanceFixture({
    trashItems:() => [{ id:'trash-1', deletedAt:old }, { id:'trash-2', deletedAt:old }],
    purgeTrashRecordById:async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(id);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { id };
    },
    persist:() => { persisted += 1; },
  });
  try {
    fixture.settings.trashRetentionDays = 1;
    const job = fixture.service.runMinuteHousekeeping();
    assert.equal(fixture.service.isStateReplacementBusy(), true);
    assert.deepEqual(await job, { purged:2, aborted:false });
    assert.equal(fixture.service.isStateReplacementBusy(), false);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ['trash-1', 'trash-2']);
    assert.equal(persisted, 2);
  } finally {
    fixture.close();
  }
});

test('ransomware blocks normalize mapped IPv4 and maintenance timers start once', () => {
  let intervals = 0;
  let timeouts = 0;
  let clearedIntervals = 0;
  let clearedTimeouts = 0;
  const timer = () => ({ unref() {} });
  const fixture = maintenanceFixture({
    setIntervalFn:() => { intervals += 1; return timer(); },
    setTimeoutFn:() => { timeouts += 1; return timer(); },
    clearIntervalFn:() => { clearedIntervals += 1; },
    clearTimeoutFn:() => { clearedTimeouts += 1; },
  });
  try {
    const record = fixture.service.blockRansomwareClient(
      { ip:'::ffff:203.0.113.9' }, 'mass-delete', '25 files', ['share-1'],
    );
    assert.equal(record.ip, '203.0.113.9');
    assert.equal(fixture.service.ransomwareBlocked('::ffff:203.0.113.9').reason, 'mass-delete');
    assert.equal(fixture.service.ransomwareShareBlocked('share-1').sourceIp, '203.0.113.9');
    fixture.settings.ransomwareBlockMinutes = Infinity;
    const bounded = fixture.service.blockRansomwareClient(
      { ip:'203.0.113.10' }, 'mass-delete', 'bounded duration', [],
    );
    assert.ok(bounded.until - bounded.at <= 30 * 60000);
    fixture.service.clearRuntimeAfterRestore();
    assert.equal(fixture.service.anomalyWindows.size, 0);
    assert.equal(fixture.service.anomalyRecent.length, 0);
    assert.equal(fixture.service.start(), true);
    assert.equal(fixture.service.start(), false);
    assert.equal(intervals, 2);
    assert.equal(timeouts, 1);
    fixture.service.stop();
    assert.equal(clearedIntervals, 2);
    assert.equal(clearedTimeouts, 1);
  } finally {
    fixture.close();
  }
});

test('ransomware protection survives notification/audit failures and sanitizes restored block durations', () => {
  const fixture = maintenanceFixture({
    addShareCenterNotification:() => { throw new Error('notification unavailable'); },
    logAudit:() => { throw new Error('audit unavailable'); },
    persistNow:() => { throw new Error('store unavailable'); },
  });
  try {
    const record = fixture.service.blockRansomwareClient(
      { ip:'203.0.113.20' }, 'mass-delete', '25 files', ['share-1'],
    );
    assert.equal(record.reason, 'mass-delete');
    assert.equal(fixture.service.ransomwareBlocked('203.0.113.20').reason, 'mass-delete');
    assert.equal(fixture.service.ransomwareShareBlocked('share-1').reason, 'mass-delete');

    fixture.replaceState({ meta:{ ransomwareBlocks:{
      invalid:{ until:Infinity },
      bounded:{ until:Date.now() + 365 * 86400000 },
    } } });
    assert.equal(fixture.service.ransomwareBlocked('invalid'), null);
    const bounded = fixture.service.ransomwareBlocked('bounded');
    assert.ok(bounded.until <= Date.now() + 24 * 60 * 60 * 1000);
  } finally {
    fixture.close();
  }
});

function restoreRouteFixture() {
  const routes = new Map();
  const adminRouter = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
  };
  let state = { shares:[] };
  const audits = [];
  let restores = 0;
  attachAdminDiagnosticsRoutes({
    adminRouter,
    getState:() => state,
    rootDir:ROOT,
    systemHealthService:{
      buildGlobalStorageReport:() => ({}),
      diskFreeThresholds:() => ({}),
    },
    diagnosticsService:{
      diagnosticTcp:() => ({ ok:true }),
      diagnosticWritable:() => ({ ok:true }),
      safeDiagnosticFixFor:() => null,
      tlsCertificateDiagnostics:() => ({ status:'ok' }),
    },
    fs,
    path,
    requireOwner:() => {},
    restoreIsBusy:() => false,
    parseBackup:(raw) => JSON.parse(raw),
    applyRestore:(bundle) => { restores += 1; state = bundle.store; return true; },
    auditReq:(_req, action, detail) => audits.push({ action, detail }),
    clearRuntimeAfterRestore:() => {},
    destroySession:() => {},
    clearPwaDeviceCookie:() => {},
    shutdown:() => {},
  });
  return {
    handler:routes.get('POST /restore'),
    audits,
    get restores() { return restores; },
  };
}

function fakeResponse() {
  return {
    statusCode:200,
    headersSent:false,
    body:null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    setHeader() {},
  };
}

test('restore route serializes streamed requests and tolerates an invalid backup timestamp', () => {
  const fixture = restoreRouteFixture();
  const first = new EventEmitter();
  first.session = { username:'owner' };
  const firstResponse = fakeResponse();
  fixture.handler(first, firstResponse);

  const concurrent = new EventEmitter();
  concurrent.session = { username:'owner' };
  const concurrentResponse = fakeResponse();
  fixture.handler(concurrent, concurrentResponse);
  assert.equal(concurrentResponse.statusCode, 409);
  assert.deepEqual(concurrentResponse.body, { error:'transfers-active' });

  first.emit('data', Buffer.from(JSON.stringify({
    kind:'dxbackup', createdAt:'not-a-date', store:{ shares:[{ id:'restored' }] }, journal:'',
  })));
  assert.doesNotThrow(() => first.emit('end'));
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstResponse.body.createdAt, null);
  assert.equal(fixture.restores, 1);
  assert.match(fixture.audits[0].detail, /unknown time/);

  const after = new EventEmitter();
  after.session = { username:'owner' };
  const afterResponse = fakeResponse();
  fixture.handler(after, afterResponse);
  after.emit('data', Buffer.from(JSON.stringify({ store:{ shares:[] }, journal:'' })));
  after.emit('end');
  assert.equal(afterResponse.statusCode, 200);
  assert.equal(fixture.restores, 2);
});
