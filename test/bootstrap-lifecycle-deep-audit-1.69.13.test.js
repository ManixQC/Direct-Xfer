'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createServerConfig } = require('../lib/server/config');
const { createRuntimeBootstrap } = require('../lib/server/bootstrap');
const { createLifecycleService } = require('../lib/server/lifecycle-service');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('server.js is a composition root for extracted config, bootstrap and lifecycle services', () => {
  const server = read('server.js');
  assert.match(server, /const serverConfig = createServerConfig\(\{ rootDir:__dirname \}\);/);
  assert.match(server, /const runtimeBootstrap = createRuntimeBootstrap\(\{ config:serverConfig \}\);/);
  assert.match(server, /lifecycleService = createLifecycleService\(\{/);
  assert.match(server, /lifecycleService\.start\(\);/);
  assert.doesNotMatch(server, /^const PORT =/m);
  assert.doesNotMatch(server, /function ensureWindowsPortableFirewallAccess\(/);
  assert.doesNotMatch(server, /function printStartupBanner\(/);
  assert.doesNotMatch(server, /process\.on\('SIG(?:INT|TERM)'/);
  assert.doesNotMatch(server, /https\.createServer\(/);
  assert.ok(server.split('\n').length < 4700, 'server.js should remain a compact composition root');
});

test('config parses environment and derives paths without creating runtime directories', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-config-test-'));
  try {
    const dataDir = path.join(temp, 'data');
    const inboxDir = path.join(temp, 'inbox');
    const env = {
      PORT:'55888', BIND:'127.0.0.1', DATA_DIR:dataDir, INBOX_DIR:inboxDir,
      ADMIN_ALLOWED_IPS:'10.0.0.0/8,192.168.1.5', UPDATE_CHECK:'false',
      PUBLIC_IP_DISCOVERY:'false', RCLONE_BIN:'custom-rclone', PUID:'99', PGID:'100', NO_COLOR:'1',
      UPDATE_IMAGE:'registry.example:5000/team/direct-xfer',
    };
    const config = createServerConfig({
      rootDir:temp,
      packageJson:{ version:'9.8.7' },
      env,
    });
    env.RCLONE_BIN = 'mutated-after-parse';
    env.PUID = '1000';
    assert.equal(config.APP_VERSION, '9.8.7');
    assert.equal(config.PORT, 55888);
    assert.equal(config.BIND, '127.0.0.1');
    assert.equal(config.PENDING_DIR, path.join(inboxDir, '.dxpending'));
    assert.equal(config.UPDATE_CHECK, false);
    assert.equal(config.PUBLIC_IP_DISCOVERY, false);
    assert.equal(config.ADMIN_ALLOWED_IPS.length, 2);
    assert.equal(config.RCLONE_BIN, 'custom-rclone');
    assert.equal(config.PUID, '99');
    assert.equal(config.PGID, '100');
    assert.equal(config.UPDATE_REPO, 'registry.example:5000/team/direct-xfer');
    assert.equal(config.UPDATE_TAG, 'latest');
    assert.equal(Object.isFrozen(config.ADMIN_ALLOWED_IPS), true);
    assert.equal(Object.isFrozen(config.ADMIN_ALLOWED_IPS[0]), true);
    assert.throws(() => config.ADMIN_ALLOWED_IPS.push({ base:0, mask:0 }), TypeError);
    assert.equal(config.red('plain'), 'plain');
    assert.equal(fs.existsSync(dataDir), false);
    assert.equal(fs.existsSync(inboxDir), false);
    assert.equal(Object.isFrozen(config), true);
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});

test('bootstrap contains synchronous rclone cleanup and Windows firewall failures', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-bootstrap-failure-test-'));
  try {
    const logs = [];
    class ThrowingConnectorService {
      cleanupStaleImports() { throw new Error('cleanup-sync-failure'); }
    }
    const config = createServerConfig({
      rootDir:ROOT,
      packageJson:{ version:'1.70.1' },
      env:{
        DATA_DIR:path.join(temp, 'data'), INBOX_DIR:path.join(temp, 'inbox'),
        IMAGES_DIR:path.join(temp, 'images'), BIND:'0.0.0.0', PORT:'55777',
        DX_WINDOWS_LAUNCHER_TOKEN:'launcher-token',
      },
    });
    const bootstrap = createRuntimeBootstrap({
      config,
      platform:'win32',
      StorageConnectorService:ThrowingConnectorService,
      execFile() { throw new Error('powershell-sync-failure'); },
      logger:{
        log(...args) { logs.push(['log', ...args]); },
        warn(...args) { logs.push(['warn', ...args]); },
        error(...args) { logs.push(['error', ...args]); },
      },
    });
    assert.equal(await bootstrap.connectorStartupCleanup, false);
    assert.doesNotThrow(() => bootstrap.ensureWindowsPortableFirewallAccess());
    assert.ok(logs.some((entry) => entry.join(' ').includes('cleanup-sync-failure')));
    assert.ok(logs.some((entry) => entry.join(' ').includes('powershell-sync-failure')));
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});

test('bootstrap preserves directory order and owns rclone construction', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-bootstrap-test-'));
  try {
    const dataDir = path.join(temp, 'data');
    const inboxDir = path.join(temp, 'inbox');
    const config = createServerConfig({
      rootDir:ROOT,
      packageJson:{ version:'1.70.1' },
      env:{ DATA_DIR:dataDir, INBOX_DIR:inboxDir, IMAGES_DIR:path.join(temp, 'images'), RCLONE_BIN:'custom-rclone' },
    });
    const bootstrap = createRuntimeBootstrap({ config, platform:'linux' });
    assert.equal(bootstrap.resolveRcloneBinary(), 'custom-rclone');
    assert.equal(fs.existsSync(config.ENC_DIR), true);
    assert.equal(fs.existsSync(config.FULL_IMAGES_DIR), true);
    assert.equal(fs.existsSync(inboxDir), false, 'reception creation stays in the later base-directory phase');
    bootstrap.ensureBaseDirectories();
    bootstrap.ensureBaseDirectories();
    assert.equal(fs.existsSync(inboxDir), true);
    assert.equal(await bootstrap.connectorStartupCleanup, true);
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});

test('lifecycle start is idempotent and graceful shutdown drains services once', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-lifecycle-test-'));
  try {
    const config = createServerConfig({
      rootDir:ROOT,
      packageJson:{ version:'1.70.1' },
      env:{
        DATA_DIR:path.join(temp, 'data'), INBOX_DIR:path.join(temp, 'inbox'),
        IMAGES_DIR:path.join(temp, 'images'), HOST_ROOT:path.join(temp, 'host'),
        BIND:'127.0.0.1', PORT:'55777', UPDATE_CHECK:'false', PUBLIC_IP_DISCOVERY:'false', NO_COLOR:'1',
      },
    });
    class FakeServer extends EventEmitter {
      close(callback) { this.closed = true; callback(); }
      closeIdleConnections() { this.idleClosed = true; }
      closeAllConnections() { this.allClosed = true; }
    }
    const fakeServer = new FakeServer();
    let listenCount = 0;
    const app = {
      listen(port, bind, callback) {
        listenCount += 1;
        assert.equal(port, 55777);
        assert.equal(bind, '127.0.0.1');
        callback();
        return fakeServer;
      },
    };
    const processRef = new EventEmitter();
    const exitCodes = [];
    processRef.exit = (code) => { exitCodes.push(code); };
    processRef.pid = 123;
    const timers = [];
    const timerFactory = (fn, ms) => {
      const timer = { fn, ms, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    };
    const maintenance = { starts:0, stops:0, start() { this.starts += 1; }, stop() { this.stops += 1; } };
    const connectorJobs = {
      aborted:0,
      abortAll() { this.aborted += 1; },
      async waitForIdle() { return true; },
    };
    const activityResponse = { ended:0, end() { this.ended += 1; } };
    const presenceResponse = { ended:0, end() { this.ended += 1; } };
    const liveActivityClients = new Set([{ res:activityResponse }]);
    const presenceClients = new Set([{ res:presenceResponse }]);
    let pwaClears = 0;
    let pwaStops = 0;
    let cleanNotes = 0;
    const bus = new EventEmitter();
    const quietConsole = { log() {}, warn() {}, error() {} };
    const tlsManager = { ACTIVE_TLS_MODE:'http', config:{ TLS_CERT:'', TLS_KEY:'', TLS_REFRESH_INTERVAL_MS:1000 }, tlsLeafRotationTimer:null };
    const lifecycle = createLifecycleService({
      app, config,
      bootstrap:{ storageSetup:{ inboxUnconfigured:false, imagesUnconfigured:false }, ensureWindowsPortableFirewallAccess() { throw new Error('optional-firewall-failure'); } },
      tlsManager, maintenanceService:maintenance, storageConnectorJobService:connectorJobs,
      pwaEventService:{ clearRuntimeState() { pwaClears += 1; } },
      stopPwaApplication() { pwaStops += 1; },
      accountService:{
        ownerLoginUsername:() => 'admin', isEnvironmentPasswordManaged:() => true,
        hasFreshInitialPassword:() => false, initialPassword:() => null,
      },
      bus, getSettings:() => ({ shutdownAfterDownload:false }), dataWritable:() => true,
      initUniversalSearchIndex:() => { throw new Error('optional-search-failure'); }, flushNow:async () => true,
      liveActivityClients, presenceClients,
      loadTlsOptions:() => null,
      refreshLocalTlsServerContext() {}, refreshProvidedTlsServerContext() {},
      noteCenterLifecycleStart() {}, noteCenterInstalledVersion() {}, checkCenterLinkStates() {},
      checkCenterSystemHealth() {}, noteCenterCleanShutdown() { cleanNotes += 1; },
      getPublicIP:async () => null, publicIpDiscoveryEnabled:() => false, checkForUpdate() {},
      process:processRef, console:quietConsole,
      setTimeout:timerFactory, clearTimeout() {}, setInterval:timerFactory, clearInterval() {},
    });

    assert.equal(lifecycle.start(), fakeServer);
    assert.equal(lifecycle.start(), fakeServer);
    assert.equal(listenCount, 1);
    assert.equal(maintenance.starts, 1);
    assert.equal(lifecycle.getServerScheme(), 'http');
    await lifecycle.shutdown('test', 0);
    assert.equal(maintenance.stops, 1);
    assert.equal(connectorJobs.aborted, 1);
    assert.equal(activityResponse.ended, 1);
    assert.equal(presenceResponse.ended, 1);
    assert.equal(pwaClears, 1);
    assert.equal(pwaStops, 1);
    assert.equal(cleanNotes, 1);
    assert.deepEqual(exitCodes, [0]);
    assert.ok(timers.some((timer) => timer.ms === 750));
    assert.ok(timers.some((timer) => timer.ms === 2500));
    assert.doesNotThrow(() => timers.find((timer) => timer.ms === 750).fn());
    assert.doesNotThrow(() => timers.find((timer) => timer.ms === 2500).fn());
  } finally {
    fs.rmSync(temp, { recursive:true, force:true });
  }
});

function createLifecycleAuditFixture(overrides = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-lifecycle-audit-'));
  const config = createServerConfig({
    rootDir:ROOT,
    packageJson:{ version:'1.70.1' },
    env:{
      DATA_DIR:path.join(temp, 'data'), INBOX_DIR:path.join(temp, 'inbox'),
      IMAGES_DIR:path.join(temp, 'images'), HOST_ROOT:path.join(temp, 'host'),
      BIND:'127.0.0.1', PORT:'55778', UPDATE_CHECK:'false', PUBLIC_IP_DISCOVERY:'false', NO_COLOR:'1',
    },
  });
  class FakeServer extends EventEmitter {
    close(callback) { queueMicrotask(() => callback(null)); }
    closeIdleConnections() {}
    closeAllConnections() {}
  }
  const server = new FakeServer();
  let listenCount = 0;
  const app = overrides.app || {
    listen(_port, _bind, callback) {
      listenCount += 1;
      if (overrides.emitListening !== false) queueMicrotask(callback);
      return server;
    },
  };
  const processRef = new EventEmitter();
  const exitCodes = [];
  processRef.exit = (code) => exitCodes.push(code);
  const calls = { starts:0, stops:0, pwaStops:0, aborts:0, flushes:0, cleanNotes:0 };
  const maintenanceService = overrides.maintenanceService || {
    start() { calls.starts += 1; },
    stop() { calls.stops += 1; },
  };
  const storageConnectorJobService = overrides.storageConnectorJobService || {
    abortAll() { calls.aborts += 1; },
    async waitForIdle() { return true; },
  };
  const warnings = [];
  const lifecycle = createLifecycleService({
    app,
    config,
    bootstrap:{ storageSetup:{ inboxUnconfigured:false, imagesUnconfigured:false }, ensureWindowsPortableFirewallAccess() {} },
    tlsManager:{ ACTIVE_TLS_MODE:'http', config:{ TLS_CERT:'', TLS_KEY:'', TLS_REFRESH_INTERVAL_MS:1000 }, tlsLeafRotationTimer:null },
    maintenanceService,
    storageConnectorJobService,
    pwaEventService:{ clearRuntimeState() {} },
    stopPwaApplication:overrides.stopPwaApplication || (() => { calls.pwaStops += 1; }),
    accountService:{
      ownerLoginUsername:() => 'admin', isEnvironmentPasswordManaged:() => true,
      hasFreshInitialPassword:() => false, initialPassword:() => null,
    },
    bus:new EventEmitter(),
    getSettings:() => ({ shutdownAfterDownload:false }),
    dataWritable:() => true,
    initUniversalSearchIndex:async () => {},
    flushNow:overrides.flushNow || (async () => { calls.flushes += 1; }),
    liveActivityClients:new Set(),
    presenceClients:new Set(),
    loadTlsOptions:overrides.loadTlsOptions || (() => null),
    refreshLocalTlsServerContext() {},
    refreshProvidedTlsServerContext() {},
    noteCenterLifecycleStart() {},
    noteCenterInstalledVersion() {},
    checkCenterLinkStates() {},
    checkCenterSystemHealth() {},
    noteCenterCleanShutdown() { calls.cleanNotes += 1; },
    getPublicIP:async () => null,
    publicIpDiscoveryEnabled:() => false,
    checkForUpdate() {},
    process:processRef,
    console:{ log() {}, error() {}, warn(...args) { warnings.push(args.join(' ')); } },
  });
  return {
    temp, lifecycle, server, processRef, exitCodes, calls, warnings,
    get listenCount() { return listenCount; },
    ready:() => new Promise((resolve) => setImmediate(resolve)),
    close:() => fs.rmSync(temp, { recursive:true, force:true }),
  };
}

test('fatal errors escalate an already-started normal shutdown to a non-clean exit', async () => {
  const fixture = createLifecycleAuditFixture();
  let closeCallback = null;
  fixture.server.close = (callback) => { closeCallback = callback; };
  try {
    fixture.lifecycle.start();
    await fixture.ready();
    const shutdown = fixture.lifecycle.shutdown('SIGTERM', 0);
    fixture.processRef.emit('uncaughtException', new Error('fatal-during-drain'));
    closeCallback(null);
    await shutdown;
    assert.deepEqual(fixture.exitCodes, [1]);
    assert.equal(fixture.calls.cleanNotes, 0);
    assert.equal(fixture.calls.flushes, 1);
  } finally {
    fixture.close();
  }
});

test('TLS and listener startup failures use bounded persistence shutdown', async () => {
  const tlsFailure = createLifecycleAuditFixture({ loadTlsOptions() { throw new Error('tls-broken'); } });
  try {
    assert.equal(tlsFailure.lifecycle.start(), null);
    await tlsFailure.lifecycle.shutdown('wait-for-tls-failure', 1);
    assert.deepEqual(tlsFailure.exitCodes, [1]);
    assert.equal(tlsFailure.calls.stops, 1);
    assert.equal(tlsFailure.calls.flushes, 1);
  } finally {
    tlsFailure.close();
  }

  const listenerFailure = createLifecycleAuditFixture({ emitListening:false });
  try {
    listenerFailure.lifecycle.start();
    listenerFailure.server.emit('error', Object.assign(new Error('in-use'), { code:'EADDRINUSE' }));
    await listenerFailure.lifecycle.shutdown('wait-for-listener-failure', 1);
    assert.deepEqual(listenerFailure.exitCodes, [1]);
    assert.equal(listenerFailure.calls.flushes, 1);
    assert.equal(listenerFailure.calls.cleanNotes, 0);
  } finally {
    listenerFailure.close();
  }
});

test('shutdown contains synchronous maintenance, connector and persistence failures', async () => {
  const fixture = createLifecycleAuditFixture({
    maintenanceService:{ start() {}, stop() { throw new Error('maintenance-stop-failure'); } },
    storageConnectorJobService:{
      abortAll() { throw new Error('connector-abort-failure'); },
      waitForIdle() { throw new Error('connector-wait-failure'); },
    },
    flushNow() { throw new Error('flush-sync-failure'); },
  });
  try {
    fixture.lifecycle.start();
    await fixture.ready();
    await fixture.lifecycle.shutdown('failure-containment', 0);
    assert.deepEqual(fixture.exitCodes, [1]);
    assert.equal(fixture.calls.cleanNotes, 0);
    assert.ok(fixture.warnings.some((line) => line.includes('maintenance-stop-failure')));
    assert.ok(fixture.warnings.some((line) => line.includes('connector-abort-failure')));
    assert.ok(fixture.warnings.some((line) => line.includes('connector jobs did not fully stop')));
  } finally {
    fixture.close();
  }
});

test('unfinished connector jobs cannot produce a clean shutdown marker', async () => {
  const fixture = createLifecycleAuditFixture({
    storageConnectorJobService:{ abortAll() {}, async waitForIdle() { return false; } },
  });
  try {
    fixture.lifecycle.start();
    await fixture.ready();
    await fixture.lifecycle.shutdown('connector-timeout', 0);
    assert.deepEqual(fixture.exitCodes, [1]);
    assert.equal(fixture.calls.cleanNotes, 0);
  } finally {
    fixture.close();
  }
});

test('a failed clean-state flush converts an otherwise normal shutdown to failure', async () => {
  let flushCount = 0;
  const fixture = createLifecycleAuditFixture({
    async flushNow() {
      flushCount += 1;
      if (flushCount === 2) throw new Error('clean-marker-flush-failure');
    },
  });
  try {
    fixture.lifecycle.start();
    await fixture.ready();
    await fixture.lifecycle.shutdown('clean-marker-validation', 0);
    assert.equal(flushCount, 2);
    assert.equal(fixture.calls.cleanNotes, 1);
    assert.deepEqual(fixture.exitCodes, [1]);
  } finally {
    fixture.close();
  }
});

test('a PWA application cleanup failure prevents a clean shutdown marker', async () => {
  const fixture = createLifecycleAuditFixture({
    stopPwaApplication() { throw new Error('pwa-stop-failure'); },
  });
  try {
    fixture.lifecycle.start();
    await fixture.ready();
    await fixture.lifecycle.shutdown('pwa-cleanup-failure', 0);
    assert.deepEqual(fixture.exitCodes, [1]);
    assert.equal(fixture.calls.cleanNotes, 0);
    assert.ok(fixture.warnings.some((line) => line.includes('pwa-stop-failure')));
  } finally {
    fixture.close();
  }
});
