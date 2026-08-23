'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStateBootstrapService } = require('../lib/server/state-bootstrap-service');

const ROOT = path.resolve(__dirname, '..');

function baseState() {
  return {
    version:1,
    shares:[], trash:[], settings:{ updateCheck:true, publicIpDiscovery:true }, history:[], photoHistory:[],
    stats:{}, meta:{}, audit:[], ipNames:{}, undoLog:[], activityLog:[],
  };
}

function fixture(overrides = {}) {
  let state = overrides.initialState || baseState();
  const calls = [];
  const logs = [];
  const deferred = [];
  const markers = new Set();
  const fsStub = {
    unlinkSync(file) { calls.push(`unlink:${file}`); markers.delete(file); },
  };
  const parsed = overrides.parsed || {
    shares:[{ id:'s1' }],
    settings:{ accentColor:'#fff' },
    history:[1,2,3], audit:[1,2,3], photoHistory:['photo'], stats:{ a:1 }, meta:{ b:2 }, ipNames:{ c:'d' },
    undoLog:['undo'],
  };
  const stateStore = {
    load() {
      calls.push('load');
      if (overrides.loadError) throw overrides.loadError;
      return parsed;
    },
  };
  const service = createStateBootstrapService({
    fs:fsStub,
    stateStore,
    getState:() => state,
    replaceState(next) { calls.push('replace'); state = next; },
    DEFAULT_SETTINGS:{ updateCheck:true, publicIpDiscovery:true, theme:'dark' },
    HISTORY_MAX:2,
    AUDIT_MAX:2,
    normalizePhotoHistory(value) { calls.push('normalize-photo'); return Array.isArray(value) ? value : []; },
    sanitizeUndoLog(value) { calls.push('sanitize-undo'); return Array.isArray(value) ? value : []; },
    sanitizeActivityLog(value) { calls.push('sanitize-activity'); return Array.isArray(value) ? value : []; },
    buildLegacyActivityLog(audit, history) { calls.push('legacy-activity'); return [{ audit:audit.length, history:history.length }]; },
    syncLiveActivityCache() { calls.push('sync-activity'); if (overrides.syncActivityError) throw overrides.syncActivityError; },
    migrateLegacyFirstUseExpiryState() { calls.push('migrate-lifecycle'); return overrides.lifecycleMigrated !== false; },
    sanitizeDlpQuarantineState() { calls.push('sanitize-quarantine'); return !!overrides.quarantineStateMigrated; },
    reconcileDlpQuarantineFiles() { calls.push('reconcile-quarantine'); return !!overrides.quarantineFilesMigrated; },
    cleanupDlpQuarantineOrphans() { calls.push('cleanup-quarantine'); },
    reindex() { calls.push('reindex'); },
    persistNow() { calls.push('persist-now'); return overrides.persistResult !== false; },
    recoverInterruptedCoreRestore() { calls.push('recover-core'); },
    recoverInterruptedSecretRestore() { calls.push('recover-secret'); },
    recoverInterruptedTlsRestore() { calls.push('recover-tls'); },
    initAuditChain() { calls.push('init-audit'); },
    ensureAuditProofKeys() { calls.push('init-proof'); },
    initAccounts() { calls.push('init-accounts'); },
    trimLogIfNeeded() { calls.push('trim-log'); },
    pruneHistory() { calls.push('prune-history'); },
    migrateLegacyPhotoStorage() { calls.push('migrate-photos'); return overrides.photoMigration || Promise.resolve(); },
    env:overrides.env || {},
    exit(code) { calls.push(`exit:${code}`); },
    defer(fn) { calls.push('defer-photo'); deferred.push(fn); },
    logger:{ error(...args) { logs.push(args.join(' ')); } },
  });
  return { service, calls, logs, deferred, markers, get state() { return state; } };
}

test('startup state boundary owns load normalization, migrations, restore recovery and initialization order', async () => {
  const f = fixture({ env:{ DX_WINDOWS_INSTALL_UPDATE_CHECK:'0', DX_WINDOWS_INSTALL_UPDATE_CHECK_MARKER:'marker-update' } });
  f.markers.add('marker-update');
  const result = f.service.initialize();

  assert.equal(result.initialized, true);
  assert.equal(result.loaded, true);
  assert.equal(result.activityMigrated, true);
  assert.equal(result.migrationsPersisted, true);
  assert.deepEqual(f.state.shares, [{ id:'s1' }]);
  assert.equal(f.state.settings.theme, 'dark');
  assert.equal(f.state.settings.accentColor, '#fff');
  assert.equal(f.state.settings.updateCheck, false);
  assert.deepEqual(f.state.history, [1,2]);
  assert.deepEqual(f.state.audit, [1,2]);
  assert.deepEqual(f.state.activityLog, [{ audit:2, history:2 }]);

  const expected = [
    'load','normalize-photo','sanitize-undo','sanitize-activity','legacy-activity','replace','sync-activity',
    'migrate-lifecycle','sanitize-quarantine','reconcile-quarantine','reindex','persist-now','unlink:marker-update','cleanup-quarantine',
    'recover-core','recover-secret','recover-tls','init-audit','init-proof','init-accounts','trim-log','prune-history','defer-photo',
  ];
  assert.deepEqual(f.calls, expected);
  assert.equal(f.deferred.length, 1);
  f.deferred[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(f.calls.includes('migrate-photos'));
});

test('loaded record-shaped fields reject arrays and primitives instead of spreading corrupt state', () => {
  const f = fixture({ parsed:{
    shares:[], settings:['bad-setting'], history:[], photoHistory:[], stats:['bad-stat'],
    meta:'bad-meta', audit:[], ipNames:42, undoLog:[], activityLog:[],
  } });
  const result = f.service.initialize();
  assert.equal(result.loaded, true);
  assert.deepEqual(f.state.settings, { updateCheck:true, publicIpDiscovery:true, theme:'dark' });
  assert.deepEqual(f.state.stats, {});
  assert.deepEqual(f.state.meta, {});
  assert.deepEqual(f.state.ipNames, {});
});

test('runtime activity projection failure is not misclassified as corrupt persistent storage', () => {
  const boom = new Error('runtime-cache-boom');
  const f = fixture({ syncActivityError:boom });
  assert.throws(() => f.service.initialize(), /runtime-cache-boom/);
  assert.ok(f.calls.includes('replace'));
  assert.ok(f.calls.includes('sync-activity'));
  assert.equal(f.calls.some((entry) => entry.startsWith('exit:')), false);
  assert.equal(f.logs.some((line) => line.includes('shares.json')), false);
});

test('failed migration persistence keeps one-shot markers and quarantine files untouched', () => {
  const f = fixture({
    persistResult:false,
    env:{ DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY:'0', DX_WINDOWS_INSTALL_PUBLIC_IP_DISCOVERY_MARKER:'marker-public' },
  });
  const result = f.service.initialize();
  assert.equal(result.migrationsPersisted, false);
  assert.ok(f.calls.includes('persist-now'));
  assert.equal(f.calls.some((entry) => entry.startsWith('unlink:')), false);
  assert.equal(f.calls.includes('cleanup-quarantine'), false);
  assert.ok(f.calls.includes('recover-core'), 'restore recovery should retain historical startup ordering');
});

test('missing store keeps the prebuilt empty state but still performs startup migrations and recovery', () => {
  const missing = Object.assign(new Error('missing'), { code:'ENOENT' });
  const initial = baseState();
  const f = fixture({ loadError:missing, initialState:initial, lifecycleMigrated:false });
  const result = f.service.initialize();
  assert.equal(result.loaded, false);
  assert.equal(result.fatal, false);
  assert.equal(f.state, initial);
  assert.equal(f.calls.includes('replace'), false);
  assert.equal(f.calls.includes('sync-activity'), false);
  assert.equal(f.calls.includes('reindex'), true);
  assert.equal(f.calls.includes('recover-core'), true);
  assert.equal(f.calls.includes('init-accounts'), true);
});

test('unreadable or encrypted stores fail closed and do not continue startup when exit is intercepted', () => {
  for (const error of [
    Object.assign(new Error('missing key'), { code:'DATA_KEY_REQUIRED' }),
    Object.assign(new Error('wrong key'), { code:'DATA_KEY_INVALID' }),
    Object.assign(new Error('corrupt'), { code:'INVALID_STORE' }),
  ]) {
    const f = fixture({ loadError:error });
    const result = f.service.initialize();
    assert.equal(result.initialized, false);
    assert.equal(result.fatal, true);
    assert.deepEqual(f.calls, ['load','exit:1']);
    assert.equal(f.logs.length, 1);
  }
});

test('deferred legacy photo migration failures are contained and logged', async () => {
  const f = fixture({ photoMigration:Promise.reject(new Error('photo-boom')) });
  f.service.initialize();
  f.deferred[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.logs.some((line) => line.includes('[images] migration failed:') && line.includes('photo-boom')));
});

test('server delegates startup state coordination to state-bootstrap-service', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const moduleText = fs.readFileSync(path.join(ROOT, 'lib/server/state-bootstrap-service.js'), 'utf8').replace(/\r\n/g, '\n');
  const core = fs.readFileSync(path.join(ROOT, 'lib/server/core-state-application.js'), 'utf8').replace(/\r\n/g, '\n');
  const lifecycle = fs.readFileSync(path.join(ROOT, 'lib/server/state-lifecycle-application.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(server, /createStateLifecycleApplication\(\{/);
  assert.match(lifecycle, /coreStateApplication\.initializeStateLifecycle\(\{/);
  assert.match(core, /createStateBootstrapService\(\{/);
  assert.match(core, /stateBootstrapService\.initialize\(\)/);
  assert.doesNotMatch(server, /function storeLoad\(/);
  assert.doesNotMatch(server, /const parsed = stateStore\.load\(\)/);
  assert.doesNotMatch(server, /applyWindowsInstallPreferences\(state, process\.env\)/);
  assert.match(moduleText, /stateStore\.load\(\)/);
  assert.match(moduleText, /applyWindowsInstallPreferences\(currentState, env \|\| \{\}\)/);
  assert.match(moduleText, /recoverInterruptedCoreRestore\(\)/);
  assert.match(moduleText, /initAuditChain\(\)/);
  assert.ok(server.split('\n').length < 2200, 'startup extraction should keep server.js compact');
});

test('Windows runtime integrity protects the startup-state boundary', () => {
  const rel = 'lib/server/state-bootstrap-service.js';
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const host = fs.readFileSync(path.join(ROOT, 'windows-server-host', 'Program.cs'), 'utf8');
  assert.match(host, new RegExp(`\\{ "${rel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}", "${hash}" \\}`));
});
