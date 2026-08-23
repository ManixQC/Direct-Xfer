'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createAccountService } = require('../lib/server/account-service');

function fakeHash(value) {
  return `test$${Buffer.from(String(value)).toString('base64')}`;
}

function fakeParse(value) {
  const match = /^test\$([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) return null;
  return { salt:Buffer.from('test-salt'), hash:Buffer.from(match[1], 'base64') };
}

function account(id, username, role = 'admin', password = username) {
  return { id, username, role, ah:fakeHash(password), pwChanged:true, totp:null };
}

function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-account-audit-'));
  let state = options.state || { settings:{ pwChanged:false }, meta:{} };
  let persists = 0;
  const service = createAccountService({
    fs,
    path,
    crypto,
    dataDir,
    getState:() => state,
    getSettings:() => state.settings || {},
    persistNow:() => { persists += 1; return options.persistResult !== false; },
    env:options.env || {},
    passwordHasher:fakeHash,
    passwordParser:fakeParse,
    now:() => 99,
    logger:{ log() {}, warn() {} },
  });
  return {
    dataDir,
    service,
    get state() { return state; },
    get persists() { return persists; },
    close() { fs.rmSync(dataDir, { recursive:true, force:true }); },
  };
}

test('ownerless non-empty stores fail closed unless a recoverable legacy credential exists', () => {
  const blocked = fixture({
    state:{ settings:{}, meta:{ accounts:[account('a1', 'helper')] } },
  });
  try {
    assert.throws(
      () => blocked.service.initialize(),
      /invalid-account-state:owner-credential-missing/,
    );
    assert.equal(blocked.persists, 0);
    assert.equal(blocked.state.meta.accounts.length, 1);
  } finally {
    blocked.close();
  }

  const repaired = fixture({
    state:{ settings:{ pwChanged:true }, meta:{ accounts:[account('a1', 'helper')] } },
  });
  fs.writeFileSync(path.join(repaired.dataDir, 'admin-password.txt'), 'legacy-owner');
  try {
    repaired.service.initialize();
    assert.equal(repaired.persists, 1);
    assert.equal(repaired.state.meta.accounts.length, 2);
    assert.equal(repaired.service.ownerAccount().ah, fakeHash('legacy-owner'));
    assert.equal(fs.existsSync(path.join(repaired.dataDir, 'admin-password.txt')), false);
  } finally {
    repaired.close();
  }
});

test('failed repair keeps the legacy credential and removes stale account fields only in live memory', () => {
  const owner = account('owner', 'owner', 'owner', 'stored');
  const f = fixture({
    state:{
      settings:{},
      meta:{
        accounts:[owner],
        ah:fakeHash('obsolete'),
        totp:{ secret:'LEGACY', enabled:true },
      },
    },
    persistResult:false,
  });
  const legacyFile = path.join(f.dataDir, 'admin-password.txt');
  fs.writeFileSync(legacyFile, 'recoverable');
  try {
    const status = f.service.initialize();
    assert.equal(status.durable, false);
    assert.equal(f.persists, 1);
    assert.deepEqual(owner.totp, { secret:'LEGACY', enabled:true });
    assert.equal(Object.hasOwn(f.state.meta, 'ah'), false);
    assert.equal(Object.hasOwn(f.state.meta, 'totp'), false);
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), 'recoverable');
  } finally {
    f.close();
  }
});

test('ADMIN_USERNAME is a non-persistent owner login alias and collisions are rejected', () => {
  const owner = account('owner', 'stored-owner', 'owner', 'stored');
  const f = fixture({
    state:{ settings:{}, meta:{ accounts:[owner, account('a1', 'helper')] } },
    env:{ ADMIN_USERNAME:'Runtime Owner', ADMIN_PASSWORD:'environment-secret' },
  });
  try {
    f.service.initialize();
    assert.equal(owner.username, 'stored-owner');
    assert.equal(f.persists, 0);
    assert.equal(f.service.findAccountByName('runtime owner'), owner);
    assert.equal(f.service.findAccountByName('stored-owner'), null);
    assert.equal(f.service.ownerLoginUsername(), 'Runtime Owner');

    // A detached object claiming the owner role must not receive the environment
    // credential record.
    const detached = account('detached', 'detached', 'owner', 'detached-secret');
    assert.equal(f.service.accountPasswordRecord(detached).hash.toString(), 'detached-secret');
  } finally {
    f.close();
  }

  const collision = fixture({
    state:{
      settings:{},
      meta:{ accounts:[account('owner', 'stored-owner', 'owner'), account('a1', 'runtime-owner')] },
    },
    env:{ ADMIN_USERNAME:'runtime-owner', ADMIN_PASSWORD:'environment-secret' },
  });
  try {
    assert.throws(
      () => collision.service.initialize(),
      /invalid-account-state:environment-username-conflict/,
    );
    assert.equal(collision.persists, 0);
  } finally {
    collision.close();
  }
});

test('duplicate ids, duplicate usernames and invalid password records are rejected at startup', () => {
  const cases = [
    {
      accounts:[account('same', 'owner', 'owner'), account('same', 'helper')],
      pattern:/duplicate-account-id/,
    },
    {
      accounts:[account('o', 'Owner', 'owner'), account('a', ' owner ')],
      pattern:/duplicate-account-username/,
    },
    {
      accounts:[{ ...account('o', 'owner', 'owner'), ah:'broken' }],
      pattern:/invalid-account-password/,
    },
  ];
  for (const item of cases) {
    const f = fixture({ state:{ settings:{}, meta:{ accounts:item.accounts } } });
    try { assert.throws(() => f.service.initialize(), item.pattern); }
    finally { f.close(); }
  }
});

test('restore preflight migrates a legacy owner and rejects backups that would remove owner access', () => {
  const f = fixture({ state:{ settings:{}, meta:{ accounts:[account('live', 'live', 'owner')] } } });
  try {
    f.service.initialize();
    const candidate = {
      settings:{ pwChanged:true },
      meta:{ ah:fakeHash('legacy'), totp:{ secret:'ABC', enabled:true } },
    };
    assert.strictEqual(f.service.prepareRestoredState(candidate), candidate);
    assert.equal(candidate.meta.accounts.length, 1);
    assert.equal(candidate.meta.accounts[0].ah, fakeHash('legacy'));
    assert.equal(candidate.meta.accounts[0].pwChanged, true);
    assert.deepEqual(candidate.meta.accounts[0].totp, { secret:'ABC', enabled:true });
    assert.equal(Object.hasOwn(candidate.meta, 'ah'), false);
    assert.equal(Object.hasOwn(candidate.meta, 'totp'), false);

    assert.throws(
      () => f.service.prepareRestoredState({ settings:{}, meta:{} }),
      /invalid-account-state:owner-credential-missing/,
    );
    assert.throws(
      () => f.service.prepareRestoredState({
        settings:{},
        meta:{ accounts:[account('o', 'same', 'owner'), account('a', 'SAME')] },
      }),
      /invalid-account-state:duplicate-account-username/,
    );
    assert.throws(
      () => f.service.prepareRestoredState({ settings:{}, meta:{ accounts:{} } }),
      /invalid-account-state:accounts-not-array/,
    );
  } finally {
    f.close();
  }
});

test('environment-managed restore repairs an unusable stored owner hash without persisting the secret', () => {
  const f = fixture({
    state:{ settings:{}, meta:{ accounts:[account('live', 'live', 'owner')] } },
    env:{ ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'environment-secret' },
  });
  try {
    f.service.initialize();
    const candidateOwner = { ...account('restored', 'restored', 'owner'), ah:'broken' };
    const candidate = { settings:{}, meta:{ accounts:[candidateOwner] } };
    f.service.prepareRestoredState(candidate);
    assert.ok(fakeParse(candidateOwner.ah));
    assert.notEqual(candidateOwner.ah, fakeHash('environment-secret'));
    assert.equal(
      f.service.accountPasswordRecord(candidateOwner).hash.toString(),
      fakeParse(candidateOwner.ah).hash.toString(),
    );
    // The environment override applies only after the candidate becomes live.
  } finally {
    f.close();
  }
});
