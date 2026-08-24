'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createAccountService } = require('../lib/server/account-service');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

function fakeHash(value) {
  return `test$${Buffer.from(String(value)).toString('base64')}`;
}

function fakeParse(value) {
  const match = /^test\$([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) return null;
  return { salt:Buffer.from('test-salt'), hash:Buffer.from(match[1], 'base64') };
}

function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-accounts-'));
  let state = options.state || { settings:{ pwChanged:false }, meta:{} };
  let persistCalls = 0;
  const logs = [];
  const service = createAccountService({
    fs,
    path,
    crypto,
    dataDir,
    getState:() => state,
    getSettings:() => state.settings || {},
    persistNow:() => {
      persistCalls += 1;
      return options.persistResult !== false;
    },
    env:options.env || {},
    passwordHasher:fakeHash,
    passwordParser:fakeParse,
    now:() => 123456,
    logger:{
      log:(...args) => logs.push(args.join(' ')),
      warn:(...args) => logs.push(args.join(' ')),
    },
  });
  return {
    dataDir,
    service,
    logs,
    get state() { return state; },
    replaceState(next) { state = next; },
    get persistCalls() { return persistCalls; },
    close() { fs.rmSync(dataDir, { recursive:true, force:true }); },
  };
}

test('account bootstrap and lookup helpers are isolated behind account-service', () => {
  const server = read('server.js');
  const core = read('lib/server/core-state-application.js');
  const source = read('lib/server/account-service.js');
  assert.match(server, /createCoreStateApplication\(\{/);
  assert.match(core, /createAccountService\(\{/);
  assert.match(core, /require\('\.\/account-service'\)/);
  assert.match(core, /initAccounts:accountService\.initialize/);
  assert.match(server, /accountPasswordRecord:accountPwRec/);
  assert.match(server, /accountNeedsPasswordChange:accountNeedsPwChange/);
  for (const name of [
    'normUsername',
    'accountList',
    'findAccountByName',
    'getAccountById',
    'ownerAccount',
    'newAccountId',
    'accountPwRec',
    'accountNeedsPwChange',
    'initAccounts',
  ]) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\s*\\(`), name);
  }
  for (const name of [
    'normalizeUsername',
    'accountList',
    'findAccountByName',
    'getAccountById',
    'ownerAccount',
    'newAccountId',
    'accountPasswordRecord',
    'accountNeedsPasswordChange',
    'initialize',
  ]) {
    assert.match(source, new RegExp(`function\\s+${name}\\s*\\(`), name);
  }
  assert.doesNotMatch(server, /process\.env\.ADMIN_PASSWORD/);
  assert.doesNotMatch(server, /admin-password\.txt/);
});

test('service construction fails closed when account persistence dependencies are missing', () => {
  assert.throws(() => createAccountService({}), /requires getState\(\)/);
});

test('first startup creates one durable owner with a randomized non-default identity', () => {
  const f = fixture();
  try {
    const first = f.service.initialize();
    const password = f.service.initialPassword();
    const owner = f.service.ownerAccount();
    assert.equal(first.initialized, true);
    assert.equal(first.environmentManaged, false);
    assert.equal(first.initialPasswordFresh, true);
    assert.equal(first.ownerAvailable, true);
    assert.equal(f.persistCalls, 1);
    assert.match(owner.username, /^owner-[a-f0-9]{12}$/);
    assert.notEqual(owner.username.toLowerCase(), 'admin');
    assert.equal(owner.role, 'owner');
    assert.equal(owner.createdAt, 123456);
    assert.equal(owner.ah, fakeHash(password));
    assert.equal(f.service.findAccountByName(` ${owner.username.toUpperCase()} `), owner);
    assert.equal(f.service.findAccountByName('admin'), null);
    assert.equal(f.service.getAccountById(owner.id), owner);

    // Process-local idempotency must not generate or persist a second secret.
    assert.deepEqual(f.service.initialize(), first);
    assert.equal(f.service.initialPassword(), password);
    assert.equal(f.persistCalls, 1);

    f.service.clearInitialPassword();
    assert.equal(f.service.hasFreshInitialPassword(), false);
    assert.equal(f.service.initialPassword(), null);
  } finally {
    f.close();
  }
});

test('legacy plaintext and TOTP migrate in one durable commit before the source file is deleted', () => {
  const f = fixture({ state:{ settings:{ pwChanged:true }, meta:{ totp:{ secret:'ABC', enabled:true } } } });
  const legacyFile = path.join(f.dataDir, 'admin-password.txt');
  fs.writeFileSync(legacyFile, 'old-secret\n');
  try {
    f.service.initialize();
    const owner = f.service.ownerAccount();
    assert.equal(f.persistCalls, 1);
    assert.equal(owner.ah, fakeHash('old-secret'));
    assert.deepEqual(owner.totp, { secret:'ABC', enabled:true });
    assert.equal(owner.pwChanged, true);
    assert.equal(Object.hasOwn(f.state.meta, 'ah'), false);
    assert.equal(Object.hasOwn(f.state.meta, 'totp'), false);
    assert.equal(fs.existsSync(legacyFile), false);
    assert.match(f.logs.join('\n'), /migrated admin password/);
  } finally {
    f.close();
  }
});

test('failed durable migration retains admin-password.txt for recovery', () => {
  const f = fixture({ persistResult:false });
  const legacyFile = path.join(f.dataDir, 'admin-password.txt');
  fs.writeFileSync(legacyFile, 'recoverable-secret');
  try {
    f.service.initialize();
    assert.equal(f.persistCalls, 1);
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), 'recoverable-secret');
    assert.equal(f.service.ownerAccount().ah, fakeHash('recoverable-secret'));
    assert.equal(f.service.hasFreshInitialPassword(), false);
  } finally {
    f.close();
  }
});

test('ADMIN_PASSWORD stays session-only and overrides only the live owner credential', () => {
  const owner = { id:'owner', username:'before', role:'owner', ah:fakeHash('stored'), pwChanged:false };
  const admin = { id:'admin', username:'helper', role:'admin', ah:fakeHash('helper'), pwChanged:false };
  const f = fixture({
    state:{ settings:{}, meta:{ accounts:[owner, admin] } },
    env:{ ADMIN_USERNAME:'Root Owner', ADMIN_PASSWORD:' env-secret ' },
  });
  try {
    f.service.initialize();
    assert.equal(f.persistCalls, 0);
    assert.equal(f.service.isEnvironmentPasswordManaged(), true);
    assert.equal(owner.username, 'before');
    assert.equal(f.service.ownerLoginUsername(), 'Root Owner');
    assert.equal(f.service.findAccountByName('Root Owner'), owner);
    assert.equal(f.service.findAccountByName('before'), null);
    assert.equal(f.service.accountNeedsPasswordChange(owner), false);
    assert.equal(f.service.accountNeedsPasswordChange(admin), true);
    assert.equal(f.service.accountPasswordRecord(owner).hash.toString(), 'env-secret');
    assert.equal(f.service.accountPasswordRecord(admin).hash.toString(), 'helper');
    assert.equal(owner.ah, fakeHash('stored'));
    assert.equal(f.service.hasFreshInitialPassword(), false);
  } finally {
    f.close();
  }
});

test('ADMIN_PASSWORD without ADMIN_USERNAME reuses a persisted owner identity', () => {
  const owner = { id:'owner', username:'owner-abcdef123456', role:'owner', ah:fakeHash('stored'), pwChanged:true };
  const f = fixture({
    state:{ settings:{}, meta:{ accounts:[owner] } },
    env:{ ADMIN_PASSWORD:'env-secret' },
  });
  try {
    f.service.initialize();
    assert.equal(f.service.ownerLoginUsername(), owner.username);
    assert.equal(f.service.findAccountByName(owner.username), owner);
    assert.equal(f.service.findAccountByName('admin'), null);
  } finally {
    f.close();
  }
});

test('all account lookups follow a restored root state object', () => {
  const original = { id:'one', username:'original', role:'owner', ah:fakeHash('one'), pwChanged:true };
  const restored = { id:'two', username:'restored', role:'owner', ah:fakeHash('two'), pwChanged:true };
  const f = fixture({ state:{ settings:{}, meta:{ accounts:[original] } } });
  try {
    f.service.initialize();
    f.replaceState({ settings:{}, meta:{ accounts:[restored] } });
    assert.deepEqual(f.service.accountList(), [restored]);
    assert.equal(f.service.getAccountById('one'), null);
    assert.equal(f.service.getAccountById('two'), restored);
    assert.equal(f.service.findAccountByName('RESTORED'), restored);
    assert.equal(f.service.ownerAccount(), restored);
  } finally {
    f.close();
  }
});
