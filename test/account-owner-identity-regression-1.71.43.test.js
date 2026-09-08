'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createAccountService } = require('../lib/server/account-service');

function passwordHasher(value) {
  return `hash:${String(value)}`;
}
function passwordParser(value) {
  return typeof value === 'string' && value.startsWith('hash:')
    ? { salt:'test-salt', hash:'test-hash' }
    : null;
}
function missingLegacyPasswordFs() {
  return {
    readFileSync() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    unlinkSync() {},
  };
}
function createService(state, options = {}) {
  return createAccountService({
    fs:options.fs || missingLegacyPasswordFs(),
    path,
    crypto,
    dataDir:'/data',
    getState:() => state,
    getSettings:() => state.settings || {},
    persistNow:() => true,
    env:options.env || {},
    ASVS_L3_MODE:options.asvsL3Mode === true,
    passwordHasher,
    passwordParser,
    now:() => 1_800_000_000_000,
  });
}

test('compatibility migration preserves the implicit legacy admin username', () => {
  const state = { meta:{ ah:'hash:legacy-password' }, settings:{ pwChanged:true } };
  const service = createService(state);

  service.initialize();

  assert.equal(state.meta.accounts.length, 1);
  assert.equal(state.meta.accounts[0].username, 'admin');
  assert.equal(service.adminUsername, 'admin');
  assert.equal(service.ownerLoginUsername(), 'admin');
  assert.doesNotMatch(state.meta.accounts[0].username, /^owner-[0-9a-f]{12}$/);
});

test('legacy admin-password.txt migration also keeps admin instead of minting owner-*', () => {
  const state = { meta:{}, settings:{ pwChanged:true } };
  const fs = {
    readFileSync(file) {
      assert.equal(file, path.join('/data', 'admin-password.txt'));
      return 'legacy-plain-password';
    },
    unlinkSync() {},
  };
  const service = createService(state, { fs });

  service.initialize();

  assert.equal(state.meta.accounts[0].username, 'admin');
  assert.equal(service.adminUsername, 'admin');
});

test('normal fresh bootstrap keeps the historical admin identifier', () => {
  const state = { meta:{}, settings:{} };
  const service = createService(state);

  service.initialize();

  assert.equal(state.meta.accounts[0].username, 'admin');
  assert.equal(service.adminUsername, 'admin');
  assert.equal(service.hasFreshInitialPassword(), true);
});

test('ASVS L3 still randomizes a genuinely fresh owner bootstrap', () => {
  const state = { meta:{}, settings:{} };
  const service = createService(state, { asvsL3Mode:true });

  service.initialize();

  assert.match(state.meta.accounts[0].username, /^owner-[0-9a-f]{12}$/);
  assert.equal(service.adminUsername, state.meta.accounts[0].username);
});

test('an already persisted owner is never renamed during startup', () => {
  const state = {
    meta:{ accounts:[{
      id:'owner-id', username:'alice-admin', ah:'hash:existing', role:'owner',
      totp:null, pwChanged:true, createdAt:1, createdBy:'system', lastLoginAt:0,
    }] },
    settings:{ pwChanged:true },
  };
  const service = createService(state);

  service.initialize();

  assert.equal(state.meta.accounts[0].username, 'alice-admin');
  assert.equal(service.adminUsername, 'alice-admin');
  assert.equal(service.ownerLoginUsername(), 'alice-admin');
});

test('ADMIN_PASSWORD without ADMIN_USERNAME binds to the persisted owner identity', () => {
  const state = {
    meta:{ accounts:[{
      id:'owner-id', username:'existing-owner', ah:'hash:existing', role:'owner',
      totp:null, pwChanged:true, createdAt:1, createdBy:'system', lastLoginAt:0,
    }] },
    settings:{ pwChanged:true },
  };
  const service = createService(state, { env:{ ADMIN_PASSWORD:'managed-secret' } });

  service.initialize();

  assert.equal(service.adminUsername, 'existing-owner');
  assert.equal(service.ownerLoginUsername(), 'existing-owner');
  assert.equal(service.findAccountByName('existing-owner'), state.meta.accounts[0]);
});


test('ASVS L3 rejects an already-persisted predictable owner instead of renaming it', () => {
  const state = {
    meta:{ accounts:[{
      id:'owner-id', username:'admin', ah:'hash:existing', role:'owner',
      totp:null, pwChanged:true, createdAt:1, createdBy:'system', lastLoginAt:0,
    }] },
    settings:{ pwChanged:true },
  };
  const service = createService(state, { asvsL3Mode:true });

  assert.throws(
    () => service.initialize(),
    (error) => error && error.code === 'asvs-l3-predictable-admin-username'
  );
  assert.equal(state.meta.accounts[0].username, 'admin');
});

test('ASVS L3 refuses legacy predictable identity instead of silently renaming it', () => {
  const state = { meta:{ ah:'hash:legacy-password' }, settings:{ pwChanged:true } };
  const service = createService(state, { asvsL3Mode:true });

  assert.throws(
    () => service.initialize(),
    (error) => error && error.code === 'asvs-l3-predictable-admin-username'
  );
  assert.equal(state.meta.accounts, undefined);
});

test('legacy restore keeps the legacy admin identity in compatibility mode', () => {
  const state = { meta:{}, settings:{} };
  const service = createService(state);
  service.initialize();

  const restored = { meta:{ ah:'hash:restored-legacy' }, settings:{ pwChanged:true } };
  service.prepareRestoredState(restored);

  assert.equal(restored.meta.accounts[0].username, 'admin');
  assert.equal(restored.meta.ah, undefined);
});
