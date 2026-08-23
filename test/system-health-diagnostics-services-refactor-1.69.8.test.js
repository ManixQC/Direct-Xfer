'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDiagnosticsService } = require('../lib/server/diagnostics-service');
const { createSystemHealthService } = require('../lib/server/system-health-service');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

function diagnosticsFixture() {
  const tlsManager = {
    ACTIVE_TLS_MODE:'http',
    tlsCertificateRestartRequired:false,
    activeTlsLeafPem:null,
  };
  return createDiagnosticsService({
    tlsManager,
    localCaModeActive:() => false,
    readManagedTlsFile:() => null,
    localCaPaths:() => ({}),
    localCaStatus:() => ({}),
    validateProvidedTlsPair:() => ({}),
    certificateFingerprint256:() => '',
    tlsMaterialFingerprint:() => '',
  });
}

function systemFixture(root, overrides = {}) {
  const directory = (name) => {
    const value = path.join(root, name);
    fs.mkdirSync(value, { recursive:true });
    return value;
  };
  const DATA_DIR = directory('data');
  const INBOX_DIR = directory('inbox');
  const IMAGE_STORE_DIR = directory('images');
  const paths = {
    DATA_DIR,
    INBOX_DIR,
    IMAGE_STORE_DIR,
    FULL_IMAGES_DIR:directory('images/Full'),
    THUMBS_DIR:directory('images/Mini'),
    MICROS_DIR:directory('images/Micro'),
    PHOTO_HISTORY_DIR:directory('images/History'),
    PHOTO_VERSIONS_DIR:directory('images/Versions'),
    ADAPTIVE_IMAGES_DIR:directory('images/Adaptive'),
    ENC_DIR:directory('data/encrypted'),
    SECRETS_DIR:directory('data/secrets'),
    QUARANTINE_DIR:directory('data/quarantine'),
    SEARCH_INDEX_FILE:path.join(DATA_DIR, 'search-index.json'),
    SEARCH_OCR_CACHE_FILE:path.join(DATA_DIR, 'search-ocr-cache.json'),
    LOG_FILE:path.join(DATA_DIR, 'transfers.log'),
    AUDIT_CHAIN_FILE:path.join(DATA_DIR, 'audit-chain.log'),
    STORE_FILE:path.join(DATA_DIR, 'store.json'),
    AUDIT_HEAD_FILE:path.join(DATA_DIR, 'audit-head.json'),
    AUDIT_KEY_FILE:path.join(DATA_DIR, 'audit.key'),
  };
  let state = { meta:{ lastBackup:{ id:'first' } } };
  const shares = [
    { id:'active', active:true },
    { id:'checking', active:false, backing:'checking' },
  ];
  const jobs = [
    { status:'running', createdAt:Date.now() },
    { status:'failed', finishedAt:Date.now() },
  ];
  let backingRefreshes = 0;
  const diagnosticsService = diagnosticsFixture();
  const tlsManager = { ACTIVE_TLS_MODE:'http' };
  const connectorJobService = overrides.connectorJobService || {
    maxActive:4,
    probeSnapshot:async() => ({ capabilities:{ available:true, version:'test' }, remotes:[] }),
    pruneJobs:() => jobs,
  };
  const service = createSystemHealthService({
    ...paths,
    STORAGE_SETUP:{ inboxUnconfigured:false, imagesUnconfigured:false },
    DATA_KEY:'',
    CLAMAV_HOST:'',
    CLAMAV_PORT:3310,
    SEARCH_OCR_ENABLED:false,
    SEARCH_OCR_LANGS:'eng',
    PUBLIC_URL:'',
    TRUST_PROXY:false,
    PORT:55750,
    ADMIN_ALLOWED_IPS:[],
    deepCacheMs:0,
    getState:() => state,
    getSettings:() => ({ backupEnabled:false, dlpEnabled:true, ransomwareProtection:true }),
    getServerScheme:() => 'http',
    getWebpush:() => null,
    diagnosticsService,
    connectorJobService,
    verifyAuditChain:() => ({ ok:true, entries:1, headSeq:1, headHash:'hash', checkedAt:Date.now() }),
    auditService:{ getIntegrityStatus:() => ({ checkedAt:0 }) },
    universalSearchStatus:() => ({ ready:true, indexed:0 }),
    detectSearchOcrTools:async() => ({ tesseract:false, pdftoppm:false, missingLanguages:[] }),
    diskFreeThresholds:() => ({ warn:10, critical:5 }),
    isBackupInFlight:() => false,
    clamavEnabled:() => false,
    tlsManager,
    connectorStore:() => [],
    pushSubs:() => [],
    emailConfigured:() => false,
    effectiveWebhook:() => ({ url:'' }),
    getLastEmail:() => null,
    getLastWebhook:() => null,
    getLocalIPv4s:() => ['127.0.0.1'],
    listShares:() => shares,
    isScheduled:(share) => !!share.scheduled,
    isActive:(share) => !!share.active,
    shareEffectiveExpiry:(share) => share.expiresAt || 0,
    shareBackingHealthSnapshot:(share) => ({ status:share.backing || 'ok' }),
    queueShareBackingHealthRefresh:() => { backingRefreshes += 1; },
    ...overrides,
  });
  return {
    service,
    paths,
    replaceState(next) { state = next; },
    get backingRefreshes() { return backingRefreshes; },
  };
}

test('composition root delegates storage, health and diagnostics to domain services', () => {
  const server = read('server.js');
  assert.match(server, /createDiagnosticsService\(\{/);
  assert.match(server, /createSystemHealthService\(\{/);
  for (const name of [
    'buildGlobalStorageReport',
    'scanReceptionStorage',
    'serverHealthDeepSnapshot',
    'serverHealthVolume',
    'diagnosticWritable',
    'diagnosticTcp',
    'tlsCertificateDiagnostics',
    'safeDiagnosticFixFor',
  ]) {
    assert.doesNotMatch(server, new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`), name);
  }
  assert.doesNotMatch(server, /\bFILE_CATEGORY_EXTS\b/);
  assert.match(server, /attachAdminDashboardRoutes\(applicationContext\.route\('adminDashboard'/);
  assert.match(server, /attachAdminDiagnosticsRoutes\(applicationContext\.route\('adminDiagnostics'/);
  assert.match(server, /applicationContext\.register\('late-service-refs', \{ auditService, diagnosticsService, systemHealthService \}\)/);
  const { ROUTE_DEPENDENCIES } = require('../lib/server/application-context');
  assert.ok(ROUTE_DEPENDENCIES.adminDashboard.includes('systemHealthService'));
  assert.ok(ROUTE_DEPENDENCIES.adminDiagnostics.includes('diagnosticsService'));
  assert.ok(ROUTE_DEPENDENCIES.adminDiagnostics.includes('systemHealthService'));

  const dashboard = read('lib/server/admin-dashboard-routes.js');
  const diagnostics = read('lib/server/admin-diagnostics-routes.js');
  assert.match(dashboard, /\bsystemHealthService,/);
  assert.match(dashboard, /serverHealthReceptionVolume/);
  assert.doesNotMatch(dashboard, /statfsSync/);
  assert.match(diagnostics, /\bdiagnosticsService,/);
  assert.match(diagnostics, /\bsystemHealthService,/);
});

test('diagnostics are fail-closed and invalid probes resolve instead of rejecting', async () => {
  assert.throws(() => createDiagnosticsService({}), /requires tlsManager/);
  const service = diagnosticsFixture();
  const source = read('lib/server/diagnostics-service.js');
  assert.match(source, /flag:'wx'/);
  assert.match(source, /withTimeout\(fs\.promises\.mkdir/);
  assert.doesNotMatch(source, /error:String\(error && error\.message/);
  assert.doesNotMatch(source, /error\.message/);
  assert.ok(Object.isFrozen(service));
  assert.deepEqual(service.tlsCertificateDiagnostics(), {
    mode:'http',
    active:false,
    minProtocol:'TLSv1.2',
    restartRequired:false,
    status:'info',
    reason:'http-only',
    fixable:false,
  });
  assert.deepEqual(await service.diagnosticWritable(null), { ok:false, error:'not-configured' });
  assert.deepEqual(await service.diagnosticTcp('', 443, 10), { ok:false, error:'invalid-host' });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-diagnostic-write-'));
  try {
    assert.deepEqual(await service.diagnosticWritable(target), { ok:true });
    assert.equal(fs.readdirSync(target).some((name) => name.startsWith('.dx-diagnostic-')), false);
  } finally {
    fs.rmSync(target, { recursive:true, force:true });
  }
  const invalidTcp = await service.diagnosticTcp('127.0.0.1', -1, 10);
  assert.deepEqual(invalidTcp, { ok:false, error:'invalid-port' });
  assert.deepEqual(service.safeDiagnosticFixFor({ id:'search-index', status:'bad' }), { action:'search-reindex' });
});

test('storage scans stay inside managed trees and preserve accounting semantics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-system-health-storage-'));
  try {
    const fixture = systemFixture(root);
    fs.writeFileSync(path.join(fixture.paths.INBOX_DIR, 'photo.jpg'), Buffer.alloc(3));
    const partial = path.join(fixture.paths.INBOX_DIR, 'old.partial');
    fs.writeFileSync(partial, Buffer.alloc(4));
    const old = new Date(Date.now() - 2 * 86400000);
    fs.utimesSync(partial, old, old);
    fs.writeFileSync(path.join(fixture.paths.FULL_IMAGES_DIR, 'full.png'), Buffer.alloc(5));
    const outside = path.join(root, 'outside.bin');
    fs.writeFileSync(outside, Buffer.alloc(100));
    try { fs.symlinkSync(outside, path.join(fixture.paths.INBOX_DIR, 'outside-link.bin')); } catch (_) {}
    const outsideDirectory = path.join(root, 'outside-directory');
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, 'hidden.mp4'), Buffer.alloc(200));
    try { fs.symlinkSync(outsideDirectory, path.join(fixture.paths.INBOX_DIR, 'outside-directory-link'), 'dir'); } catch (_) {}

    const reception = await fixture.service.scanReceptionStorage();
    assert.equal(reception.files, 2);
    assert.equal(reception.managedBytes, 7);
    assert.equal(reception.partialFiles, 1);
    assert.equal(reception.stalePartialBytes, 4);
    assert.equal(reception.largestFiles.some((file) => file.name === 'outside-link.bin'), false);
    assert.equal(reception.largestFiles.some((file) => file.name.includes('hidden.mp4')), false);

    const report = await fixture.service.buildGlobalStorageReport();
    assert.equal(report.managedBytes, 12);
    assert.equal(report.managedFiles, 3);
    assert.equal(report.reclaimableBytes, 4);
    assert.equal(report.fileCategories.find((row) => row.category === 'image').bytes, 8);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('storage scans are single-flight and avoid synchronous filesystem probes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-system-health-single-flight-'));
  const originalReaddir = fs.promises.readdir;
  const originalStatfs = fs.promises.statfs;
  try {
    const fixture = systemFixture(root, { scanCacheMs:0 });
    fs.writeFileSync(path.join(fixture.paths.INBOX_DIR, 'one.txt'), 'one');
    let receptionReads = 0;
    let statfsCalls = 0;
    fs.promises.readdir = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(fixture.paths.INBOX_DIR)) {
        receptionReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return originalReaddir(...args);
    };
    if (typeof originalStatfs === 'function') {
      fs.promises.statfs = async (...args) => {
        statfsCalls += 1;
        return originalStatfs(...args);
      };
    }

    const [firstReception, secondReception] = await Promise.all([
      fixture.service.scanReceptionStorage(),
      fixture.service.scanReceptionStorage(),
    ]);
    assert.strictEqual(firstReception, secondReception);
    assert.equal(receptionReads, 1);

    const [firstReport, secondReport] = await Promise.all([
      fixture.service.buildGlobalStorageReport(),
      fixture.service.buildGlobalStorageReport(),
    ]);
    assert.strictEqual(firstReport, secondReport);
    if (typeof originalStatfs === 'function') assert.equal(statfsCalls, 1);

    const source = read('lib/server/system-health-service.js');
    assert.doesNotMatch(source, /\b(?:stat|lstat|statfs)Sync\b/);
    assert.match(source, /globalStorageReportPending/);
    assert.match(source, /receptionStorageScanPending/);
  } finally {
    fs.promises.readdir = originalReaddir;
    if (typeof originalStatfs === 'function') fs.promises.statfs = originalStatfs;
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('deep health snapshots and summaries follow the replaced live state root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-system-health-live-'));
  try {
    const fixture = systemFixture(root);
    const first = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(first.backup.last.id, 'first');
    fixture.replaceState({ meta:{ lastBackup:{ id:'restored' } } });
    const restored = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(restored.backup.last.id, 'restored');
    assert.equal(restored.tls.active, false);
    assert.equal(restored.connectors.jobs.running, 1);
    assert.equal(restored.connectors.jobs.failedRecent24h, 1);

    const shares = fixture.service.serverHealthShareSummary();
    assert.equal(shares.total, 2);
    assert.equal(shares.active, 1);
    assert.equal(shares.backingChecking, 1);
    assert.equal(fixture.backingRefreshes, 1);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('runtime reset invalidates cached pre-restore state and stale in-flight generations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-system-health-reset-'));
  try {
    const fixture = systemFixture(root, { deepCacheMs:60000 });
    const first = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(first.backup.last.id, 'first');
    fixture.replaceState({ meta:{ lastBackup:{ id:'restored' } } });
    const cached = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(cached.backup.last.id, 'first');
    fixture.service.clearRuntimeState();
    const refreshed = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(refreshed.backup.last.id, 'restored');
    assert.match(read('server.js'), /clearSystemHealthRuntimeState: \(\) => systemHealthService\.clearRuntimeState\(\)/);
    assert.match(read('lib/server/restore-service.js'), /reset\('system-health', clearSystemHealthRuntimeState\)/);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('health snapshot degrades isolated collaborator failures instead of rejecting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-system-health-degraded-'));
  try {
    const fixture = systemFixture(root, {
      getSettings:() => null,
      connectorJobService:{
        maxActive:4,
        probeSnapshot:() => { throw new Error('private connector detail'); },
        pruneJobs:() => null,
      },
      verifyAuditChain:() => { throw new Error('private audit detail'); },
      universalSearchStatus:() => null,
      connectorStore:() => null,
      pushSubs:() => null,
      effectiveWebhook:() => null,
      getLocalIPv4s:() => null,
      listShares:() => [{}],
      isScheduled:() => { throw new Error('private share detail'); },
    });
    const snapshot = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(snapshot.connectors.capabilities.available, false);
    assert.equal(snapshot.connectors.capabilities.error, 'unavailable');
    assert.equal(snapshot.connectors.configured, 0);
    assert.equal(snapshot.notifications.subscriptions, 0);
    assert.equal(snapshot.notifications.webhookConfigured, false);
    assert.deepEqual(snapshot.config.localIps, []);
    assert.equal(snapshot.security.audit.ok, false);
    assert.equal(snapshot.security.audit.reason, 'verification-failed');
    assert.equal(fixture.service.serverHealthShareSummary().total, 1);
    assert.equal(fixture.service.serverHealthShareSummary().inactive, 1);
    assert.equal(fixture.service.serverHealthJobSummary().total, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /private connector detail|private audit detail/);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('deep health bounds hanging connector probes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-system-health-hanging-'));
  try {
    const fixture = systemFixture(root, {
      fsTimeoutMs:100,
      connectorJobService:{
        maxActive:4,
        probeSnapshot:() => new Promise(() => {}),
        pruneJobs:() => [],
      },
    });
    const startedAt = Date.now();
    const snapshot = await fixture.service.serverHealthDeepSnapshot();
    assert.equal(snapshot.connectors.capabilities.available, false);
    assert.equal(snapshot.connectors.capabilities.error, 'unavailable');
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
