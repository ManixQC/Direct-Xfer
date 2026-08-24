'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionService } = require('../lib/server/session-service');

function responseStub() {
  return { headers:{}, setHeader(name, value) { this.headers[name] = value; } };
}

test('ASVS V7.1.2 caps concurrent sessions per account and evicts the oldest', () => {
  const account = { id:'acct-1', username:'owner-a', role:'owner' };
  const closed = [];
  const service = createSessionService({
    getSettings:() => ({ sessionHours:8, sessionIdleMinutes:30, maxConcurrentSessions:2 }),
    getAccountById:(id) => id === account.id ? account : null,
    clientIp:() => '127.0.0.1',
    parseCookies:() => ({}),
    secureCookie:() => '',
    timingSafeEqualStr:(a, b) => String(a) === String(b),
    closeStreamsForSession:(sid) => closed.push(sid),
  });

  assert.equal(service.sessionMaxConcurrent(), 2);
  const first = service.createSession({ headers:{} }, responseStub(), account);
  const second = service.createSession({ headers:{} }, responseStub(), account);
  assert.equal(service.listSessions().length, 2);
  const third = service.createSession({ headers:{} }, responseStub(), account);

  const remaining = service.listSessions();
  assert.equal(remaining.length, 2);
  assert.equal(service.isSessionActive(first.sid), false);
  assert.equal(service.isSessionActive(second.sid), true);
  assert.equal(service.isSessionActive(third.sid), true);
  assert.deepEqual(closed, [first.sid]);
});

test('ASVS V7.1.2 default concurrent-session policy is bounded', () => {
  const account = { id:'acct-2', username:'admin-a', role:'admin' };
  const service = createSessionService({
    getSettings:() => ({}),
    getAccountById:(id) => id === account.id ? account : null,
    clientIp:() => '127.0.0.1',
    parseCookies:() => ({}),
    secureCookie:() => '',
    timingSafeEqualStr:(a, b) => String(a) === String(b),
  });
  assert.equal(service.sessionMaxConcurrent(), 10);
});
