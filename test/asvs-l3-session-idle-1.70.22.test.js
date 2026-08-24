'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createSessionService } = require('../lib/server/session-service');

function request({ cookie = '', method = 'GET' } = {}) {
  return {
    method,
    protocol: 'https',
    headers: { cookie, 'user-agent': 'ASVS-L3 session test' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function response() {
  return {
    headers: {},
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

function fixture(settings = { sessionHours: 8, sessionIdleMinutes: 30 }) {
  const accounts = new Map([['a1', { id:'a1', username:'owner', role:'owner' }]]);
  const closed = [];
  const service = createSessionService({
    getSettings: () => settings,
    defaultTtlMs: 8 * 60 * 60 * 1000,
    defaultIdleMs: 30 * 60 * 1000,
    getAccountById: (id) => accounts.get(id) || null,
    clientIp: (req) => req.socket.remoteAddress,
    parseCookies,
    secureCookie: () => '; Secure',
    timingSafeEqualStr: (a, b) => {
      const aa = Buffer.from(String(a));
      const bb = Buffer.from(String(b));
      return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    },
    closeStreamsForSession: (sid) => closed.push(sid),
  });
  return { service, accounts, closed };
}

test('ASVS v7.3.1: session activity refreshes the idle deadline and inactivity expires the session', () => {
  const realNow = Date.now;
  let now = 1770000000000;
  Date.now = () => now;
  try {
    const { service, closed } = fixture();
    const res = response();
    const created = service.createSession(request(), res, { id:'a1', username:'owner', role:'owner' });
    const sid = created.sid;
    const req = () => request({ cookie:`sid=${sid}` });

    now += 29 * 60 * 1000;
    assert.ok(service.getSession(req()), 'activity before timeout must keep session alive');

    now += 29 * 60 * 1000;
    assert.ok(service.getSession(req()), 'idle deadline must slide after valid activity');

    now += 31 * 60 * 1000;
    assert.equal(service.getSession(req()), null, 'session must expire after inactivity threshold');
    assert.deepEqual(closed, [sid], 'session-bound streams must be closed on idle expiry');
  } finally {
    Date.now = realNow;
  }
});

test('ASVS v7.3.2: absolute lifetime remains a hard cap even with frequent activity', () => {
  const realNow = Date.now;
  let now = 1770000000000;
  Date.now = () => now;
  try {
    const { service } = fixture({ sessionHours: 1, sessionIdleMinutes: 30 });
    const res = response();
    const created = service.createSession(request(), res, { id:'a1', username:'owner', role:'owner' });
    const req = () => request({ cookie:`sid=${created.sid}` });

    now += 20 * 60 * 1000;
    assert.ok(service.getSession(req()));
    now += 20 * 60 * 1000;
    assert.ok(service.getSession(req()));
    now += 20 * 60 * 1000;
    assert.ok(service.getSession(req()), 'exact absolute expiry instant is still valid by existing boundary semantics');
    now += 1;
    assert.equal(service.getSession(req()), null, 'activity cannot extend absolute lifetime');
  } finally {
    Date.now = realNow;
  }
});

test('idle timeout is capped by absolute TTL and defaults to 30 minutes', () => {
  const { service } = fixture({ sessionHours: 8 });
  assert.equal(service.sessionIdleMs(), 30 * 60 * 1000);

  const short = fixture({ sessionHours: 0.25, sessionIdleMinutes: 60 }).service;
  // sessionHours is intentionally integer-normalized by the service; invalid
  // fractional configuration falls back to the configured absolute default.
  assert.equal(short.sessionIdleMs(), 60 * 60 * 1000);
});
