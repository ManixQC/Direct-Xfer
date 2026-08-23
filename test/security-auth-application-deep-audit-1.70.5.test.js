'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSecurityAuthApplication } = require('../lib/server/security-auth-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function responseRecorder() {
  const headers = Object.create(null);
  return {
    headers,
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
  };
}

function cookieValue(setCookie, name) {
  const rows = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const row of rows) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(String(row || ''));
    if (match) return match[1];
  }
  return '';
}

function makeApplication() {
  const settings = {
    sessionHours:8,
    maxLoginAttempts:5,
    lockoutMinutes:5,
    publicRateLimit:true,
    publicRateWindowMin:1,
    publicRateMax:2,
    challengeEnabled:true,
    challengeMinMB:1,
    challengeBits:8,
  };
  const account = { id:'owner', username:'owner', role:'owner' };
  const accounts = new Map([[account.id, account]]);
  const app = createSecurityAuthApplication({
    platform:{ crypto },
    config:{ SESSION_TTL_MS:8 * 60 * 60 * 1000, FAIL_WINDOW_MS:5 * 60 * 1000 },
    request:{
      clientIp:(req) => String((req && req.ip) || '203.0.113.9'),
      parseCookies:(req) => (req && req.cookies) || {},
      secureCookie:() => '',
    },
    state:{ getSettings:() => settings, scheduleFlush:() => {}, persistNow:() => true },
    account:{
      getAccountById:(id) => accounts.get(id) || null,
      findAccountByName:() => null,
      accountPasswordRecord:(value) => value && value.passwordRecord,
      dummyPasswordRecord:{ hash:Buffer.from('00', 'hex'), salt:Buffer.from('00', 'hex') },
      normalizeUsername:(value) => String(value || '').trim().toLowerCase(),
    },
    pwa:{ closeStreamsForSession:() => {}, getPwaDevice:() => null, pwaDeviceResolvedAccount:() => null },
    network:{ geoSync:() => null, geolocate:async () => null },
    notification:{
      logAudit:() => {}, addCenterNotification:() => null,
      enrichCenterNotificationGeo:() => {}, pruneLeakTrackers:() => {},
    },
    activity:{ publicIp:(ip) => ip, maskIp:(ip) => ip },
    share:{ linkPrefix:() => '/s/' },
    utils:{
      timingSafeEqualStr:(a, b) => String(a) === String(b), flagFromCode:() => '',
      isLoopback:() => false, isPrivateIp:() => false, parseIpList:() => [], ipInList:() => false,
    },
  });
  const publicSecurity = app.initializePublicSecurity({
    pages:{ errorPage:() => '', pickLang:() => 'en', challengePage:() => '' },
  });
  return { app, account, publicSecurity };
}

test('1.70.5 security runtime reset clears sessions and rotates public credential secrets', () => {
  const { app, account, publicSecurity } = makeApplication();
  try {
    const sessionRes = responseRecorder();
    const created = app.sessionService.createSession({ ip:'203.0.113.9', cookies:{}, headers:{} }, sessionRes, account);
    assert.ok(app.sessionService.getSession({ cookies:{ sid:created.sid } }));

    const share = { token:'abc123', pwHash:'legacy-hash' };
    const unlockRes = responseRecorder();
    publicSecurity.publicAccessService.setUnlockCookie({ cookies:{} }, unlockRes, share);
    const unlockCookie = cookieValue(unlockRes.getHeader('set-cookie'), 'dxu_' + share.token);
    assert.ok(unlockCookie);
    assert.equal(publicSecurity.publicAccessService.isUnlocked({ cookies:{ ['dxu_' + share.token]:unlockCookie } }, share), true);

    const powRes = responseRecorder();
    const powNow = Date.now();
    publicSecurity.publicAbuseService.issuePowCookie({ ip:'203.0.113.9', cookies:{} }, powRes, powNow);
    const powCookie = cookieValue(powRes.getHeader('set-cookie'), 'dxpow');
    assert.ok(powCookie);
    assert.equal(publicSecurity.publicAbuseService.hasValidPow({ ip:'203.0.113.9', cookies:{ dxpow:powCookie } }, powNow + 1), true);

    app.clearRuntimeState();

    assert.equal(app.sessionService.getSession({ cookies:{ sid:created.sid } }), null);
    assert.equal(publicSecurity.publicAccessService.isUnlocked({ cookies:{ ['dxu_' + share.token]:unlockCookie } }, share), false);
    assert.equal(publicSecurity.publicAbuseService.hasValidPow({ ip:'203.0.113.9', cookies:{ dxpow:powCookie } }, powNow + 1), false);
  } finally {
    publicSecurity.publicAbuseService.close();
  }
});

test('1.70.5 security boundary reports public password verification as state-replacement busy', () => {
  const { app, publicSecurity } = makeApplication();
  try {
    assert.equal(app.isBusyForStateReplacement(), false);
    const attempt = publicSecurity.publicAccessService.beginUnlockAttempt({ ip:'203.0.113.10', cookies:{} });
    assert.equal(attempt.ok, true);
    assert.equal(app.isBusyForStateReplacement(), true);
    publicSecurity.publicAccessService.finishUnlockAttempt(attempt);
    assert.equal(app.isBusyForStateReplacement(), false);
  } finally {
    publicSecurity.publicAbuseService.close();
  }
});

test('1.70.5 restore composition uses the aggregate security reset and security busy gate', () => {
  const lifecycle = read('lib/server/state-lifecycle-application.js');
  const core = read('lib/server/core-state-application.js');
  const restore = read('lib/server/restore-service.js');
  const coordinator = read('lib/server/state-replacement-coordinator.js');
  assert.match(lifecycle, /\['security', \(\) => callLate\(securityProvider, 'securityAuthApplication', 'isBusyForStateReplacement'\)\]/);
  assert.match(lifecycle, /\['security', \(\) => callLate\(securityProvider, 'securityAuthApplication', 'clearRuntimeState'\)\]/);
  assert.match(core, /stateReplacementCoordinator/);
  assert.doesNotMatch(core, /isSecurityStateReplacementBusy/);
  assert.match(restore, /stateReplacementCoordinator\.isBusyForStateReplacement\(\)/);
  assert.match(coordinator, /restore-runtime-reset-failed/);
});

test('1.70.5 security services expose explicit reset/busy contracts rather than leaking restore logic into server.js', () => {
  const auth = read('lib/server/auth-service.js');
  const access = read('lib/server/public-access-service.js');
  const abuse = read('lib/server/public-abuse-service.js');
  const composition = read('lib/server/security-auth-application.js');
  assert.match(auth, /function clearRuntimeState\(\)/);
  assert.match(auth, /function isBusyForStateReplacement\(\)/);
  assert.match(access, /function clearRuntimeState\(\)/);
  assert.match(access, /unlockSecret = null;[\s\S]*?crypto\.randomBytes\(32\)/);
  assert.match(access, /function isBusyForStateReplacement\(\)/);
  assert.match(abuse, /function clearRuntimeState\(\)/);
  assert.match(abuse, /powSecret = null;[\s\S]*?crypto\.randomBytes\(32\)/);
  assert.match(composition, /function clearRuntimeState\(\)/);
  assert.match(composition, /function isBusyForStateReplacement\(\)/);
});
