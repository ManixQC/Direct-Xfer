'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSessionService } = require('../lib/server/session-service');

function parseCookies(req) {
  const out = {};
  for (const part of String(req && req.headers && req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function request(cookie = '') {
  return {
    method:'GET',
    protocol:'https',
    headers:{ cookie, 'user-agent':'ASVS test' },
    socket:{ remoteAddress:'127.0.0.1' },
  };
}

function response() {
  return {
    headers:{},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
  };
}

function service() {
  const account = { id:'a1', username:'owner', role:'owner' };
  const sessionService = createSessionService({
    getSettings:() => ({ sessionHours:1 }),
    getAccountById:(id) => id === account.id ? account : null,
    clientIp:(req) => req.socket.remoteAddress,
    parseCookies,
    secureCookie:() => '; Secure',
    timingSafeEqualStr:(a, b) => {
      const aa = Buffer.from(String(a));
      const bb = Buffer.from(String(b));
      return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    },
  });
  return { account, sessionService };
}

test('ASVS V3.3.3 HTTPS administrator sessions use __Host-sid', () => {
  const { account, sessionService } = service();
  const res = response();
  const created = sessionService.createSession(request(), res, account);
  const cookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
  const sessionCookie = cookies.find((value) => String(value).startsWith('__Host-sid='));
  assert.ok(sessionCookie);
  assert.match(sessionCookie, /; Secure(?:;|$)/);
  assert.match(sessionCookie, /; Path=\//);
  assert.doesNotMatch(sessionCookie, /; Domain=/i);
  assert.ok(cookies.some((value) => String(value).startsWith('sid=;')));

  const sid = created.sid;
  const read = sessionService.getSession(request(`__Host-sid=${sid}`));
  assert.equal(read && read.sid, sid);
});

test('HTTPS session migration accepts old sid once and rotates it to __Host-sid', () => {
  const { account, sessionService } = service();
  const firstRes = response();
  const first = sessionService.createSession(request(), firstRes, account);

  const secondRes = response();
  const second = sessionService.createSession(request(`sid=${first.sid}`), secondRes, account);
  assert.notEqual(second.sid, first.sid);
  assert.equal(sessionService.isSessionActive(first.sid), false);
  const cookies = Array.isArray(secondRes.headers['set-cookie']) ? secondRes.headers['set-cookie'] : [secondRes.headers['set-cookie']];
  assert.ok(cookies.some((value) => String(value).startsWith('__Host-sid=')));
  assert.ok(cookies.some((value) => String(value).startsWith('sid=;')));
});