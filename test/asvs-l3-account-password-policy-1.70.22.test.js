'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAccountPassword,
} = require('../lib/auth-utils');
const { createAuthService } = require('../lib/server/auth-service');

test('ASVS V6.2.4 rejects obvious common passwords before breach lookup', async () => {
  let calls = 0;
  const result = await validateAccountPassword('password', {}, async () => {
    calls += 1;
    return { ok:true, breached:false };
  });
  assert.deepEqual(result, { ok:false, error:'password-common' });
  assert.equal(calls, 0);
});

test('ASVS V6.2.11 rejects passwords containing account or product context', async () => {
  let calls = 0;
  const checker = async () => { calls += 1; return { ok:true, breached:false }; };
  assert.deepEqual(
    await validateAccountPassword('Owner.User-2026!', { username:'owner.user' }, checker),
    { ok:false, error:'password-contextual' },
  );
  assert.deepEqual(
    await validateAccountPassword('Direct-Xfer-2026-Long!', {}, checker),
    { ok:false, error:'password-contextual' },
  );
  assert.equal(calls, 0);
});

test('ASVS V6.2.12 rejects breached passwords and fails closed when corpus lookup is unavailable', async () => {
  const breached = await validateAccountPassword('long-unrelated-passphrase-2026!', {}, async () => ({
    ok:true, breached:true, count:42,
  }));
  assert.equal(breached.ok, false);
  assert.equal(breached.error, 'password-breached');
  assert.equal(breached.breachCount, 42);

  assert.deepEqual(
    await validateAccountPassword('another-clean-looking-passphrase!', {}, async () => ({
      ok:false, error:'password-breach-check-unavailable',
    })),
    { ok:false, error:'password-breach-check-unavailable' },
  );

  assert.deepEqual(
    await validateAccountPassword('unique-clean-looking-passphrase!', {}, async () => ({ ok:true, breached:false })),
    { ok:true },
  );
});

function fakeRecord(label) {
  return { salt:Buffer.from('salt-' + label), hash:Buffer.from('hash-' + label), label };
}

function authFixture(policy) {
  const account = { id:'a1', username:'operator.one', role:'operator', ah:'old', pwChanged:true };
  const records = { old:fakeRecord('old'), dummy:fakeRecord('dummy') };
  let persists = 0;
  const service = createAuthService({
    getSettings:() => ({ maxLoginAttempts:5, lockoutMinutes:5, geoLookup:false }),
    findAccountByName:() => account,
    getAccountById:(id) => id === account.id ? account : null,
    accountPasswordRecord:(value) => records[value.ah] || null,
    dummyPasswordRecord:records.dummy,
    normalizeUsername:(value) => String(value || '').toLowerCase(),
    clientIp:() => '127.0.0.1',
    createSession:() => ({ sid:'sid', csrf:'csrf' }),
    scheduleFlush:() => {},
    persistNow:() => { persists += 1; return true; },
    logAudit:() => true,
    passwordHasher:async () => ({ ok:true, hash:'new-hash' }),
    passwordParser:(value) => records[value] || null,
    passwordVerifier:async () => ({ ok:true, match:true }),
    passwordPolicy:policy,
  });
  return { account, service, get persists() { return persists; } };
}

test('account password mutation enforces policy before hashing/persistence', async () => {
  let checkedContext = null;
  const denied = authFixture(async (plain, context) => {
    checkedContext = { plain, context };
    return { ok:false, error:'password-breached' };
  });
  const deniedResult = await denied.service.setAccountPassword(denied.account, 'candidate-password');
  assert.equal(deniedResult.error, 'password-breached');
  assert.equal(denied.account.ah, 'old');
  assert.equal(denied.persists, 0);
  assert.equal(checkedContext.context.username, 'operator.one');

  const allowed = authFixture(async () => ({ ok:true }));
  const accepted = await allowed.service.setAccountPassword(allowed.account, 'candidate-password');
  assert.equal(accepted.ok, true);
  assert.equal(allowed.account.ah, 'new-hash');
  assert.equal(allowed.account.pwChanged, true);
  assert.equal(Object.hasOwn(allowed.account, 'bootstrapPasswordExpiresAt'), false);
  assert.equal(allowed.persists, 1);
});

test('owner-issued temporary password receives a short persisted expiry', async () => {
  const fx = authFixture(async () => ({ ok:true }));
  const before = Date.now();
  const result = await fx.service.setAccountPassword(fx.account, 'temporary-password', { pwChanged:false });
  const after = Date.now();
  assert.equal(result.ok, true);
  assert.equal(fx.account.pwChanged, false);
  assert.ok(fx.account.bootstrapPasswordExpiresAt >= before + 15 * 60 * 1000);
  assert.ok(fx.account.bootstrapPasswordExpiresAt <= after + 15 * 60 * 1000);
});