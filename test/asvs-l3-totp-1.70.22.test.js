'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createAuthService } = require('../lib/server/auth-service');

function request(ip) {
  return {
    method: 'POST',
    headers: { 'user-agent': 'ASVS-L3 test client' },
    socket: { remoteAddress: ip },
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
  };
}

function totpAt(key, timestamp) {
  const counter = Math.floor(timestamp / 30000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(number % 1000000).padStart(6, '0');
}

function fixture() {
  const key = Buffer.alloc(20, 0x42);
  const passwordRecord = { salt: Buffer.from('salt-current'), hash: Buffer.from('hash-current') };
  const dummyRecord = { salt: Buffer.from('salt-dummy'), hash: Buffer.from('hash-dummy') };
  const sessions = [];
  const audits = [];
  let persisted = 0;
  let persistResult = true;

  let service;
  const account = {
    id: 'a1',
    username: 'owner',
    role: 'owner',
    ah: 'pw-v1',
    pwChanged: true,
    knownDevices: [],
    totp: null,
  };

  service = createAuthService({
    getSettings: () => ({ maxLoginAttempts: 5, lockoutMinutes: 5, geoLookup: false }),
    findAccountByName: (username) => String(username).toLowerCase() === 'owner' ? account : null,
    getAccountById: (id) => id === account.id ? account : null,
    accountPasswordRecord: () => passwordRecord,
    dummyPasswordRecord: dummyRecord,
    normalizeUsername: (value) => String(value || '').trim().toLowerCase(),
    clientIp: (req) => req.socket.remoteAddress,
    createSession: (_req, _res, acc) => {
      const session = { sid: `sid-${sessions.length + 1}`, csrf: `csrf-${sessions.length + 1}`, accountId: acc.id };
      sessions.push(session);
      return session;
    },
    scheduleFlush: () => {},
    persistNow: () => { persisted += 1; return persistResult; },
    logAudit: (action, data) => { audits.push({ action, data }); return true; },
    passwordVerifier: async (plain, record) => ({
      ok: true,
      match: record === passwordRecord && plain === 'correct-password',
    }),
    passwordHasher: async () => ({ ok: true, hash: 'unused' }),
    passwordParser: () => null,
  });

  account.totp = {
    secret: service.base32encode(key),
    enabled: true,
    recovery: [],
  };

  return {
    service,
    account,
    key,
    sessions,
    audits,
    persisted: () => persisted,
    setPersistResult(value) { persistResult = !!value; },
  };
}

test('ASVS v6.5.1: a successfully used TOTP counter cannot authenticate twice', async () => {
  const fx = fixture();
  const realNow = Date.now;
  let now = 1770000000000;
  Date.now = () => now;
  try {
    const code = totpAt(fx.key, now);
    const first = await fx.service.attemptLogin(
      request('10.0.0.1'), response(), 'owner', 'correct-password', code,
    );
    assert.equal(first.ok, true);
    assert.equal(fx.sessions.length, 1);
    assert.equal(fx.persisted(), 1, 'accepted TOTP counter must be persisted immediately');
    assert.equal(Number.isSafeInteger(fx.account.totp.lastCounter), true);

    const replay = await fx.service.attemptLogin(
      request('10.0.0.2'), response(), 'owner', 'correct-password', code,
    );
    assert.equal(replay.ok, false);
    assert.equal(replay.totpInvalid, true);
    assert.equal(fx.sessions.length, 1, 'replayed TOTP must not create a second session');
    assert.equal(fx.persisted(), 1, 'replay must not rewrite the accepted counter');
    assert.ok(fx.audits.some((entry) => entry.action === 'login-2fa-fail' && entry.data.detail === 'totp-replay'));
  } finally {
    Date.now = realNow;
  }
});

test('ASVS v6.5.5: TOTP authentication accepts only the current 30-second step', () => {
  const fx = fixture();
  const realNow = Date.now;
  let now = 1770000000000;
  Date.now = () => now;
  try {
    const code = totpAt(fx.key, now);
    assert.equal(fx.service.verifyTotp(fx.account.totp.secret, code), true);
    now += 30001;
    assert.equal(fx.service.verifyTotp(fx.account.totp.secret, code), false);
    const nextCode = totpAt(fx.key, now);
    assert.equal(fx.service.verifyTotp(fx.account.totp.secret, nextCode), true);
  } finally {
    Date.now = realNow;
  }
});

test('TOTP counter is rolled back when durable persistence fails', async () => {
  const fx = fixture();
  const realNow = Date.now;
  const now = 1770000000000;
  Date.now = () => now;
  try {
    const code = totpAt(fx.key, now);
    fx.setPersistResult(false);
    const failed = await fx.service.attemptLogin(
      request('10.0.0.3'), response(), 'owner', 'correct-password', code,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.busy, true);
    assert.equal(Object.hasOwn(fx.account.totp, 'lastCounter'), false);

    fx.setPersistResult(true);
    const retry = await fx.service.attemptLogin(
      request('10.0.0.4'), response(), 'owner', 'correct-password', code,
    );
    assert.equal(retry.ok, true);
    assert.equal(fx.sessions.length, 1);
  } finally {
    Date.now = realNow;
  }
});
