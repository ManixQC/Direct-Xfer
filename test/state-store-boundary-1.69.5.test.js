'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createStateStore } = require('../lib/server/state-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dx-state-store-'));
}

function baseState(id = 'one') {
  return {
    version: 1,
    shares: [{ id, token:`token-${id}` }],
    trash: [], settings: {}, history: [], photoHistory: [], stats: {}, meta: {},
    audit: [], ipNames: {}, undoLog: [], activityLog: [],
  };
}

test('state-store owns plaintext persistence and returns validated root state', async () => {
  const dir = tempDir();
  let current = baseState('plain');
  const store = createStateStore({ fs, crypto, dataDir:dir, getState:()=>current, flushDelayMs:5 });
  try {
    assert.equal(store.persistNow(), true);
    assert.deepEqual(store.load().shares.map((row) => row.id), ['plain']);

    current = baseState('deferred');
    store.scheduleFlush();
    await store.flushNow();
    assert.deepEqual(store.load().shares.map((row) => row.id), ['deferred']);
    assert.equal(fs.existsSync(store.storeFile), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('state-store keeps DATA_KEY envelopes compatible and fails closed on a missing or wrong key', () => {
  const dir = tempDir();
  let current = baseState('encrypted');
  const writer = createStateStore({ fs, crypto, dataDir:dir, dataKey:'correct horse battery staple', getState:()=>current });
  try {
    assert.equal(writer.persistNow(), true);
    const raw = JSON.parse(fs.readFileSync(writer.storeFile, 'utf8'));
    assert.equal(raw.dxenc, 1);
    assert.equal(typeof raw.data, 'string');

    const reader = createStateStore({ fs, crypto, dataDir:dir, dataKey:'correct horse battery staple', getState:()=>current });
    assert.equal(reader.load().shares[0].id, 'encrypted');
    reader.close();

    const missing = createStateStore({ fs, crypto, dataDir:dir, getState:()=>current });
    assert.throws(() => missing.load(), (error) => error && error.code === 'DATA_KEY_REQUIRED');
    missing.close();

    const wrong = createStateStore({ fs, crypto, dataDir:dir, dataKey:'wrong key', getState:()=>current });
    assert.throws(() => wrong.load(), (error) => error && error.code === 'DATA_KEY_INVALID');
    wrong.close();
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('a stale async state write cannot overwrite a newer critical persistNow commit', async () => {
  const dir = tempDir();
  let current = baseState('old');
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  let first = true;
  const controlledFs = Object.create(fs);
  controlledFs.writeFile = (file, data, options, callback) => {
    if (!first) return fs.writeFile(file, data, options, callback);
    first = false;
    fs.writeFile(file, data, options, (error) => {
      firstStarted();
      releaseFirst = () => callback(error);
    });
  };

  const store = createStateStore({ fs:controlledFs, crypto, dataDir:dir, getState:()=>current });
  try {
    const pending = store.persist();
    await firstStartedPromise;

    current = baseState('new');
    assert.equal(store.persistNow(), true);
    releaseFirst();
    await pending;

    assert.equal(store.load().shares[0].id, 'new');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('server delegates state file encryption and atomic write scheduling to state-store', () => {
  const root = path.resolve(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const core = fs.readFileSync(path.join(root, 'lib/server/core-state-application.js'), 'utf8').replace(/\r\n/g, '\n');
  const moduleText = fs.readFileSync(path.join(root, 'lib/server/state-store.js'), 'utf8').replace(/\r\n/g, '\n');
  const bootstrapText = fs.readFileSync(path.join(root, 'lib/server/state-bootstrap-service.js'), 'utf8').replace(/\r\n/g, '\n');

  assert.match(server, /require\('\.\/lib\/server\/core-state-application'\)/);
  assert.match(core, /require\('\.\/state-store'\)/);
  assert.match(core, /createStateStore\(\{/);
  assert.match(bootstrapText, /stateStore\.load\(\)/);
  assert.doesNotMatch(server, /let writeChain = Promise\.resolve\(\)/);
  assert.doesNotMatch(server, /function deriveDataKey\(/);
  assert.doesNotMatch(server, /function serializeState\(/);
  assert.doesNotMatch(server, /STORE_TMP/);

  assert.match(moduleText, /function createStateStore\(options = \{\}\)/);
  assert.match(moduleText, /let writeChain = Promise\.resolve\(\)/);
  assert.match(moduleText, /function persistNow\(/);
  assert.match(moduleText, /function scheduleFlush\(/);
  assert.match(moduleText, /function deserializeStore\(/);
  assert.match(moduleText, /module\.exports = \{ createStateStore \}/);
  assert.ok(server.split('\n').length < 22700, 'persistence extraction should keep shrinking server.js');
});


test('flushNow immediately recovers an async persistence failure before controlled shutdown', async () => {
  const dir = tempDir();
  let current = baseState('shutdown-recovery');
  let failAsync = true;
  const controlledFs = Object.create(fs);
  controlledFs.writeFile = (file, data, options, callback) => {
    if (failAsync) {
      failAsync = false;
      return process.nextTick(() => callback(Object.assign(new Error('simulated-async-write-failure'), { code:'EIO' })));
    }
    return fs.writeFile(file, data, options, callback);
  };
  const store = createStateStore({
    fs:controlledFs,
    crypto,
    dataDir:dir,
    getState:()=>current,
    flushDelayMs:1,
    retryDelayMs:60000,
    logger:{ error(){} },
  });
  try {
    store.scheduleFlush();
    await store.flushNow();
    assert.equal(store.load().shares[0].id, 'shutdown-recovery');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('flushNow rejects when the final durable persistence attempt also fails', async () => {
  const dir = tempDir();
  let current = baseState('shutdown-failure');
  const controlledFs = Object.create(fs);
  controlledFs.writeFile = (_file, _data, _options, callback) => {
    process.nextTick(() => callback(Object.assign(new Error('simulated-async-write-failure'), { code:'EIO' })));
  };
  controlledFs.writeFileSync = () => {
    throw Object.assign(new Error('simulated-sync-write-failure'), { code:'EIO' });
  };
  const store = createStateStore({
    fs:controlledFs,
    crypto,
    dataDir:dir,
    getState:()=>current,
    flushDelayMs:1,
    retryDelayMs:60000,
    logger:{ error(){} },
  });
  try {
    store.scheduleFlush();
    await assert.rejects(
      () => store.flushNow(),
      (error) => error && error.code === 'FINAL_PERSISTENCE_FAILED',
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('state-store exposes explicit retry scheduling for rollback recovery paths', async () => {
  const dir = tempDir();
  let current = baseState('retry-path');
  const store = createStateStore({
    fs, crypto, dataDir:dir, getState:()=>current,
    retryDelayMs:60000,
    logger:{ error(){} },
  });
  try {
    assert.equal(typeof store.schedulePersistRetry, 'function');
    store.schedulePersistRetry();
    await store.flushNow();
    assert.equal(store.load().shares[0].id, 'retry-path');

    const root = path.resolve(__dirname, '..');
    const serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const registrarText = fs.readFileSync(path.join(root, 'lib/server/register-application-domains.js'), 'utf8');
    const { ROUTE_DEPENDENCIES } = require('../lib/server/application-context');
    assert.match(serverText, /publishApplicationGraph\(\{/);
    assert.match(registrarText, /\['state-store', requiredValue\(services, 'stateStore', 'services'\)\]/);
    assert.ok(ROUTE_DEPENDENCIES.adminSecurity.includes('schedulePersistRetry'));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
