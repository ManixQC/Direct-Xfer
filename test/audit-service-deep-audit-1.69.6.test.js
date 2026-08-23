'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { timingSafeEqualStr } = require('../lib/core-utils');
const { createAuditService } = require('../lib/server/audit-service');

function createHarness({ env = {}, fsImpl = fs, dir = null, initialState = null, dataKey = '', persistNow = () => true } = {}) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'dx-audit-deep-'));
  let state = initialState || { audit:[], meta:{}, shares:[] };
  const service = createAuditService({
    fs:fsImpl, path, crypto, DATA_DIR:dataDir, DATA_KEY:dataKey, APP_NAME:'Direct-Xfer', APP_VERSION:'1.69.6', AUDIT_MAX:500,
    timingSafeEqualStr, getState:() => state, persistNow, scheduleFlush:() => {},
    emitLiveActivity:() => {}, pubIp:(ip) => ip, scheduleSearchReindex:() => {}, getAccountById:() => null,
    clientIp:() => '127.0.0.1', isActivityIgnored:() => true, env,
  });
  return { dir:dataDir, service, get state(){ return state; }, set state(next){ state = next; } };
}
function cleanup(h) { fs.rmSync(h.dir, { recursive:true, force:true }); }

test('local audit HMAC key creation fails closed when durable persistence fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-audit-key-fail-'));
  const faultyFs = { ...fs };
  faultyFs.openSync = function(file, flags, mode) {
    if (String(file) === path.join(dir, 'audit-chain.key') && String(flags).includes('x')) {
      const error = new Error('simulated read-only data volume'); error.code = 'EACCES'; throw error;
    }
    return fs.openSync(file, flags, mode);
  };
  const h = createHarness({ dir, fsImpl:faultyFs });
  try {
    assert.throws(() => h.service.ensureAuditChainKey(), (error) => error && error.code === 'audit-key-persist-failed');
    assert.equal(fs.existsSync(h.service.paths.keyFile), false);
    assert.throws(() => h.service.ensureAuditChainKey(), (error) => error && error.code === 'audit-key-persist-failed');
  } finally { cleanup(h); }
});

test('a corrupt local HMAC key file is rejected instead of being truncated or replaced', () => {
  const h = createHarness();
  try {
    fs.writeFileSync(h.service.paths.keyFile, Buffer.alloc(31, 7));
    assert.throws(() => h.service.ensureAuditChainKey(), (error) => error && error.code === 'audit-key-invalid');
    assert.equal(fs.readFileSync(h.service.paths.keyFile).length, 31);
  } finally { cleanup(h); }
});

test('signed-head tampering is not silently erased by the next audit append', () => {
  const h = createHarness({ env:{ AUDIT_HMAC_KEY:'head-tamper-secret' } });
  try {
    h.service.initAuditChain();
    assert.ok(h.service.logAudit('before-tamper', { username:'system', suppressSecurityAlert:true }));
    const head = JSON.parse(fs.readFileSync(h.service.paths.headFile, 'utf8'));
    head.seq += 1; // seal intentionally no longer matches
    fs.writeFileSync(h.service.paths.headFile, JSON.stringify(head));
    const tamperedRaw = fs.readFileSync(h.service.paths.headFile, 'utf8');

    assert.equal(h.service.logAudit('must-not-append', { username:'system', suppressSecurityAlert:true }), null);
    assert.equal(fs.readFileSync(h.service.paths.headFile, 'utf8'), tamperedRaw);
    assert.equal(h.service.getIntegrityStatus().ok, false);
    assert.equal(h.service.getIntegrityStatus().reason, 'head-signature-invalid');
    assert.equal(h.service.parseAuditChainFile().entries.length, 1);
  } finally { cleanup(h); }
});

test('live-chain verification rejects unsigned extra JSON fields', () => {
  const h = createHarness({ env:{ AUDIT_HMAC_KEY:'shape-secret' } });
  try {
    h.service.initAuditChain();
    h.service.logAudit('canonical-entry', { username:'system', suppressSecurityAlert:true });
    const entry = h.service.parseAuditChainFile().entries[0];
    entry.unsignedMutableField = 'injected';
    fs.writeFileSync(h.service.paths.chainFile, JSON.stringify(entry) + '\n');
    const status = h.service.verifyAuditChain();
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'entry-extra-field');
  } finally { cleanup(h); }
});

test('restore validation rejects a broken prevHash or mismatched backed-up head', () => {
  const h = createHarness({ env:{ AUDIT_HMAC_KEY:'restore-validation-secret' } });
  try {
    h.service.initAuditChain();
    h.service.logAudit('one', { username:'system', suppressSecurityAlert:true });
    h.service.logAudit('two', { username:'system', suppressSecurityAlert:true });
    const entries = h.service.parseAuditChainFile().entries;
    const head = JSON.parse(fs.readFileSync(h.service.paths.headFile, 'utf8'));
    assert.equal(h.service.validateAuditRestoreEntries(entries, head).ok, true);

    const brokenLink = structuredClone(entries);
    brokenLink[1].prevHash = '0'.repeat(64);
    assert.equal(h.service.validateAuditRestoreEntries(brokenLink, head).reason, 'previous-hash-mismatch');
    assert.throws(() => h.service.replaceChainForRestore(brokenLink), /invalid-audit-backup/);

    const wrongHead = { ...head, hash:'f'.repeat(64) };
    assert.equal(h.service.validateAuditRestoreEntries(entries, wrongHead).reason, 'restore-head-mismatch');
  } finally { cleanup(h); }
});

test('same-key audit snapshots authenticate HMAC entries and the signed head before restore', () => {
  const h = createHarness({ env:{ AUDIT_HMAC_KEY:'snapshot-secret' } });
  try {
    h.service.initAuditChain();
    h.service.logAudit('snapshot-entry', { username:'system', detail:'original', suppressSecurityAlert:true });
    const key = h.service.ensureAuditChainKey();
    const chainRaw = fs.readFileSync(h.service.paths.chainFile);
    const headRaw = fs.readFileSync(h.service.paths.headFile);
    assert.equal(h.service.verifyAuditSnapshot(chainRaw, headRaw, key).ok, true);

    const tampered = h.service.parseAuditChainText(chainRaw.toString('utf8')).entries;
    tampered[0].detail = 'changed-without-hmac';
    const tamperedRaw = Buffer.from(JSON.stringify(tampered[0]) + '\n');
    const result = h.service.verifyAuditSnapshot(tamperedRaw, headRaw, key);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'entry-hash-mismatch');
  } finally { cleanup(h); }
});

test('failed AUDIT_HMAC_KEY migration keeps the local key active for forensic diagnostics', () => {
  const first = createHarness();
  try {
    first.service.initAuditChain();
    first.service.logAudit('local-entry', { username:'system', suppressSecurityAlert:true });
    const row = first.service.parseAuditChainFile().entries[0];
    row.action = 'tampered-action';
    fs.writeFileSync(first.service.paths.chainFile, JSON.stringify(row) + '\n');

    const second = createHarness({ dir:first.dir, initialState:first.state, env:{ AUDIT_HMAC_KEY:'new-external-secret' } });
    second.service.initAuditChain();
    const migration = second.service.getKeyMigrationStatus();
    const integrity = second.service.getIntegrityStatus();
    assert.equal(migration.ok, false);
    assert.equal(migration.reason, 'local-chain-invalid');
    assert.equal(migration.integrityReason, 'entry-hash-mismatch');
    assert.equal(second.service.getActiveKeyMode(), 'local-file-fallback');
    assert.equal(integrity.ok, false);
    assert.equal(integrity.reason, 'entry-hash-mismatch');
  } finally { cleanup(first); }
});


test('introducing AUDIT_HMAC_KEY safely migrates a journal that was derived from DATA_KEY', () => {
  const first = createHarness({ dataKey:'existing-data-key' });
  try {
    first.service.initAuditChain();
    first.service.logAudit('data-key-entry', { username:'system', suppressSecurityAlert:true });
    assert.equal(first.service.getActiveKeyMode(), 'data-key');

    const second = createHarness({
      dir:first.dir, initialState:first.state, dataKey:'existing-data-key',
      env:{ AUDIT_HMAC_KEY:'dedicated-audit-key' },
    });
    second.service.initAuditChain();
    const migration = second.service.getKeyMigrationStatus();
    assert.ok(migration && migration.ok, JSON.stringify(migration));
    assert.equal(migration.fromMode, 'data-key');
    assert.equal(second.service.getActiveKeyMode(), 'env');
    assert.equal(second.service.verifyAuditChain().ok, true);
    const rows = second.service.parseAuditChainFile().entries;
    assert.equal(rows.at(-1).action, 'audit-key-migrated');
    assert.match(rows.at(-1).detail, /^data-key /);
  } finally { cleanup(first); }
});


test('a failed key migration cannot later roll back audit events written after the rollback', () => {
  const first = createHarness();
  try {
    first.service.initAuditChain();
    first.service.logAudit('before-migration', { username:'system', suppressSecurityAlert:true });

    let failPersist = true;
    const second = createHarness({
      dir:first.dir, initialState:first.state, env:{ AUDIT_HMAC_KEY:'retry-external-key' },
      persistNow:() => { if (failPersist) { failPersist = false; return false; } return true; },
    });
    second.service.initAuditChain();
    const failed = second.service.getKeyMigrationStatus();
    assert.ok(failed && failed.ok === false, JSON.stringify(failed));
    assert.equal(second.service.getActiveKeyMode(), 'local-file-fallback');
    assert.ok(second.service.logAudit('after-failed-migration', { username:'system', suppressSecurityAlert:true }));
    assert.equal(second.service.parseAuditChainFile().entries.at(-1).action, 'after-failed-migration');

    const third = createHarness({
      dir:first.dir, initialState:second.state, env:{ AUDIT_HMAC_KEY:'retry-external-key' },
    });
    third.service.initAuditChain();
    assert.equal(third.service.verifyAuditChain().ok, true);
    assert.equal(third.service.getActiveKeyMode(), 'env');
    const actions = third.service.parseAuditChainFile().entries.map((entry) => entry.action);
    assert.deepEqual(actions, ['before-migration', 'after-failed-migration', 'audit-key-migrated']);
  } finally { cleanup(first); }
});
