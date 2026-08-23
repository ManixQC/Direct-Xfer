'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js');
const adminApplication = read('lib/server/admin-application.js');
const finalHttp = read('lib/server/final-http-application.js');
const httpComposition = read('lib/server/http-pwa-lifecycle-application.js');
const routerSource = read('lib/server/admin-router.js');
const accountRoutes = read('lib/server/admin-account-routes.js');
const securityRoutes = read('lib/server/admin-security-routes.js');
const storageRoutes = read('lib/server/admin-storage-routes.js');
const photoRoutes = read('lib/server/admin-photo-routes.js');
const settingsRoutes = read('lib/server/admin-settings-routes.js');
const dashboardRoutes = read('lib/server/admin-dashboard-routes.js');
const diagnosticsRoutes = read('lib/server/admin-diagnostics-routes.js');

function fakeExpress() {
  const middleware = [];
  const routes = [];
  const router = {
    use(fn) { middleware.push(fn); },
    get(route, ...handlers) { routes.push(['GET', route, handlers]); },
    post(route, ...handlers) { routes.push(['POST', route, handlers]); },
    patch(route, ...handlers) { routes.push(['PATCH', route, handlers]); },
    delete(route, ...handlers) { routes.push(['DELETE', route, handlers]); },
  };
  return { express:{ Router:() => router }, router, middleware, routes };
}

test('server composition root delegates cross-cutting admin policy and route groups', () => {
  assert.match(server, /createApplicationContext/);
  assert.match(finalHttp, /createAdminApplication\(\{/);
  assert.match(httpComposition, /adminApplication\.attachLateRoutes\(\{/);
  assert.doesNotMatch(server, /createAdminRouter\(\{/);
  assert.match(adminApplication, /createAdminRouter\(\{/);
  assert.match(adminApplication, /attachAdminAccountRoutes\(context\.route\('adminAccount'/);
  assert.match(adminApplication, /attachAdminSecurityRoutes\(context\.route\('adminSecurity'/);
  assert.match(adminApplication, /attachAdminStorageRoutes\(context\.route\('adminStorage'/);
  assert.match(adminApplication, /photo:context\.route\('adminPhoto', ROUTE_DOMAINS\.photo/);
  assert.match(adminApplication, /attachAdminPhotoRoutes\(lateRouteDeps\.photo\)/);
  assert.match(adminApplication, /settings:context\.route\('adminSettings', ROUTE_DOMAINS\.settings/);
  assert.match(adminApplication, /attachAdminSettingsRoutes\(lateRouteDeps\.settings\)/);
  assert.match(adminApplication, /dashboard:context\.route\('adminDashboard', ROUTE_DOMAINS\.dashboard/);
  assert.match(adminApplication, /attachAdminDashboardRoutes\(lateRouteDeps\.dashboard\)/);
  assert.match(adminApplication, /diagnostics:context\.route\('adminDiagnostics', ROUTE_DOMAINS\.diagnostics/);
  assert.match(adminApplication, /attachAdminDiagnosticsRoutes\(lateRouteDeps\.diagnostics\)/);
  assert.doesNotMatch(server, /adminRouter\.(?:get|post|put|delete|patch)\(/);
  assert.doesNotMatch(server, /adminRouter\.get\('\/session'/);
  assert.doesNotMatch(server, /adminRouter\.get\('\/audit\/signed-verify'/);
  assert.doesNotMatch(server, /adminRouter\.get\('\/storage\/connectors'/);
  assert.ok(server.split('\n').length < 22100);
});

test('admin router owns cache, forced-password and role authorization boundaries', () => {
  const { createAdminRouter } = require('../lib/server/admin-router');
  const h = fakeExpress();
  const built = createAdminRouter({
    express:h.express,
    requireAuth(_req, _res, next) { next(); },
    getAccountById() { return { id:'a', pwChanged:true }; },
    accountNeedsPwChange() { return false; },
    getById(id) { return { id, ownerId:'owner-a' }; },
  });
  assert.equal(built.adminRouter, h.router);
  assert.equal(h.middleware.length, 4);
  assert.equal(built.ownsShare({ session:{ role:'operator', accountId:'owner-a' } }, { ownerId:'owner-a' }), true);
  assert.equal(built.ownsShare({ session:{ role:'operator', accountId:'other' } }, { ownerId:'owner-a' }), false);

  let status = 0;
  built.requireFullAdmin({ session:{ role:'auditor' } }, {
    status(code) { status = code; return this; },
    json() { return this; },
  }, () => assert.fail('auditor must not pass full-admin middleware'));
  assert.equal(status, 403);

  let nextCalled = false;
  built.requireAuditAccess({ session:{ role:'auditor' } }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('admin domain route modules use explicit injected dependencies instead of importing the app', () => {
  assert.match(routerSource, /function createAdminRouter\(deps = \{\}\)/);
  assert.match(accountRoutes, /function attachAdminAccountRoutes\(deps = \{\}\)/);
  assert.match(securityRoutes, /function attachAdminSecurityRoutes\(deps = \{\}\)/);
  assert.match(storageRoutes, /function attachAdminStorageRoutes\(deps = \{\}\)/);
  assert.match(photoRoutes, /function attachAdminPhotoRoutes\(deps = \{\}\)/);
  assert.match(settingsRoutes, /function attachAdminSettingsRoutes\(deps = \{\}\)/);
  assert.match(dashboardRoutes, /function attachAdminDashboardRoutes\(deps = \{\}\)/);
  assert.match(diagnosticsRoutes, /function attachAdminDiagnosticsRoutes\(deps = \{\}\)/);
  assert.doesNotMatch(accountRoutes, /require\(['"]\.\.\/\.\.\/server/);
  assert.doesNotMatch(securityRoutes, /require\(['"]\.\.\/\.\.\/server/);
  assert.match(accountRoutes, /getState:|getState,/);
  assert.match(accountRoutes, /replaceState/);
  assert.match(securityRoutes, /getState/);
  assert.match(storageRoutes, /createStorageConnectorConfigRoutes/);
  assert.match(storageRoutes, /createOAuthBrokerDeploymentRoutes/);
  assert.match(storageRoutes, /createStorageConnectorBrowserRoutes/);
});

test('account, security and storage endpoints live in their domain route modules', () => {
  for (const route of ['/session', '/password', '/2fa/setup', '/accounts']) assert.ok(accountRoutes.includes(`'${route}'`), route);
  for (const route of ['/security/overview', '/audit/signed-verify', '/audit/export']) assert.ok(securityRoutes.includes(`'${route}'`), route);
  for (const route of ['/storage/connectors/summary', '/storage/connectors', '/storage/jobs/:id/cancel']) assert.ok(storageRoutes.includes(`'${route}'`), route);
});

test('account and security route factories attach without touching late runtime state', () => {
  const { attachAdminAccountRoutes } = require('../lib/server/admin-account-routes');
  const { attachAdminSecurityRoutes } = require('../lib/server/admin-security-routes');
  const h = fakeExpress();
  const noop = () => {};
  const yes = () => true;
  const state = { shares:[], trash:[], meta:{}, audit:[] };
  attachAdminAccountRoutes({
    adminRouter:h.router,
    requireOwner:noop,
    authService:{
      verifyCurrentPassword:async()=>({ok:true,match:true}),
      setAccountPassword:async()=>({ok:true}),
      base32encode:()=> 'ABC',
      verifyTotp:()=>true,
      twoFactorEnabledFor:()=>false,
    },
    sessionService:{
      destroySession:noop,
      clearOtherSessionsOfAccount:noop,
      clearSessionsOfAccount:noop,
      isSessionActive:()=>true,
      updateAccountUsername:noop,
    },
    getAccountById:()=>null,
    accountNeedsPwChange:()=>false,
    adminPwFromEnv:false,
    notificationsForAccount:()=>[],
    markNotificationsReadForAccount:()=>({}),
    deleteNotificationForAccount:()=>0,
    clearNotificationsForAccount:()=>0,
    accountMutedNotificationCategories:()=>[],
    getNotificationMutableCategories:()=>[],
    setAccountMutedNotificationCategories:()=>[],
    accountCustomNotificationRules:()=>[],
    publicCustomNotificationRule:(x)=>x,
    customNotificationRuleTargets:()=>[],
    getCustomNotificationRuleMetrics:()=>[],
    upsertCustomNotificationRule:()=>({rule:{}}),
    deleteCustomNotificationRule:()=>false,
    auditReq:yes,
    persistNow:yes,
    crypto:require('node:crypto'),
    appName:'Direct-Xfer',
    accountList:()=>[],
    normalizeUsername:(x)=>String(x||'').toLowerCase(),
    findAccountByName:()=>null,
    newAccountId:()=> 'id',
    hashPassword:async()=>({ok:true,hash:'hash'}),
    sendPasswordWorkError:noop,
    getPwaPairTickets:()=>new Map(),
    pwaDeviceResolvedAccount:()=>null,
    cleanupPwaCapabilityScopes:()=>0,
    clearNotificationDedupeForAccount:noop,
    syncLiveActivityCache:noop,
    reindex:noop,
    shareLogicalBytesCache:new Map(),
    trashItems:()=>[],
    getState:()=>state,
    replaceState:noop,
  });
  assert.ok(h.routes.some(([method, route]) => method === 'GET' && route === '/session'));
  assert.ok(h.routes.some(([method, route]) => method === 'DELETE' && route === '/accounts/:id'));

  const s = fakeExpress();
  attachAdminSecurityRoutes({
    adminRouter:s.router,
    requireAuditAccess:noop,
    requireFullAdmin:noop,
    ransomwareBlocks:()=>({}),
    ransomwareShareBlocks:()=>({}),
    scheduleFlush:noop,
    getSettings:()=>({}),
    anomalyRecent:[],
    anomalyWindows:new Map(),
    persistNow:yes,
    auditReq:yes,
    crypto:require('node:crypto'),
    sessionService:{listSessions:()=>[]},
    publicIp:(x)=>x,
    invalidateSessionSid:noop,
    secureCookie:()=>'',
    getState:()=>state,
    verifyAuditChain:()=>({ok:true}),
    ensureAuditProofKeys:()=>({publicKey:{export:()=>Buffer.from('x')}}),
    auditProofKeyId:()=> 'key',
    parseAuditChainFile:()=>({entries:[]}),
    buildAuditProof:()=>({head:{},entriesSha256:'',exportedAt:0}),
    verifyAuditProofBundle:()=>({ok:true,keyId:'key',entries:0}),
    timingSafeEqualStr:(a,b)=>a===b,
    csvField:(x)=>String(x??''),
    appName:'Direct-Xfer',
    fs:require('node:fs'),
    path:require('node:path'),
    dlpQuarantineRecords:()=>[],
    dlpQuarantineFilePath:()=>null,
    schedulePersistRetry:noop,
  });
  assert.ok(s.routes.some(([method, route]) => method === 'GET' && route === '/audit/signed-verify'));
  assert.ok(s.routes.some(([method, route]) => method === 'POST' && route === '/security/anomalies/unblock'));
});


function routeResponse() {
  return {
    statusCode:200,
    payload:null,
    headers:{},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test('concurrent owner account creation re-checks username uniqueness after async hashing', async () => {
  const { attachAdminAccountRoutes } = require('../lib/server/admin-account-routes');
  const h = fakeExpress();
  const state = {
    shares:[], trash:[],
    meta:{ accounts:[{ id:'owner', username:'owner', role:'owner', pwChanged:true }] },
  };
  const hashWaiters = [];
  let id = 0;
  const noop = () => {};
  const yes = () => true;
  const findAccountByName = (username) => state.meta.accounts.find(
    (account) => account.username === String(username || '').toLowerCase(),
  ) || null;

  attachAdminAccountRoutes({
    adminRouter:h.router,
    requireOwner:noop,
    authService:{
      verifyCurrentPassword:async()=>({ok:true,match:true,credentialHash:'owner-hash'}),
      setAccountPassword:async()=>({ok:true}),
      base32encode:()=> 'ABC',
      verifyTotp:()=>true,
      twoFactorEnabledFor:()=>false,
    },
    sessionService:{
      destroySession:noop,
      clearOtherSessionsOfAccount:noop,
      clearSessionsOfAccount:noop,
      isSessionActive:()=>true,
      updateAccountUsername:noop,
    },
    getAccountById:(accountId)=>state.meta.accounts.find((account)=>account.id===accountId)||null,
    accountNeedsPwChange:()=>false,
    adminPwFromEnv:false,
    notificationsForAccount:()=>[],
    markNotificationsReadForAccount:()=>({}),
    deleteNotificationForAccount:()=>0,
    clearNotificationsForAccount:()=>0,
    accountMutedNotificationCategories:()=>[],
    getNotificationMutableCategories:()=>[],
    setAccountMutedNotificationCategories:()=>[],
    accountCustomNotificationRules:()=>[],
    publicCustomNotificationRule:(x)=>x,
    customNotificationRuleTargets:()=>[],
    getCustomNotificationRuleMetrics:()=>[],
    upsertCustomNotificationRule:()=>({rule:{}}),
    deleteCustomNotificationRule:()=>false,
    auditReq:yes,
    persistNow:yes,
    crypto:require('node:crypto'),
    appName:'Direct-Xfer',
    accountList:()=>state.meta.accounts,
    normalizeUsername:(x)=>String(x||'').trim().toLowerCase(),
    findAccountByName,
    newAccountId:()=>`a${++id}`,
    hashPassword:()=>new Promise((resolve)=>hashWaiters.push(resolve)),
    sendPasswordWorkError:noop,
    getPwaPairTickets:()=>new Map(),
    pwaDeviceResolvedAccount:()=>null,
    cleanupPwaCapabilityScopes:()=>0,
    clearNotificationDedupeForAccount:noop,
    syncLiveActivityCache:noop,
    reindex:noop,
    shareLogicalBytesCache:new Map(),
    trashItems:()=>[],
    getState:()=>state,
    replaceState:noop,
  });

  const route = h.routes.find(([method, path]) => method === 'POST' && path === '/accounts');
  assert.ok(route);
  const handler = route[2][route[2].length - 1];
  const req = () => ({
    body:{ username:'same-user', password:'valid-password', role:'admin' },
    session:{ sid:'sid-owner', role:'owner', accountId:'owner', username:'owner' },
  });
  const firstRes = routeResponse();
  const secondRes = routeResponse();
  const first = handler(req(), firstRes);
  const second = handler(req(), secondRes);
  while (hashWaiters.length < 2) await new Promise((resolve)=>setImmediate(resolve));

  hashWaiters.shift()({ ok:true, hash:'hash-1' });
  await new Promise((resolve)=>setImmediate(resolve));
  hashWaiters.shift()({ ok:true, hash:'hash-2' });
  await Promise.all([first, second]);

  assert.equal(state.meta.accounts.filter((account)=>account.username==='same-user').length, 1);
  assert.deepEqual([firstRes.statusCode, secondRes.statusCode].sort((a,b)=>a-b), [201, 409]);
});

test('2FA setup records compare-and-swap state before asynchronous recovery hashing', () => {
  assert.match(accountRoutes, /const initialTotp = account\.totp \|\| null;/);
  assert.match(accountRoutes, /if \(\(account\.totp \|\| null\) !== initialTotp\)/);
  assert.match(accountRoutes, /expectedHash: verifiedCredentialHash/);
});
