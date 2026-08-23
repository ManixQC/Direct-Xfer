'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createStorageConnectorJobService } = require('../lib/server/storage-connector-job-service');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-connector-jobs-'));
  const inbox = path.join(root, 'inbox');
  const images = path.join(root, 'images');
  const host = path.join(root, 'host');
  for (const directory of [inbox, images, host]) fs.mkdirSync(directory, { recursive:true });
  let state = {
    meta:{
      storageConnectorJobs:overrides.initialJobs
        ? overrides.initialJobs.map((job) => ({ ...job }))
        : [],
    },
  };
  const deferred = [];
  const calls = {
    persisted:0,
    persistedNow:0,
    scheduled:0,
    audits:[],
    imports:[],
    exports:[],
  };
  const withinRoot = (base, candidate) => {
    const relative = path.relative(path.resolve(base), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  const storageConnectorService = {
    capabilities:async() => ({ available:true, version:'test' }),
    configuredRemotes:async() => ['remote'],
    importFile:async(connector, remotePath, target) => {
      calls.imports.push({ connector, remotePath, target });
      return { target:path.join(inbox, target), size:11 };
    },
    exportFile:async(connector, source, remotePath) => {
      calls.exports.push({ connector, source, remotePath });
      return { size:12 };
    },
    ...(overrides.storageConnectorService || {}),
  };
  const persistNow = overrides.persistNow || (() => { calls.persistedNow += 1; return true; });
  const persist = overrides.persist || (() => { calls.persisted += 1; return true; });
  const service = createStorageConnectorJobService({
    storageConnectorService,
    connectorStartupCleanup:overrides.connectorStartupCleanup || Promise.resolve(true),
    maxActiveJobs:overrides.maxActiveJobs || 4,
    probeCacheMs:overrides.probeCacheMs === undefined ? 15000 : overrides.probeCacheMs,
    configurationProbeWaitMs:overrides.configurationProbeWaitMs || 100,
    jobRetentionMs:overrides.jobRetentionMs || 86400000,
    maxPersistedJobs:overrides.maxPersistedJobs || 200,
    INBOX_DIR:inbox,
    IMAGE_STORE_DIR:images,
    HOST_ROOT:host,
    getState:() => state,
    persist,
    persistNow,
    scheduleFlush:() => { calls.scheduled += 1; },
    crypto,
    path,
    withinRoot,
    assertRealWithin:async(_base, target) => target,
    hostToContainer:(value) => path.resolve(host, path.basename(value)),
    clientIp:() => '203.0.113.8',
    cleanConnectorPath:(value) => {
      const cleaned = String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\/+/, '');
      return cleaned && !cleaned.split('/').includes('..') ? cleaned : null;
    },
    clamavEnabled:() => false,
    scanFile:async() => ({ infected:false }),
    quarantineFile:async() => {},
    connectorErrorCode:(error) => error && error.code,
    logAudit:(action, detail) => {
      calls.audits.push({ action, detail });
      if (overrides.auditThrows) throw new Error('audit unavailable');
    },
    getAccountById:() => null,
    scheduleSearchReindex:() => {
      if (overrides.reindexThrows) throw new Error('reindex unavailable');
    },
    defer:overrides.defer || ((callback) => deferred.push(callback)),
    setTimeoutFn:overrides.setTimeoutFn || ((callback, delay) => {
      const handle = setTimeout(callback, delay);
      return { handle, unref() {} };
    }),
    clearTimeoutFn:overrides.clearTimeoutFn || ((timer) => clearTimeout(timer && timer.handle)),
    now:overrides.now || Date.now,
    logger:{ warn() {}, error() {} },
  });
  return {
    root,
    inbox,
    images,
    host,
    service,
    calls,
    deferred,
    get state() { return state; },
    replaceState(next) { state = next; },
    async runDeferred() {
      while (deferred.length) deferred.shift()();
      assert.equal(await service.waitForIdle(2000), true);
    },
    close() { fs.rmSync(root, { recursive:true, force:true }); },
  };
}

test('connector job implementation is isolated behind one composition contract', () => {
  const server = read('server.js');
  const adminApplication = read('lib/server/admin-application.js');
  const routes = read('lib/server/admin-storage-routes.js');
  const health = read('lib/server/system-health-service.js');
  const restore = read('lib/server/restore-service.js');
  const coordinator = read('lib/server/state-replacement-coordinator.js');
  const stateLifecycle = read('lib/server/state-lifecycle-application.js');
  const lifecycle = read('lib/server/lifecycle-service.js');
  assert.match(adminApplication, /createStorageConnectorJobService\(\{/);
  assert.match(adminApplication, /connectorJobService:storageConnectorJobService/g);
  assert.match(lifecycle, /storageConnectorJobService\.abortAll\(\)/);
  assert.match(lifecycle, /connectorResult\.value === true/);
  assert.match(lifecycle, /persistenceOk && connectorsStopped/);
  for (const name of [
    'connectorProbeSnapshot',
    'connectorProbeForConfiguration',
    'connectorJobStore',
    'pruneConnectorJobs',
    'queueStorageConnectorJob',
  ]) {
    assert.doesNotMatch(server, new RegExp('function\\s+' + name + '\\s*\\('), name);
  }
  assert.match(routes, /connectorJobService/);
  assert.match(health, /connectorJobService\.probeSnapshot/);
  assert.match(stateLifecycle, /\['connector-jobs',[\s\S]*storageConnectorJobService[\s\S]*isBusyForStateReplacement/);
  assert.match(stateLifecycle, /\['connector-jobs',[\s\S]*storageConnectorJobService[\s\S]*clearRuntimeAfterRestore/);
  assert.match(restore, /stateReplacementCoordinator/);
  assert.match(coordinator, /function clearRuntimeAfterRestore\(\)/);
});

test('probe invalidation rejects an older in-flight generation and preserves single-flight results', async () => {
  const capabilityResolvers = [];
  let capabilityCalls = 0;
  const f = fixture({
    storageConnectorService:{
      capabilities:() => {
        capabilityCalls += 1;
        return new Promise((resolve) => capabilityResolvers.push(resolve));
      },
    },
  });
  try {
    const first = f.service.probeSnapshot();
    await Promise.resolve();
    f.service.invalidateProbe();
    const second = f.service.probeSnapshot();
    await Promise.resolve();
    assert.equal(capabilityCalls, 2);
    capabilityResolvers[1]({ available:true, version:'fresh' });
    const fresh = await second;
    capabilityResolvers[0]({ available:false, version:'stale' });
    assert.deepEqual(await first, fresh);
    assert.equal((await f.service.probeSnapshot()).capabilities.version, 'fresh');
    assert.equal(capabilityCalls, 2);
  } finally {
    f.close();
  }
});

test('configuration probes return a neutral pending snapshot within their time bound', async () => {
  const f = fixture({
    configurationProbeWaitMs:100,
    storageConnectorService:{ capabilities:() => new Promise(() => {}) },
  });
  try {
    const startedAt = Date.now();
    assert.deepEqual(await f.service.probeForConfiguration(), {
      capabilities:{ available:false, error:null, pending:true },
      remotes:[],
    });
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    f.close();
  }
});

test('queued jobs persist before execution and use an immutable connector snapshot', async () => {
  const f = fixture({ auditThrows:true, reindexThrows:true });
  try {
    const connector = { id:'connector-1', name:'Original', remote:'before', readOnly:false };
    const job = f.service.queueJob(
      { session:{ accountId:'account-1', username:'owner' } },
      connector,
      'import',
      { remotePath:'folder/file.txt', target:'received.txt' },
    );
    assert.equal(job.status, 'queued');
    assert.equal(f.service.activeCount(), 1);
    assert.equal(f.state.meta.storageConnectorJobs[0], job);
    assert.equal(f.calls.persistedNow, 1);
    connector.remote = 'after';
    connector.name = 'Mutated';
    await f.runDeferred();
    assert.equal(job.status, 'completed');
    assert.equal(job.size, 11);
    assert.equal(f.calls.imports[0].connector.remote, 'before');
    assert.equal(f.calls.imports[0].connector.name, 'Original');
    assert.equal(Object.isFrozen(f.calls.imports[0].connector), true);
    assert.equal(f.service.activeCount(), 0);
  } finally {
    f.close();
  }
});

test('a failed initial commit rolls back the complete prior job journal', () => {
  const initial = [{
    id:'orphan',
    connectorId:'old',
    status:'queued',
    createdAt:Date.now(),
    error:null,
    finishedAt:0,
  }];
  const f = fixture({
    initialJobs:initial,
    persistNow:() => false,
  });
  try {
    assert.throws(
      () => f.service.queueJob({}, { id:'new', name:'New' }, 'import', { remotePath:'a.txt' }),
      (error) => error && error.code === 'write-error',
    );
    assert.deepEqual(f.state.meta.storageConnectorJobs, initial);
    assert.equal(f.service.activeCount(), 0);
    assert.equal(f.deferred.length, 0);
  } finally {
    f.close();
  }
});

test('rollback preserves the live identity of an already active job', async () => {
  let commit = 0;
  const f = fixture({
    maxActiveJobs:2,
    persistNow:() => {
      commit += 1;
      return commit !== 2;
    },
  });
  try {
    const first = f.service.queueJob(
      {},
      { id:'first', name:'First' },
      'import',
      { remotePath:'first.txt' },
    );
    assert.strictEqual(f.state.meta.storageConnectorJobs[0], first);
    assert.throws(
      () => f.service.queueJob({}, { id:'second', name:'Second' }, 'import', { remotePath:'second.txt' }),
      (error) => error && error.code === 'write-error',
    );
    assert.strictEqual(f.state.meta.storageConnectorJobs[0], first);
    assert.equal(first.status, 'queued');
    await f.runDeferred();
    assert.strictEqual(f.state.meta.storageConnectorJobs[0], first);
    assert.equal(first.status, 'completed');
  } finally {
    f.close();
  }
});

test('pruning never evicts active jobs when the journal limit is smaller than capacity', async () => {
  const f = fixture({ maxActiveJobs:12, maxPersistedJobs:10 });
  try {
    const jobs = [];
    for (let index = 0; index < 11; index += 1) {
      jobs.push(f.service.queueJob(
        {},
        { id:'connector-' + index, name:'Connector ' + index },
        'import',
        { remotePath:'file-' + index + '.txt' },
      ));
    }
    assert.equal(f.service.activeCount(), 11);
    assert.equal(f.state.meta.storageConnectorJobs.length, 11);
    for (const job of jobs) assert.ok(f.state.meta.storageConnectorJobs.includes(job));
    f.service.abortAll();
    await f.runDeferred();
  } finally {
    f.close();
  }
});

test('queue scheduling failures remain durable or schedule a retry', () => {
  let commit = 0;
  const f = fixture({
    defer:() => { throw new Error('scheduler unavailable'); },
    persistNow:() => {
      commit += 1;
      return commit === 1;
    },
  });
  try {
    assert.throws(
      () => f.service.queueJob({}, { id:'queue', name:'Queue' }, 'import', { remotePath:'a.txt' }),
      (error) => error && error.code === 'connector-queue-failed',
    );
    assert.equal(f.service.activeCount(), 0);
    assert.equal(f.state.meta.storageConnectorJobs[0].status, 'failed');
    assert.equal(f.state.meta.storageConnectorJobs[0].error, 'connector-queue-failed');
    assert.equal(f.calls.scheduled, 1);
  } finally {
    f.close();
  }
});

test('cancellation and restore barriers cannot leave an active controller behind', async () => {
  const f = fixture({
    storageConnectorService:{
      importFile:(_connector, _remotePath, _target, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('cancelled'), { code:'connector-cancelled' }));
        }, { once:true });
      }),
    },
  });
  try {
    const job = f.service.queueJob({}, { id:'busy', name:'Busy' }, 'import', { remotePath:'a.txt' });
    assert.equal(f.service.isBusyForStateReplacement(), true);
    assert.throws(
      () => f.service.clearRuntimeAfterRestore(),
      (error) => error && error.code === 'CONNECTOR_JOBS_ACTIVE',
    );
    assert.equal(f.service.cancelJob(job.id), true);
    await f.runDeferred();
    assert.equal(job.status, 'cancelled');
    assert.equal(f.service.isBusyForStateReplacement(), false);
    f.service.clearRuntimeAfterRestore();
  } finally {
    f.close();
  }
});

test('exports reject Direct-Xfer internal namespaces case-insensitively', async () => {
  const f = fixture();
  try {
    const publicJob = f.service.publicJob({
      id:'corrupt',
      connectorId:'connector',
      direction:'export',
      status:'completed',
      size:Infinity,
      createdAt:Infinity,
      startedAt:-1,
      finishedAt:'not-a-number',
    });
    assert.equal(publicJob.size, 0);
    assert.equal(publicJob.createdAt, 0);
    assert.equal(publicJob.startedAt, null);
    assert.equal(publicJob.finishedAt, null);
    await assert.rejects(
      f.service.exportSource(path.join(f.inbox, '.DXprivate', 'payload.bin')),
      (error) => error && error.code === 'invalid-source',
    );
  } finally {
    f.close();
  }
});

test('non-finite connector sizes never enter the durable job journal', async () => {
  const f = fixture({
    storageConnectorService:{
      importFile:async(_connector, _remotePath, target) => ({
        target:path.join(os.tmpdir(), target),
        size:Infinity,
      }),
    },
  });
  try {
    const job = f.service.queueJob({}, { id:'size', name:'Size' }, 'import', { remotePath:'a.txt' });
    await f.runDeferred();
    assert.equal(job.status, 'completed');
    assert.equal(job.size, 0);
    assert.equal(f.state.meta.storageConnectorJobs[0].size, 0);
  } finally {
    f.close();
  }
});
