'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createSessionService } = require('../lib/server/session-service');
const { createAuthService } = require('../lib/server/auth-service');
const { hashPasswordSyncForStartup, parseHash } = require('../lib/auth-utils');

function request({ cookie = '', method = 'GET', csrf = '', ip = '127.0.0.1', ua = 'Test Browser' } = {}) {
  return {
    method,
    protocol: 'http',
    headers: {
      cookie,
      'user-agent': ua,
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    socket: { remoteAddress: ip },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function parseCookies(req) {
  const output = {};
  for (const piece of String(req.headers.cookie || '').split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    output[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
  }
  return output;
}

function sessionFixture() {
  const accounts = new Map([['a1', { id: 'a1', username: 'owner', role: 'owner' }]]);
  const closed = [];
  const service = createSessionService({
    getSettings: () => ({ sessionHours: 1 }),
    defaultTtlMs: 8 * 60 * 60 * 1000,
    getAccountById: (id) => accounts.get(id) || null,
    clientIp: (req) => req.socket.remoteAddress,
    parseCookies,
    secureCookie: () => '',
    timingSafeEqualStr: (a, b) => {
      const aa = Buffer.from(String(a));
      const bb = Buffer.from(String(b));
      return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    },
    closeStreamsForSession: (sid) => closed.push(sid),
  });
  return { service, accounts, closed };
}

test('session service owns cookies, expiry and CSRF validation', () => {
  const { service } = sessionFixture();
  const loginReq = request();
  const loginRes = response();
  const created = service.createSession(loginReq, loginRes, { id:'a1', username:'owner', role:'owner' });
  assert.equal(created.csrf.length, 64);
  assert.match(loginRes.headers['set-cookie'], /^sid=[0-9a-f]{64};/);

  const sid = /sid=([0-9a-f]{64})/.exec(loginRes.headers['set-cookie'])[1];
  const getReq = request({ cookie:`sid=${sid}`, method:'GET' });
  const getRes = response();
  let nextCalls = 0;
  service.requireAuth(getReq, getRes, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(getReq.session.accountId, 'a1');

  const badPost = request({ cookie:`sid=${sid}`, method:'POST', csrf:'wrong' });
  const badRes = response();
  service.requireAuth(badPost, badRes, () => { throw new Error('must not pass'); });
  assert.equal(badRes.statusCode, 403);
  assert.deepEqual(badRes.body, { error:'invalid-csrf' });

  const goodPost = request({ cookie:`sid=${sid}`, method:'POST', csrf:created.csrf });
  const goodRes = response();
  service.requireAuth(goodPost, goodRes, () => { nextCalls += 1; });
  assert.equal(nextCalls, 2);
});

test('deleted accounts invalidate their sessions and session internals are not exposed', () => {
  const { service, accounts, closed } = sessionFixture();
  const res = response();
  const created = service.createSession(request(), res, { id:'a1', username:'owner', role:'owner' });
  const sid = /sid=([0-9a-f]{64})/.exec(res.headers['set-cookie'])[1];
  const listed = service.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sid, sid);
  assert.equal(Object.hasOwn(listed[0], 'csrf'), false); // CSRF secrets stay inside the session service

  accounts.delete('a1');
  assert.equal(service.getSession(request({ cookie:`sid=${sid}` })), null);
  assert.deepEqual(closed, [sid]);
  assert.equal(service.isSessionActive(sid, ['owner']), false);
  assert.equal(created.sid, sid);
});

test('auth service locks repeated failures and delegates successful session creation', async () => {
  const passwordHash = hashPasswordSyncForStartup('correct-password');
  const dummyHash = hashPasswordSyncForStartup('dummy-password');
  const account = {
    id:'a1', username:'owner', role:'owner', ah:passwordHash, pwChanged:true, knownDevices:[], totp:null,
  };
  const sessions = [];
  const audits = [];
  let persisted = 0;
  const service = createAuthService({
    getSettings: () => ({ maxLoginAttempts:2, lockoutMinutes:1, geoLookup:false }),
    findAccountByName: (username) => String(username).toLowerCase() === 'owner' ? account : null,
    getAccountById: (id) => id === account.id ? account : null,
    accountPasswordRecord: (acc) => parseHash(acc.ah),
    dummyPasswordRecord: parseHash(dummyHash),
    normalizeUsername: (value) => String(value || '').trim().toLowerCase(),
    clientIp: (req) => req.socket.remoteAddress,
    createSession: (req, res, acc) => { const value={ sid:'sid-1', csrf:'csrf-1', accountId:acc.id }; sessions.push(value); return value; },
    scheduleFlush: () => {},
    persistNow: () => { persisted += 1; return true; },
    logAudit: (action, data) => { audits.push({ action, data }); return true; },
    failWindowMs: 5 * 60 * 1000,
  });

  const req = request({ ip:'10.0.0.9' });
  const res = response();
  const first = await service.attemptLogin(req, res, 'owner', 'wrong', '');
  assert.equal(first.ok, false);
  assert.equal(first.locked, false);
  const second = await service.attemptLogin(req, res, 'owner', 'wrong', '');
  assert.equal(second.locked, true);
  const third = await service.attemptLogin(req, res, 'owner', 'correct-password', '');
  assert.equal(third.locked, true);
  assert.ok(third.retryAfter > 0);
  assert.equal(sessions.length, 0);
  assert.equal(service.lockedLoginIps().length, 1);
  assert.equal(audits.filter((entry) => entry.action === 'login-fail').length, 2);

  const otherReq = request({ ip:'10.0.0.10' });
  const ok = await service.attemptLogin(otherReq, res, 'owner', 'correct-password', '');
  assert.equal(ok.ok, true);
  assert.equal(ok.sid, 'sid-1');
  assert.equal(sessions.length, 1);
  assert.equal(account.lastLoginAt > 0, true);
  assert.equal(persisted, 0);
});


test('session login rotates the prior sid and refreshes authorization from the current account', () => {
  const { service, accounts, closed } = sessionFixture();
  const firstRes = response();
  const first = service.createSession(request(), firstRes, accounts.get('a1'));
  const firstSid = /sid=([0-9a-f]{64})/.exec(firstRes.headers['set-cookie'])[1];

  const secondRes = response();
  const second = service.createSession(request({ cookie:`sid=${firstSid}` }), secondRes, accounts.get('a1'));
  assert.notEqual(second.sid, first.sid);
  assert.equal(service.getSession(request({ cookie:`sid=${firstSid}` })), null);
  assert.ok(closed.includes(firstSid));

  const account = accounts.get('a1');
  account.role = 'auditor';
  account.username = 'renamed';
  const refreshed = service.getSession(request({ cookie:`sid=${second.sid}` }));
  assert.equal(refreshed.role, 'auditor');
  assert.equal(refreshed.username, 'renamed');
  assert.equal(service.isSessionActive(second.sid, ['owner']), false);
  assert.equal(service.isSessionActive(second.sid, ['auditor']), true);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fakePasswordRecord(label) {
  return {
    salt: Buffer.from(`salt-${label}`),
    hash: Buffer.from(`hash-${label}`),
    label,
  };
}

function controlledAuthFixture({ maxLoginAttempts = 5, totp = null } = {}) {
  const account = {
    id:'a1', username:'owner', role:'owner', ah:'pw-v1', pwChanged:true, knownDevices:[], totp,
  };
  const sessions = [];
  const audits = [];
  const records = {
    'pw-v1': fakePasswordRecord('pw-v1'),
    'pw-v2': fakePasswordRecord('pw-v2'),
    dummy: fakePasswordRecord('dummy'),
    recovery1: fakePasswordRecord('recovery1'),
    recovery2: fakePasswordRecord('recovery2'),
  };
  const parser = (value) => records[value] || null;
  const serviceOptions = {
    getSettings: () => ({ maxLoginAttempts, lockoutMinutes:1, geoLookup:false }),
    findAccountByName: (username) => String(username).toLowerCase() === account.username ? account : null,
    getAccountById: (id) => id === account.id ? account : null,
    accountPasswordRecord: (acc) => records[acc.ah] || null,
    dummyPasswordRecord: records.dummy,
    normalizeUsername: (value) => String(value || '').trim().toLowerCase(),
    clientIp: (req) => req.socket.remoteAddress,
    createSession: (req, res, acc) => { const value={ sid:`sid-${sessions.length+1}`, csrf:`csrf-${sessions.length+1}`, accountId:acc.id }; sessions.push(value); return value; },
    scheduleFlush: () => {},
    persistNow: () => true,
    logAudit: (action, data) => { audits.push({ action, data }); return true; },
    passwordParser: parser,
  };
  return { account, sessions, audits, records, serviceOptions };
}

test('concurrent login from one IP is rejected before a second password verification can bypass lockout state', async () => {
  const fx = controlledAuthFixture({ maxLoginAttempts:2 });
  const firstCheck = deferred();
  let verifierCalls = 0;
  fx.serviceOptions.passwordVerifier = async () => {
    verifierCalls += 1;
    if (verifierCalls === 1) return firstCheck.promise;
    return { ok:true, match:false };
  };
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'unused' });
  const service = createAuthService(fx.serviceOptions);
  const req = request({ ip:'10.0.0.20' });

  const first = service.attemptLogin(req, response(), 'owner', 'wrong', '');
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await service.attemptLogin(req, response(), 'owner', 'wrong', '');
  assert.equal(concurrent.busy, true);
  assert.equal(verifierCalls, 1);

  firstCheck.resolve({ ok:true, match:false });
  const firstResult = await first;
  assert.equal(firstResult.locked, false);
  const secondResult = await service.attemptLogin(req, response(), 'owner', 'wrong', '');
  assert.equal(secondResult.locked, true);
});

test('password reset or username change while scrypt is pending cannot grant a stale login', async () => {
  const fx = controlledAuthFixture();
  const pending = deferred();
  fx.serviceOptions.passwordVerifier = async (plain, rec) => {
    if (rec.label === 'pw-v1') return pending.promise;
    return { ok:true, match:false };
  };
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'unused' });
  const service = createAuthService(fx.serviceOptions);
  const login = service.attemptLogin(request({ ip:'10.0.0.21' }), response(), 'owner', 'correct', '');
  await new Promise((resolve) => setImmediate(resolve));

  fx.account.ah = 'pw-v2';
  pending.resolve({ ok:true, match:true });
  const result = await login;
  assert.equal(result.ok, false);
  assert.equal(fx.sessions.length, 0);
  assert.equal(fx.audits.some((entry) => entry.data && entry.data.detail === 'credential-changed'), true);
});

test('one-time recovery code cannot be accepted twice by concurrent logins from different IPs', async () => {
  const fx = controlledAuthFixture({
    totp: { enabled:true, secret:'JBSWY3DPEHPK3PXP', recovery:['recovery1','recovery2'] },
  });
  const recoveryChecks = [];
  fx.serviceOptions.passwordVerifier = async (plain, rec) => {
    if (rec.label === 'pw-v1') return { ok:true, match:true };
    if (rec.label === 'recovery1') {
      const d = deferred();
      recoveryChecks.push(d);
      return d.promise;
    }
    return { ok:true, match:false };
  };
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'unused' });
  const service = createAuthService(fx.serviceOptions);

  const a = service.attemptLogin(request({ ip:'10.0.0.30' }), response(), 'owner', 'correct', 'aaaaaaaaaa');
  const b = service.attemptLogin(request({ ip:'10.0.0.31' }), response(), 'owner', 'correct', 'aaaaaaaaaa');
  while (recoveryChecks.length < 2) await new Promise((resolve) => setImmediate(resolve));
  recoveryChecks[0].resolve({ ok:true, match:true });
  recoveryChecks[1].resolve({ ok:true, match:true });
  const results = await Promise.all([a, b]);

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.totpInvalid).length, 1);
  assert.deepEqual(fx.account.totp.recovery, ['recovery2']);
  assert.equal(fx.sessions.length, 1);
});


test('password mutation cannot overwrite a credential changed while hashing or after authorization revocation', async () => {
  const fx = controlledAuthFixture();
  const hashPending = deferred();
  fx.serviceOptions.passwordVerifier = async () => ({ ok:true, match:true });
  fx.serviceOptions.passwordHasher = async () => hashPending.promise;
  const service = createAuthService(fx.serviceOptions);

  const changing = service.setAccountPassword(fx.account, 'new-password');
  await new Promise((resolve) => setImmediate(resolve));
  fx.account.ah = 'pw-v2';
  hashPending.resolve({ ok:true, hash:'new-hash' });
  const changed = await changing;
  assert.equal(changed.error, 'account-changed');
  assert.equal(fx.account.ah, 'pw-v2');

  fx.account.ah = 'pw-v1';
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'new-hash-2' });
  const guarded = createAuthService(fx.serviceOptions);
  const denied = await guarded.setAccountPassword(fx.account, 'new-password', {
    beforeCommit: () => false,
  });
  assert.equal(denied.error, 'not-authorized');
  assert.equal(fx.account.ah, 'pw-v1');
});


test('local/admin password reset can repair an unparseable stored hash without weakening race checks', async () => {
  const fx = controlledAuthFixture();
  fx.account.ah = 'corrupt-hash';
  fx.serviceOptions.passwordVerifier = async () => ({ ok:true, match:false });
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'repaired-hash' });
  const service = createAuthService(fx.serviceOptions);
  const result = await service.setAccountPassword(fx.account, 'replacement', { pwChanged:false });
  assert.equal(result.ok, true);
  assert.equal(fx.account.ah, 'repaired-hash');
  assert.equal(fx.account.pwChanged, false);
});


test('concurrent recovery-code consumption does not skip a different valid code after array compaction', async () => {
  const fx = controlledAuthFixture({
    totp: { enabled:true, secret:'JBSWY3DPEHPK3PXP', recovery:['recovery1','recovery2'] },
  });
  const slowFirstForB = deferred();
  let bReachedFirst = false;
  fx.serviceOptions.passwordVerifier = async (plain, rec) => {
    if (rec.label === 'pw-v1') return { ok:true, match:true };
    if (rec.label === 'recovery1' && plain === 'bbbbbbbbbb') {
      bReachedFirst = true;
      return slowFirstForB.promise;
    }
    if (rec.label === 'recovery1' && plain === 'aaaaaaaaaa') return { ok:true, match:true };
    if (rec.label === 'recovery2' && plain === 'bbbbbbbbbb') return { ok:true, match:true };
    return { ok:true, match:false };
  };
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'unused' });
  const service = createAuthService(fx.serviceOptions);

  const b = service.attemptLogin(request({ ip:'10.0.0.41' }), response(), 'owner', 'correct', 'bbbbbbbbbb');
  while (!bReachedFirst) await new Promise((resolve) => setImmediate(resolve));
  const a = await service.attemptLogin(request({ ip:'10.0.0.40' }), response(), 'owner', 'correct', 'aaaaaaaaaa');
  assert.equal(a.ok, true);
  slowFirstForB.resolve({ ok:true, match:false });
  const bResult = await b;

  assert.equal(bResult.ok, true);
  assert.deepEqual(fx.account.totp.recovery, []);
  assert.equal(fx.sessions.length, 2);
});


test('session authorization fails closed when a persisted account role becomes invalid', () => {
  const { service, accounts, closed } = sessionFixture();
  const res = response();
  const created = service.createSession(request(), res, accounts.get('a1'));
  accounts.get('a1').role = 'unexpected-role';

  assert.equal(service.getSession(request({ cookie:`sid=${created.sid}` })), null);
  assert.ok(closed.includes(created.sid));
  assert.equal(service.isSessionActive(created.sid), false);
});

test('password compare-and-swap rejects a stale current-password authorization', async () => {
  const fx = controlledAuthFixture();
  fx.serviceOptions.passwordVerifier = async () => ({ ok:true, match:true });
  fx.serviceOptions.passwordHasher = async () => ({ ok:true, hash:'new-hash' });
  const service = createAuthService(fx.serviceOptions);

  const verified = await service.verifyCurrentPassword(fx.account, 'correct');
  assert.equal(verified.match, true);
  assert.equal(verified.credentialHash, 'pw-v1');

  // Another authorized request changes the password before this request commits.
  fx.account.ah = 'pw-v2';
  const stale = await service.setAccountPassword(fx.account, 'replacement', {
    expectedHash: verified.credentialHash,
  });
  assert.equal(stale.error, 'account-changed');
  assert.equal(fx.account.ah, 'pw-v2');
});
