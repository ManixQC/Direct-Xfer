'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSecurityAuthApplication } = require('../lib/server/security-auth-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function makeApplication() {
  const settings = { sessionHours:8, publicRateLimit:false, challengeEnabled:false };
  const accounts = new Map();
  const app = createSecurityAuthApplication({
    platform:{ crypto },
    config:{ SESSION_TTL_MS:8 * 60 * 60 * 1000, FAIL_WINDOW_MS:5 * 60 * 1000 },
    request:{
      clientIp:() => '127.0.0.1',
      parseCookies:() => ({}),
      secureCookie:() => '',
    },
    state:{
      getSettings:() => settings,
      scheduleFlush:() => {},
      persistNow:() => {},
    },
    account:{
      getAccountById:(id) => accounts.get(id) || null,
      findAccountByName:() => null,
      accountPasswordRecord:(account) => account && account.passwordRecord,
      dummyPasswordRecord:{ hash:'00', salt:'00' },
      normalizeUsername:(value) => String(value || '').trim().toLowerCase(),
    },
    pwa:{
      closeStreamsForSession:() => {},
      getPwaDevice:() => null,
      pwaDeviceResolvedAccount:() => null,
    },
    network:{
      geoSync:() => null,
      geolocate:async () => null,
    },
    notification:{
      logAudit:() => {},
      addCenterNotification:() => null,
      enrichCenterNotificationGeo:() => {},
      pruneLeakTrackers:() => {},
    },
    activity:{
      publicIp:(ip) => ip,
      maskIp:(ip) => ip,
    },
    share:{ linkPrefix:() => '/s/' },
    utils:{
      timingSafeEqualStr:(a, b) => String(a) === String(b),
      flagFromCode:() => '',
      isLoopback:() => false,
      isPrivateIp:() => false,
      parseIpList:() => [],
      ipInList:() => false,
    },
  });
  return app;
}

test('security/auth application composes administrator security before public security', () => {
  const app = makeApplication();
  assert.equal(typeof app.sessionService.requireAuth, 'function');
  assert.equal(typeof app.authService.attemptLogin, 'function');
  assert.throws(() => app.getPublicSecurity(), /not initialized/);

  const publicSecurity = app.initializePublicSecurity({
    pages:{
      errorPage:() => '<html></html>',
      pickLang:() => 'en',
      challengePage:() => '<html></html>',
    },
  });
  try {
    assert.equal(typeof publicSecurity.publicAccessService.linkAccessReason, 'function');
    assert.equal(typeof publicSecurity.publicAbuseService.publicRateRetryAfter, 'function');
    assert.strictEqual(app.initializePublicSecurity({ pages:{} }), publicSecurity, 'public composition must be idempotent once ready');
    assert.strictEqual(app.getPublicSecurity(), publicSecurity);
  } finally {
    publicSecurity.publicAbuseService.close();
  }
});

test('security/auth application validates the delayed public renderer contract before mutation', () => {
  const app = makeApplication();
  assert.throws(() => app.initializePublicSecurity({ pages:{} }), /public pages\.errorPage/);
  assert.throws(() => app.getPublicSecurity(), /not initialized/);

  const publicSecurity = app.initializePublicSecurity({
    pages:{ errorPage:() => '', pickLang:() => 'en', challengePage:() => '' },
  });
  publicSecurity.publicAbuseService.close();
});

test('server delegates all four security service constructors to the extracted composition boundary', () => {
  const server = read('server.js');
  const composition = read('lib/server/security-auth-application.js');
  const publicHttp = read('lib/server/public-http-application.js');
  assert.match(server, /createSecurityAuthApplication\(\{/);
  assert.match(server, /createPublicHttpApplication\(\{/);
  assert.match(publicHttp, /securityAuthApplication\.initializePublicSecurity/);
  for (const factory of [
    'createSessionService','createAuthService','createPublicAccessService','createPublicAbuseService',
  ]) {
    assert.doesNotMatch(server, new RegExp(`${factory}\\(`), `${factory} should not be composed in server.js`);
    assert.match(composition, new RegExp(`${factory}\\(`), `${factory} must be composed by security-auth-application.js`);
  }
  assert.ok(server.split('\n').length < 1120, `server.js should stay compact after security/auth extraction (${server.split('\n').length} lines)`);
});

test('Windows runtime integrity manifest protects the security/auth composition boundary', () => {
  const source = read('lib/server/security-auth-application.js');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "lib/server/security-auth-application\\.js", "${hash}" \\}`));
});
