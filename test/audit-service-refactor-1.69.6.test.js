'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { timingSafeEqualStr } = require('../lib/core-utils');
const { createAuditService } = require('../lib/server/audit-service');

function harness(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-audit-service-'));
  let state = { audit:[], meta:{}, shares:[] };
  const activity = [];
  const alerts = [];
  const service = createAuditService({
    fs, path, crypto, DATA_DIR:dir, DATA_KEY:'', APP_NAME:'Direct-Xfer', APP_VERSION:'1.69.6', AUDIT_MAX:500,
    timingSafeEqualStr, getState:() => state, persistNow:() => true, scheduleFlush:() => {},
    emitLiveActivity:(kind, data) => activity.push({ kind, data }), pubIp:(ip) => ip,
    scheduleSearchReindex:() => {}, getAccountById:(id) => id === 'a1' ? { id:'a1', username:'alice', role:'admin' } : null,
    clientIp:(req) => req && req.ip || '127.0.0.1', isActivityIgnored:() => false, env,
  });
  service.setSecurityAlertHandler((entry) => alerts.push(entry));
  return { dir, service, activity, alerts, get state(){ return state; }, replaceState(next){ state = next; } };
}

function cleanup(h) { fs.rmSync(h.dir, { recursive:true, force:true }); }

test('audit HMAC/proof/migration implementation is extracted from server.js', () => {
  const server = read('server.js');
  const audit = read('lib/server/audit-service.js');
  assert.match(server, /createAuditService/);
  for (const name of ['ensureAuditProofKeys','verifyAuditProofBundle','migrateLocalAuditKeyToExternalIfNeeded','appendAuditChainEntry','durableAuditWriteSync']) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\b`), `${name} should not live in server.js`);
    assert.match(audit, new RegExp(`function\\s+${name}\\b`));
  }
  assert.ok(fs.statSync(path.join(ROOT, 'server.js')).size < 630000, 'server.js should shrink after audit extraction');
});

test('audit service appends a durable HMAC chain and produces a verifiable Ed25519 proof', () => {
  const h = harness({ AUDIT_HMAC_KEY:'test-audit-secret' });
  try {
    h.service.initAuditChain();
    const row = h.service.logAudit('account-login', { account:{ id:'a1', username:'alice', role:'admin' }, ip:'203.0.113.8', detail:'ok' });
    assert.ok(row && row.hash);
    assert.equal(h.state.audit.length, 1);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.activity.length, 1);
    const integrity = h.service.verifyAuditChain();
    assert.equal(integrity.ok, true);
    assert.equal(integrity.entries, 1);
    const entries = h.service.parseAuditChainFile().entries;
    const proof = h.service.buildAuditProof(entries, integrity);
    assert.equal(proof.algorithm, 'Ed25519');
    assert.equal(h.service.verifyAuditProofBundle(proof).ok, true);
    const tampered = structuredClone(proof);
    tampered.entries[0].action = 'tampered';
    assert.equal(h.service.verifyAuditProofBundle(tampered).ok, false);
  } finally { cleanup(h); }
});

test('audit service follows a replaced root state after restore', () => {
  const h = harness({ AUDIT_HMAC_KEY:'restore-secret' });
  try {
    h.service.initAuditChain();
    h.service.logAudit('before-restore', { username:'system', suppressSecurityAlert:true });
    const old = h.state;
    h.replaceState({ audit:[], meta:{}, shares:[] });
    h.service.logAudit('after-restore', { username:'system', suppressSecurityAlert:true });
    assert.equal(h.state.audit[0].action, 'after-restore');
    assert.equal(old.audit[0].action, 'before-restore');
    assert.equal(h.service.verifyAuditChain().ok, true);
  } finally { cleanup(h); }
});

test('introducing AUDIT_HMAC_KEY migrates a valid local-key chain transactionally', () => {
  const h = harness({});
  try {
    h.service.initAuditChain();
    h.service.logAudit('local-key-entry', { username:'system', suppressSecurityAlert:true });
    assert.equal(fs.existsSync(h.service.paths.keyFile), true);

    const migrated = createAuditService({
      fs, path, crypto, DATA_DIR:h.dir, DATA_KEY:'', APP_NAME:'Direct-Xfer', APP_VERSION:'1.69.6', AUDIT_MAX:500,
      timingSafeEqualStr, getState:() => h.state, persistNow:() => true, scheduleFlush:() => {},
      emitLiveActivity:() => {}, pubIp:(ip) => ip, scheduleSearchReindex:() => {}, getAccountById:() => null,
      clientIp:() => '127.0.0.1', isActivityIgnored:() => false, env:{ AUDIT_HMAC_KEY:'external-key' },
    });
    migrated.initAuditChain();
    const status = migrated.getKeyMigrationStatus();
    assert.ok(status && status.ok, JSON.stringify(status));
    assert.equal(migrated.getActiveKeyMode(), 'env');
    assert.equal(migrated.verifyAuditChain().ok, true);
    assert.equal(fs.existsSync(migrated.paths.keyFile), false);
    assert.equal(migrated.parseAuditChainFile().entries.at(-1).action, 'audit-key-migrated');
  } finally { cleanup(h); }
});

test('restore replacement re-signs a structurally valid imported chain with the active audit key', () => {
  const source = harness({ AUDIT_HMAC_KEY:'restore-source-secret' });
  const dest = harness({ AUDIT_HMAC_KEY:'restore-dest-secret' });
  try {
    source.service.initAuditChain();
    source.service.logAudit('one', { username:'system', suppressSecurityAlert:true });
    source.service.logAudit('two', { username:'system', suppressSecurityAlert:true });
    const imported = source.service.parseAuditChainFile().entries.map((e) => ({ ...e }));
    const sourceHashes = imported.map((e) => e.hash);

    dest.service.initAuditChain();
    const resigned = dest.service.replaceChainForRestore(imported);
    assert.equal(resigned.length, 2);
    assert.equal(dest.service.verifyAuditChain().ok, true);
    assert.notDeepEqual(resigned.map((e) => e.hash), sourceHashes);
    assert.equal(resigned[0].prevHash, '');
  } finally { cleanup(source); cleanup(dest); }
});
