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
const photoSource = read('lib/server/admin-photo-routes.js');
const settingsSource = read('lib/server/admin-settings-routes.js');
const dashboardSource = read('lib/server/admin-dashboard-routes.js');
const diagnosticsSource = read('lib/server/admin-diagnostics-routes.js');

function fakeRouter() {
  const routes = [];
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    router[method] = (route, ...handlers) => {
      routes.push({ method:method.toUpperCase(), route, handlers });
      return router;
    };
  }
  return { router, routes };
}

function response() {
  return {
    statusCode:200,
    payload:null,
    headers:{},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; },
  };
}

function attachWithProxy(attach, overrides = {}) {
  const h = fakeRouter();
  let currentState = overrides.state || { settings:{}, meta:{}, history:[], photoHistory:[], ipNames:{}, stats:{}, activityLog:[] };
  const noop = () => {};
  const base = {
    adminRouter:h.router,
    getState:() => currentState,
    getServer:() => null,
    requireFullAdmin:noop,
    requireAuditAccess:noop,
    requireOwner:noop,
    rootDir:ROOT,
    pwaAdminHealth:{
      healthPayload:() => ({}),
      recordHealthHistory:noop,
      bucketHealthHistory:() => ({ range:'24h', points:[] }),
      attachHealthRoute:(router) => {
        router.get('/pwa-admin-health/history', noop);
        router.get('/pwa-admin-health', noop);
        return true;
      },
    },
    systemHealthService:{
      FILE_CATEGORY_ORDER:[],
      buildGlobalStorageReport:noop,
      diskFreeThresholds:noop,
      fileCategoryOf:noop,
      scanReceptionStorage:noop,
      serverHealthDeepSnapshot:noop,
      serverHealthJobSummary:noop,
      serverHealthShareSummary:noop,
      serverHealthReceptionVolume:noop,
    },
    diagnosticsService:{
      diagnosticTcp:noop,
      diagnosticWritable:noop,
      safeDiagnosticFixFor:noop,
      tlsCertificateDiagnostics:noop,
    },
    state:currentState,
    ...overrides,
  };
  delete base.state;
  const deps = new Proxy(base, {
    get(target, prop) { return prop in target ? target[prop] : noop; },
  });
  attach(deps);
  return { ...h, getState:() => currentState, setState:(next) => { currentState = next; } };
}

test('remaining administrator routes are fully extracted from server.js', () => {
  for (const fn of ['attachAdminPhotoRoutes', 'attachAdminSettingsRoutes', 'attachAdminDashboardRoutes', 'attachAdminDiagnosticsRoutes']) {
    assert.match(adminApplication, new RegExp(`${fn}\\(lateRouteDeps\\.`), fn);
  }
  assert.doesNotMatch(server, /adminRouter\.(?:get|post|put|delete|patch)\(/);
  assert.match(finalHttp, /createAdminApplication\(\{/);
  assert.match(httpComposition, /adminApplication\.attachLateRoutes\(\{/);
  assert.ok(Buffer.byteLength(server, 'utf8') < 550 * 1024, `server.js is ${Buffer.byteLength(server, 'utf8')} bytes`);
});

test('focused admin modules register the complete extracted surface without duplicates', () => {
  const modules = [
    [require('../lib/server/admin-photo-routes').attachAdminPhotoRoutes, 20],
    [require('../lib/server/admin-settings-routes').attachAdminSettingsRoutes, 17],
    [require('../lib/server/admin-dashboard-routes').attachAdminDashboardRoutes, 14],
    [require('../lib/server/admin-diagnostics-routes').attachAdminDiagnosticsRoutes, 12],
  ];
  const registrations = [];
  for (const [attach, expected] of modules) {
    const h = attachWithProxy(attach);
    assert.equal(h.routes.length, expected);
    registrations.push(...h.routes.map((r) => `${r.method} ${r.route}`));
  }
  assert.equal(registrations.length, 63);
  assert.equal(new Set(registrations).size, registrations.length);
  for (const route of [
    'GET /photos/dashboard', 'POST /photos/upload', 'POST /settings', 'GET /presets',
    'GET /dashboard', 'GET /server-health-dashboard', 'GET /pwa-admin-health', 'GET /pwa-admin-health/history', 'POST /diagnostics/run', 'GET /network/proxy-check',
    'POST /backup-now', 'GET /browse', 'GET /preview',
  ]) assert.ok(registrations.includes(route), route);
});

test('new route modules keep restored state live instead of capturing the old root', () => {
  const { attachAdminSettingsRoutes } = require('../lib/server/admin-settings-routes');
  let bumps = 0;
  const first = { settings:{ keepIpNames:true }, meta:{}, history:[], ipNames:{ old:'first' } };
  const second = { settings:{ keepIpNames:true }, meta:{}, history:[], ipNames:{} };
  const h = attachWithProxy(attachAdminSettingsRoutes, {
    state:first,
    getSettings:() => ({ keepIpNames:true }),
    persistNow:() => true,
    auditReq:() => true,
    bumpHistoryViewRevision:() => { bumps += 1; },
  });
  h.setState(second);
  const route = h.routes.find((r) => r.method === 'POST' && r.route === '/ip-names');
  const handler = route.handlers.at(-1);
  const res = response();
  handler({ body:{ ip:'203.0.113.8', name:'WAN' }, session:{ accountId:'a' }, headers:{} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(second.ipNames['203.0.113.8'], 'WAN');
  assert.equal(first.ipNames['203.0.113.8'], undefined);
  assert.equal(bumps, 1);
});

test('route modules preserve explicit composition boundaries', () => {
  for (const source of [photoSource, settingsSource, dashboardSource, diagnosticsSource]) {
    assert.doesNotMatch(source, /require\(['"]\.\.\/\.\.\/server/);
    assert.match(source, /function attachAdmin[A-Za-z]+Routes\(deps = \{\}\)/);
    assert.match(source, /getState/);
  }
  assert.match(diagnosticsSource, /getServer/);
  assert.match(settingsSource, /bumpHistoryViewRevision/);
});


test('route-only comparison and preset helpers live with their admin domains', () => {
  for (const name of ['dashboardDelta', 'buildImageComparison', 'buildTransferComparison', 'finalizeTransferPeriodMetrics', 'sanitizePresetConfig', 'decoratePreset', 'presetAccountId']) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\b`), name);
  }
  assert.match(photoSource, /function buildImageComparison\(/);
  assert.match(dashboardSource, /function buildTransferComparison\(/);
  assert.match(dashboardSource, /function finalizeTransferPeriodMetrics\(/);
  assert.match(settingsSource, /function sanitizePresetConfig\(/);
  assert.match(settingsSource, /const PRESET_TYPES = new Set\(/);
});

test('PWA health routes are owned by the dashboard admin boundary', () => {
  assert.doesNotMatch(server, /pwaAdminHealth\.attachHealthRoute\(adminRouter\)/);
  assert.match(dashboardSource, /pwaAdminHealth\.attachHealthRoute\(adminRouter\)/);
});
