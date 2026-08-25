'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAsvsL3Report,
  assertAsvsL3Configuration,
  createAsvsL3TransportGuard,
  isAsvsL3OutboundUrlAllowed,
  sanitizeMailHeader,
} = require('../lib/server/asvs-l3-policy');
const { createSessionService } = require('../lib/server/session-service');
const { strictFileContentReason } = require('../lib/file-type-policy');
const { completeL3Config } = require('./helpers/asvs-l3-fixture');

test('ASVS L3 startup gate fails closed until machine-verifiable deployment prerequisites are satisfied', (t) => {
  const incomplete = buildAsvsL3Report({ ASVS_L3_MODE: true }, { ASVS_L3_MODE: 'true' });
  assert.equal(incomplete.enabled, true);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.failures.length >= 8);
  assert.throws(
    () => assertAsvsL3Configuration({ ASVS_L3_MODE: true }, { ASVS_L3_MODE: 'true' }),
    (err) => err && err.code === 'asvs-l3-prerequisites',
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-asvs-l3-complete-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const complete = buildAsvsL3Report(completeL3Config(dir), {});
  assert.equal(complete.enabled, true);
  assert.equal(complete.ok, true, complete.failures.map((row) => `${row.id}:${row.detail}`).join('; '));
  assert.equal(complete.failures.length, 0);
});

test('ASVS L3 transport guard rejects application HTTP but permits loopback health checks', () => {
  const guard = createAsvsL3TransportGuard({ enabled: true, isLoopback: (ip) => ip === '127.0.0.1' });
  let nextCalls = 0;
  let statusCode = 0;
  let body = null;
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  guard({ secure:false, path:'/admin', socket:{ remoteAddress:'10.0.0.2' } }, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.equal(statusCode, 426);
  assert.equal(body.error, 'https-required');

  guard({ secure:false, path:'/healthz', socket:{ remoteAddress:'127.0.0.1' } }, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});

test('ASVS L3 upload content policy rejects extension/content mismatches and executable masquerading', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-asvs-l3-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));

  const fakePng = path.join(dir, 'fake.png');
  fs.writeFileSync(fakePng, 'not a png');
  assert.equal(await strictFileContentReason(fakePng, 'image.png'), 'file-type-mismatch');

  const realPng = path.join(dir, 'real.png');
  fs.writeFileSync(realPng, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]));
  assert.equal(await strictFileContentReason(realPng, 'image.png'), null);

  const disguised = path.join(dir, 'disguised.txt');
  fs.writeFileSync(disguised, Buffer.from([0x4d,0x5a,0x90,0x00,0x00,0x00]));
  assert.equal(await strictFileContentReason(disguised, 'notes.txt'), 'content-blocked');
});

test('ASVS L3 sessions bind network/browser context and retain phishing-resistant auth assurance', () => {
  const account = { id:'acct-1', username:'owner', role:'owner' };
  const settings = { sessionHours:8, sessionIdleMinutes:30, maxConcurrentSessions:10 };
  const cookieState = { sid:null };
  const service = createSessionService({
    getSettings: () => settings,
    defaultTtlMs: 8 * 60 * 60 * 1000,
    getAccountById: (id) => id === account.id ? account : null,
    clientIp: (req) => req.ip,
    parseCookies: () => cookieState.sid ? { '__Host-sid':cookieState.sid } : {},
    secureCookie: () => '; Secure',
    timingSafeEqualStr: (a,b) => a === b,
    asvsL3Mode: true,
  });
  const res = { setHeader() {} };
  const req = { ip:'203.0.113.10', headers:{ 'user-agent':'DX-Test/1' } };
  const created = service.createSession(req, res, account, { authMethod:'passkey', phishingResistant:true });
  cookieState.sid = created.sid;

  const good = service.getSession(req);
  assert.equal(good.authMethod, 'passkey');
  assert.equal(good.phishingResistant, true);
  assert.equal(service.hasRecentStrongAuthentication(created.sid), true);

  assert.equal(service.getSession({ ip:'203.0.113.11', headers:{ 'user-agent':'DX-Test/1' } }), null);
  assert.equal(service.isSessionActive(created.sid), false);
});

test('L3 source policy requires passkeys for admin API, step-up for sensitive mutations, generated reset credentials and independent public-link auth', () => {
  const adminRouter = fs.readFileSync(path.join(__dirname, '..', 'lib/server/admin-router.js'), 'utf8');
  const accountRoutes = fs.readFileSync(path.join(__dirname, '..', 'lib/server/admin-account-routes.js'), 'utf8');
  const publicRoutes = fs.readFileSync(path.join(__dirname, '..', 'lib/server/public-share-routes.js'), 'utf8');
  const auditService = fs.readFileSync(path.join(__dirname, '..', 'lib/server/audit-service.js'), 'utf8');

  assert.match(adminRouter, /phishingResistant\s*!==\s*true|phishingResistant\s*===\s*true/);
  assert.match(adminRouter, /reauth-required/);
  assert.match(adminRouter, /hasRecentStrongAuthentication/);
  assert.match(accountRoutes, /randomBytes\(24\)\.toString\('base64url'\)/);
  assert.match(publicRoutes, /l3-independent-auth-required/);
  assert.match(auditService, /AUDIT_REMOTE_URL/);
  assert.match(auditService, /rejectUnauthorized\s*:\s*true/);
});


test('ASVS L3 egress policy is fail-closed and cannot be bypassed with a wildcard declaration', (t) => {
  assert.equal(isAsvsL3OutboundUrlAllowed('https://siem.example/ingest', { asvsL3Mode:true, allowlist:'siem.example' }), true);
  assert.equal(isAsvsL3OutboundUrlAllowed('https://evil.example/ingest', { asvsL3Mode:true, allowlist:'siem.example' }), false);
  assert.equal(isAsvsL3OutboundUrlAllowed('http://siem.example/ingest', { asvsL3Mode:true, allowlist:'siem.example' }), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-asvs-l3-egress-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const wildcard = buildAsvsL3Report(completeL3Config(dir, { ASVS_L3_EGRESS_ALLOWLIST:'*' }), {});
  assert.equal(wildcard.ok, false);
  assert.ok(wildcard.failures.some((row) => row.id === 'network.egress-allowlist'));
});

test('ASVS L3 SMTP header sanitization rejects CRLF/control injection', () => {
  assert.equal(sanitizeMailHeader('Direct-Xfer alert'), 'Direct-Xfer alert');
  assert.throws(() => sanitizeMailHeader('ok\r\nBcc: attacker@example.test'), (err) => err && err.code === 'unsafe-mail-header');
  assert.throws(() => sanitizeMailHeader('ok\0bad'), (err) => err && err.code === 'unsafe-mail-header');
});

test('ASVS L3 source enforces SVG sanitization, parameter de-duplication and private-browser-state purge on logout', () => {
  const fileType = fs.readFileSync(path.join(__dirname, '..', 'lib/file-type-policy.js'), 'utf8');
  const httpApp = fs.readFileSync(path.join(__dirname, '..', 'lib/server/http-application.js'), 'utf8');
  const pwaRoutes = fs.readFileSync(path.join(__dirname, '..', 'lib/server/pwa-routes.js'), 'utf8');
  const pwaApp = fs.readFileSync(path.join(__dirname, '..', 'pwa/app.js'), 'utf8');
  assert.match(fileType, /unsafeSvgContentReason/);
  assert.match(fileType, /foreignObject|script/);
  assert.match(httpApp, /duplicate-query-parameter/);
  assert.match(pwaRoutes, /asvsL3:\s*ASVS_L3_MODE\s*===\s*true/);
  assert.match(pwaApp, /strictL3Logout/);
  assert.match(pwaApp, /clearLocalDataInternal\(false\)/);
});

test('ASVS L3 WebAuthn option construction performs phantom work for both valid and invalid usernames', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib/server/pwa-routes.js'), 'utf8');
  assert.match(routes, /const phantom = phantomAllowCredentials\(username\);/);
  assert.match(routes, /allow\.push\(\.\.\.phantom\.slice\(allow\.length, 20\)\)/);
  assert.match(routes, /allow = phantom;/);
});
