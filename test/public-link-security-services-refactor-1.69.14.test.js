'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createPublicAccessService,
} = require('../lib/server/public-access-service');
const {
  createPublicAbuseService,
} = require('../lib/server/public-abuse-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function parseCookies(req) {
  const out = {};
  const header = String((req.headers && req.headers.cookie) || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function accessFixture(extra = {}) {
  const service = createPublicAccessService({
    crypto,
    clientIp:(req) => req.ip || '203.0.113.10',
    geoSync:() => null,
    geolocate:async() => ({ countryCode:'CA' }),
    hashPassword:async(password) => ({ ok:true, hash:'scrypt:' + password }),
    parseHash:(value) => String(value || '').startsWith('scrypt:') ? { hash:value } : null,
    verifyPassword:async(password, record) => ({ ok:true, match:record.hash === 'scrypt:' + password }),
    parseCookies,
    secureCookie:(req) => req.protocol === 'https' ? '; Secure' : '',
    timingSafeEqualStr:(a, b) => String(a) === String(b),
    linkPrefix:(share) => share.type === 'inbox' ? '/u/' : '/s/',
    isLoopback:(ip) => ip === '127.0.0.1',
    isPrivateIp:(ip) => ip.startsWith('10.'),
    parseIpList:(value) => String(value || '').split(',').filter(Boolean),
    ipInList:(ip, list) => list.includes(ip),
    errorPage:(_lang, _code, message) => message,
    pickLang:() => 'en',
    unlockMaxFails:2,
    failWindowMs:60000,
    ...extra,
  });
  return service;
}

function response() {
  return {
    statusCode:200,
    headers:{},
    body:null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
}

test('public access service owns IP/country rules and restored country codes are compared case-insensitively', async () => {
  const service = accessFixture();
  const req = { ip:'203.0.113.10', headers:{} };

  assert.equal(await service.linkAccessReason(req, { ipMode:'deny', ipList:['203.0.113.10'] }), 'ip');
  assert.equal(await service.linkAccessReason(req, { ipMode:'allow', ipList:['198.51.100.1'] }), 'ip');
  assert.equal(await service.linkAccessReason(req, { geoMode:'allow', geoCountries:['ca'] }), null);
  assert.equal(await service.linkAccessReason(req, { geoMode:'deny', geoCountries:['CA'] }), 'geo');
  assert.equal(await service.linkAccessReason({ ip:'10.0.0.5', headers:{} }, { geoMode:'allow', geoCountries:['US'] }), null);
  assert.equal(await service.linkAccessReason({ ip:'127.0.0.1', headers:{} }, { ipMode:'deny', ipList:['127.0.0.1'] }), null);
});

test('public access service owns password verification, unlock cookies and request approval cookies', async () => {
  const service = accessFixture();
  const share = { token:'abc', type:'file', pwHash:'scrypt:secret', accessRequests:[{ id:'req1', status:'approved' }] };
  assert.deepEqual(await service.checkSharePassword(share, 'secret'), { ok:true, match:true });
  assert.deepEqual(await service.checkSharePassword(share, 'wrong'), { ok:true, match:false });

  const unlockRes = response();
  service.setUnlockCookie({ protocol:'https', headers:{} }, unlockRes, share);
  const unlockHeader = String(unlockRes.headers['set-cookie']);
  assert.match(unlockHeader, /^dxu_abc=/);
  assert.match(unlockHeader, /HttpOnly/);
  assert.match(unlockHeader, /SameSite=Lax/);
  assert.match(unlockHeader, /; Secure$/);
  const unlockPair = unlockHeader.split(';', 1)[0];
  assert.equal(service.isUnlocked({ headers:{ cookie:unlockPair } }, share), true);
  assert.equal(service.isUnlocked({ headers:{ cookie:unlockPair } }, { ...share, pwHash:'scrypt:changed' }), false);

  const accessRes = response();
  service.setAccessRequestCookie({ protocol:'http', headers:{} }, accessRes, share, 'req1');
  const accessPair = String(accessRes.headers['set-cookie']).split(';', 1)[0];
  const req = { headers:{ cookie:accessPair } };
  assert.equal(service.pendingAccessRequest(req, share).id, 'req1');
  assert.equal(service.isAccessApproved(req, share), true);
});

test('public access service serializes password work per IP and owns lockout state', () => {
  const service = accessFixture();
  const req = { ip:'203.0.113.77', headers:{} };
  const first = service.beginUnlockAttempt(req, 1000);
  assert.equal(first.ok, true);
  const concurrent = service.beginUnlockAttempt(req, 1000);
  assert.deepEqual({ ok:concurrent.ok, reason:concurrent.reason }, { ok:false, reason:'busy' });

  const fail1 = service.noteUnlockFailure(first, 30000, 1100);
  assert.equal(fail1.failedCount, 1);
  assert.equal(fail1.locked, false);
  service.finishUnlockAttempt(first);

  const second = service.beginUnlockAttempt(req, 1200);
  const fail2 = service.noteUnlockFailure(second, 30000, 1300);
  assert.equal(fail2.failedCount, 2);
  assert.equal(fail2.locked, true);
  service.finishUnlockAttempt(second);

  const locked = service.beginUnlockAttempt(req, 1400);
  assert.deepEqual({ ok:locked.ok, reason:locked.reason }, { ok:false, reason:'locked' });
  assert.ok(service.unlockFails.get(req.ip).lockUntil > 1400);
});

test('public abuse service owns message dedupe, rollback and public transfer rate limiting', () => {
  let settings = { publicRateLimit:true, publicRateWindowMin:1, publicRateMax:2, challengeEnabled:false };
  const service = createPublicAbuseService({
    crypto,
    clientIp:(req) => req.ip,
    getSettings:() => settings,
    maskIp:(ip) => ip,
    parseCookies,
    secureCookie:() => '',
    timingSafeEqualStr:(a, b) => String(a) === String(b),
    cleanupIntervalMs:600000,
  });
  try {
    const req = { ip:'203.0.113.8', headers:{} };
    assert.equal(service.publicRateRetryAfter(req), 0);
    assert.equal(service.publicRateRetryAfter(req), 0);
    assert.ok(service.publicRateRetryAfter(req) >= 1);

    const snapshot = service.snapshotPublicMessageDecision(req, 'tok');
    const first = service.publicMessageDecision(req, 'tok', 'hello', 'feedback');
    assert.equal(first.duplicate, false);
    const duplicate = service.publicMessageDecision(req, 'tok', 'hello', 'feedback');
    assert.equal(duplicate.duplicate, true);
    service.restorePublicMessageDecision(snapshot);
    const afterRollback = service.publicMessageDecision(req, 'tok', 'hello', 'feedback');
    assert.equal(afterRollback.duplicate, false);

    settings = { ...settings, publicRateLimit:false };
    assert.equal(service.publicRateRetryAfter(req), 0);
  } finally {
    service.close();
  }
});

test('public abuse service owns proof-of-work signing, pass cookies and challenge thresholds', () => {
  let settings = { challengeEnabled:true, challengeBits:8, challengeMinMB:1, publicRateLimit:false };
  const service = createPublicAbuseService({
    crypto,
    clientIp:(req) => req.ip,
    getSettings:() => settings,
    maskIp:(ip) => ip,
    parseCookies,
    secureCookie:(req) => req.protocol === 'https' ? '; Secure' : '',
    timingSafeEqualStr:(a, b) => String(a) === String(b),
    challengePage:() => 'challenge',
    pickLang:() => 'en',
    cleanupIntervalMs:600000,
  });
  try {
    const req = { ip:'203.0.113.9', protocol:'https', method:'GET', headers:{} };
    assert.equal(service.powBits(), 8);
    assert.equal(service.challengeRequired(1024 * 1024), true);
    assert.equal(service.challengeRequired(1024), false);

    const res = response();
    service.issuePowCookie(req, res);
    const cookie = String(res.headers['set-cookie']).split(';', 1)[0];
    assert.equal(service.hasValidPow({ ...req, headers:{ cookie } }), true);
    assert.equal(service.hasValidPow({ ...req, ip:'198.51.100.2', headers:{ cookie } }), false);

    settings = { ...settings, challengeEnabled:false };
    assert.equal(service.challengeGateZip(req, response()), false);
  } finally {
    service.close();
  }
});

test('server.js composes public access/abuse services instead of retaining their implementation', () => {
  const server = read('server.js');
  const securityAuth = read('lib/server/security-auth-application.js');
  const publicHttp = read('lib/server/public-http-application.js');
  const access = read('lib/server/public-access-service.js');
  const abuse = read('lib/server/public-abuse-service.js');

  assert.match(server, /createSecurityAuthApplication\(\{/);
  assert.match(server, /createPublicHttpApplication\(\{/);
  assert.match(publicHttp, /securityAuthApplication\.initializePublicSecurity/);
  assert.doesNotMatch(server, /createPublicAccessService\(\{/);
  assert.doesNotMatch(server, /createPublicAbuseService\(\{/);
  assert.match(securityAuth, /createPublicAccessService\(\{/);
  assert.match(securityAuth, /createPublicAbuseService\(\{/);
  assert.doesNotMatch(server, /^function hasAccessRules\(/m);
  assert.doesNotMatch(server, /^async function linkAccessReason\(/m);
  assert.doesNotMatch(server, /^async function checkSharePassword\(/m);
  assert.doesNotMatch(server, /^function isUnlocked\(/m);
  assert.doesNotMatch(server, /^function publicRateRetryAfter\(/m);
  assert.doesNotMatch(server, /^function powSolutionOk\(/m);
  assert.match(access, /function beginUnlockAttempt\(/);
  assert.match(access, /function setAccessRequestCookie\(/);
  assert.match(abuse, /function publicMessageDecision\(/);
  assert.match(abuse, /function challengeGateZip\(/);
  assert.ok(server.split('\n').length < 4100, 'public security extraction should materially reduce server.js');
});
