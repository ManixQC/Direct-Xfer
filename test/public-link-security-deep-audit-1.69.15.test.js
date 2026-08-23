'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPublicAccessService } = require('../lib/server/public-access-service');
const { createPublicAbuseService } = require('../lib/server/public-abuse-service');

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

function response(initialCookie) {
  const headers = {};
  if (initialCookie !== undefined) headers['set-cookie'] = initialCookie;
  return {
    statusCode:200,
    headers,
    body:null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function accessService(extra = {}) {
  return createPublicAccessService({
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
}

function abuseService(extra = {}) {
  return createPublicAbuseService({
    crypto,
    clientIp:(req) => req.ip || '203.0.113.20',
    getSettings:() => ({
      publicRateLimit:true,
      publicRateWindowMin:1,
      publicRateMax:1000,
      challengeEnabled:true,
      challengeBits:8,
      challengeMinMB:1,
    }),
    maskIp:(ip) => ip,
    parseCookies,
    secureCookie:(req) => req.protocol === 'https' ? '; Secure' : '',
    timingSafeEqualStr:(a, b) => String(a) === String(b),
    challengePage:() => 'challenge',
    pickLang:() => 'en',
    cleanupIntervalMs:600000,
    ...extra,
  });
}

test('empty public allowlists fail closed and malformed deny lists do not become restrictions', async () => {
  const service = accessService();
  const req = { ip:'203.0.113.10', headers:{} };

  assert.equal(service.hasAccessRules({ ipMode:'allow', ipList:[] }), true);
  assert.equal(await service.linkAccessReason(req, { ipMode:'allow', ipList:[] }), 'ip');
  assert.equal(service.hasAccessRules({ geoMode:'ALLOW', geoCountries:[] }), true);
  assert.equal(await service.linkAccessReason(req, { geoMode:'ALLOW', geoCountries:[] }), 'geo');

  const share = {};
  service.applyAccessRules(share, { geoMode:'allow', geoCountries:'CANADA, ca, US, ca' });
  assert.deepEqual(share.geoCountries, ['CA', 'US']);
  service.applyAccessRules(share, { geoMode:'deny', geoCountries:'' });
  assert.equal(Object.hasOwn(share, 'geoMode'), false);
  assert.equal(Object.hasOwn(share, 'geoCountries'), false);

  service.applyAccessRules(share, { ipMode:'allow', ipList:'' });
  assert.deepEqual({ mode:share.ipMode, list:share.ipList }, { mode:'allow', list:[] });
  assert.equal(await service.linkAccessReason(req, share), 'ip');
  service.applyAccessRules(share, { ipMode:'deny', ipList:'' });
  assert.equal(Object.hasOwn(share, 'ipMode'), false);
});

test('IP allowlists fail closed if restored rule parsing throws, while denylists stay best-effort', async () => {
  const service = accessService({ parseIpList:() => { throw new Error('corrupt-rule'); } });
  const req = { ip:'203.0.113.10', headers:{} };
  assert.equal(await service.linkAccessReason(req, { ipMode:'allow', ipList:['203.0.113.10'] }), 'ip');
  assert.equal(await service.linkAccessReason(req, { ipMode:'deny', ipList:['203.0.113.10'] }), null);
});

test('security cookies append instead of overwriting an existing language/session cookie', () => {
  const access = accessService();
  const share = { token:'abc', type:'file', pwHash:'scrypt:secret', accessRequests:[] };
  const res = response('lang=fr; Path=/; SameSite=Lax');
  access.setUnlockCookie({ protocol:'https', headers:{} }, res, share);
  access.setAccessRequestCookie({ protocol:'https', headers:{} }, res, share, 'req1');
  assert.ok(Array.isArray(res.headers['set-cookie']));
  assert.equal(res.headers['set-cookie'].length, 3);
  assert.match(res.headers['set-cookie'][0], /^lang=fr/);
  assert.match(res.headers['set-cookie'][1], /^dxu_abc=/);
  assert.match(res.headers['set-cookie'][2], /^dxreq_abc=req1/);

  const abuse = abuseService();
  try {
    const powRes = response('lang=en; Path=/; SameSite=Lax');
    abuse.issuePowCookie({ ip:'203.0.113.20', protocol:'https', headers:{} }, powRes, 1700000000000);
    assert.ok(Array.isArray(powRes.headers['set-cookie']));
    assert.equal(powRes.headers['set-cookie'].length, 2);
    assert.match(powRes.headers['set-cookie'][1], /^dxpow=/);
  } finally { abuse.close(); }
});

test('unlock work has a global in-flight ceiling in addition to per-IP serialization', () => {
  const service = accessService({ maxUnlockInFlight:1 });
  const first = service.beginUnlockAttempt({ ip:'203.0.113.1', headers:{} }, 1000);
  assert.equal(first.ok, true);
  const saturated = service.beginUnlockAttempt({ ip:'203.0.113.2', headers:{} }, 1000);
  assert.deepEqual(
    { ok:saturated.ok, reason:saturated.reason, retryAfter:saturated.retryAfter },
    { ok:false, reason:'capacity', retryAfter:1 },
  );
  service.finishUnlockAttempt(first);
  assert.equal(service.beginUnlockAttempt({ ip:'203.0.113.2', headers:{} }, 1001).ok, true);
});

test('public anti-abuse maps fail closed at their configured memory bounds', () => {
  const service = abuseService({ maxPublicRateEntries:100, maxPublicMessageEntries:100 });
  try {
    for (let i = 0; i < 100; i += 1) {
      assert.equal(service.publicRateRetryAfter({ ip:`198.51.100.${i}`, headers:{} }), 0);
      const decision = service.publicMessageDecision({ ip:`203.0.113.${i}`, headers:{} }, 'tok', `m${i}`, 'feedback');
      assert.equal(decision.retryAfter, 0);
    }
    assert.equal(service.publicRateRetryAfter({ ip:'192.0.2.250', headers:{} }), 1);
    const overloaded = service.publicMessageDecision({ ip:'192.0.2.251', headers:{} }, 'tok', 'new', 'feedback');
    assert.equal(overloaded.overloaded, true);
    assert.equal(overloaded.retryAfter, 1);
  } finally { service.close(); }
});

test('proof-of-work verification is fully service-owned, validates fields and preserves numeric solution zero', () => {
  const service = abuseService();
  try {
    const req = { ip:'203.0.113.20', headers:{} };
    const now = 1700000000000;
    let nonce = '';
    for (let i = 0; i < 100000; i += 1) {
      const candidate = i.toString(16).padStart(32, '0');
      if (service.powSolutionOk(candidate, '0', 8)) { nonce = candidate; break; }
    }
    assert.ok(nonce, 'expected to find an 8-bit solution for numeric zero');
    const exp = String(now + 60000);
    const bits = '8';
    const sig = service.powSign([nonce, exp, bits, service.powIpKey(req)]);
    assert.deepEqual(service.verifyPowChallenge(req, { nonce, exp, bits, sig, sol:0 }, now), { ok:true });
    assert.deepEqual(service.verifyPowChallenge(req, { nonce, exp:'NaN', bits, sig, sol:0 }, now), { ok:false, error:'bad-request' });
    assert.deepEqual(service.verifyPowChallenge(req, { nonce, exp, bits:'7', sig, sol:0 }, now), { ok:false, error:'bad-request' });

    const challenge = service.createPowChallenge(req, now);
    assert.match(challenge.nonce, /^[0-9a-f]{32}$/);
    assert.equal(challenge.bits, 8);
    assert.equal(challenge.exp, now + 120000);
    assert.match(challenge.sig, /^[0-9a-f]{64}$/);
  } finally { service.close(); }
});

test('public share routes delegate challenge creation and verification instead of reimplementing PoW', () => {
  const routes = read('lib/server/public-share-routes.js');
  assert.match(routes, /res\.json\(createPowChallenge\(req\)\)/);
  assert.match(routes, /verifyPowChallenge\(req, req\.body\)/);
  assert.doesNotMatch(routes, /randomBytes\(16\).*toString\('hex'\)/);
  assert.doesNotMatch(routes, /powSign\(\[nonce/);
});
