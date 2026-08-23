'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const server = read('server.js');
const admin = read('lib/server/admin-application.js');
const finalHttp = read('lib/server/final-http-application.js');
const httpComposition = read('lib/server/http-pwa-lifecycle-application.js');

test('1.70.3 server delegates administrator composition to one focused application module', () => {
  assert.match(server, /require\('\.\/lib\/server\/final-http-application'\)/);
  assert.match(finalHttp, /require\('\.\/admin-application'\)/);
  assert.match(finalHttp, /const adminApplication = createAdminApplication\(\{/);
  assert.match(httpComposition, /adminApplication\.attachLateRoutes\(\{ shutdown, getServer \}\)/);
  for (const direct of [
    'createAdminRouter', 'attachAdminAccountRoutes', 'attachAdminSecurityRoutes',
    'attachAdminStorageRoutes', 'attachAdminShareCoreRoutes', 'attachAdminShareRoutes',
    'attachAdminPhotoRoutes', 'attachAdminSettingsRoutes', 'attachAdminDashboardRoutes',
    'attachAdminDiagnosticsRoutes', 'createStorageConnectorJobService',
    'createDiagnosticsService', 'createSystemHealthService',
  ]) {
    assert.doesNotMatch(server, new RegExp(`\\b${direct}\\(`), direct);
  }
  assert.ok(server.split('\n').length < 1300, `server.js remains too large (${server.split('\n').length} lines)`);
});

test('administrator dependency profiles and service ownership live beside route attachment', () => {
  const { ROUTE_DOMAINS, createAdminApplication } = require('../lib/server/admin-application');
  assert.equal(typeof createAdminApplication, 'function');
  assert.deepEqual(Object.keys(ROUTE_DOMAINS), [
    'account', 'security', 'storage', 'shareCore', 'share',
    'settings', 'photo', 'dashboard', 'diagnostics',
  ]);
  assert.ok(Object.isFrozen(ROUTE_DOMAINS));
  for (const [name, domains] of Object.entries(ROUTE_DOMAINS)) {
    assert.ok(Object.isFrozen(domains), `${name} profile`);
    assert.ok(domains.length >= 3, `${name} profile is unexpectedly empty`);
  }
  for (const factory of ['createStorageConnectorJobService', 'createDiagnosticsService', 'createSystemHealthService']) {
    assert.match(admin, new RegExp(`\\b${factory}\\(\\{`), factory);
  }
});

test('public root handlers stay outside the administrator boundary', () => {
  assert.match(finalHttp, /require\('\.\/root-routes'\)/);
  assert.match(finalHttp, /const rootRoutes = createRootRoutes\(\{/);
  assert.match(finalHttp, /rootRoutes,\n  \}\);/);
  assert.doesNotMatch(admin, /require\('\.\/root-routes'\)/);
  assert.match(admin, /rootRoutes\.loginHints/);
  assert.match(admin, /rootRoutes\.sendLocalCaCertificate/);
});

test('late administrator routes preserve lifecycle-sensitive attachment order and are one-shot', () => {
  assert.match(admin, /let lateRoutesState = 'idle';/);
  assert.match(admin, /if \(lateRoutesState !== 'idle'\)/);
  assert.match(admin, /lateRoutesState = 'attaching';/);
  assert.match(admin, /lateRoutesState = 'attached';/);
  assert.match(admin, /lateRoutesState = 'failed';/);
  assert.ok(admin.indexOf("requireDomain(context, 'pwa-device')") < admin.indexOf("context.register('late-service-refs'"));
  assert.match(admin, /const lateRouteDeps = Object\.freeze\(\{/);
  for (const name of ['adminSettings', 'adminPhoto', 'adminDashboard', 'adminDiagnostics']) {
    assert.equal((admin.match(new RegExp(`context\\.route\\('${name}'`, 'g')) || []).length, 1, `${name} is resolved exactly once`);
  }
  const order = [
    'attachAdminSettingsRoutes(lateRouteDeps.settings)',
    'attachAdminPhotoRoutes(lateRouteDeps.photo)',
    'attachAdminDashboardRoutes(lateRouteDeps.dashboard)',
    'attachAdminDiagnosticsRoutes(lateRouteDeps.diagnostics)',
  ].map((token) => admin.indexOf(token));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(httpComposition.indexOf('adminApplication.attachLateRoutes') < httpComposition.indexOf("app.use('/api', adminGuard, jsonParser, adminApplication.adminRouter)"));
});
