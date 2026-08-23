'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

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
    writableEnded:false,
    destroyed:false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; this.writableEnded = true; return this; },
    send(value) { this.payload = value; this.writableEnded = true; return this; },
    end(value) { if (value !== undefined) this.payload = value; this.writableEnded = true; return this; },
    write() { return true; },
  };
}

function proxyDeps(base) {
  const noop = () => {};
  return new Proxy(base, {
    get(target, prop) { return prop in target ? target[prop] : noop; },
  });
}

function routeHandler(routes, method, route) {
  const row = routes.find((r) => r.method === method && r.route === route);
  assert.ok(row, `${method} ${route} registered`);
  return row.handlers.at(-1);
}

test('dashboard health route uses the composition-root health service after extraction', async () => {
  const source = read('lib/server/admin-dashboard-routes.js');
  assert.doesNotMatch(source, /require\(['"]\.\/lib\/pwa-admin-health-route['"]\)/);
  assert.match(source, /pwaAdminHealth\.healthPayload\(\)/);

  const { attachAdminDashboardRoutes } = require('../lib/server/admin-dashboard-routes');
  const h = fakeRouter();
  let sampled = 0;
  const health = {
    cpu:{ percent:12 },
    memory:{ percent:34 },
    disk:{ percent:20 },
    eventLoop:{ supported:true, p95Ms:3 },
  };
  attachAdminDashboardRoutes(proxyDeps({
    adminRouter:h.router,
    getState:() => ({ stats:{}, activityLog:[], audit:[], history:[] }),
    pwaAdminHealth:{
      healthPayload:() => health,
      recordHealthHistory:() => { sampled += 1; },
      bucketHealthHistory:(range) => ({ range, points:[] }),
      attachHealthRoute:() => true,
    },
    APP_VERSION:'1.69.6',
    TRUST_PROXY:false,
    listTransfers:() => [],
    systemHealthService:{
      FILE_CATEGORY_ORDER:[],
      buildGlobalStorageReport:async() => null,
      diskFreeThresholds:() => ({ warn:10, critical:5 }),
      fileCategoryOf:() => 'other',
      scanReceptionStorage:async() => ({}),
      serverHealthDeepSnapshot:async() => ({}),
      serverHealthShareSummary:() => ({ backingMissing:0 }),
      serverHealthJobSummary:() => ({ active:0, failedRecent24h:0 }),
      serverHealthReceptionVolume:async() => ({ path:'/tmp', disk:null }),
    },
    path,
  }));

  const res = response();
  await routeHandler(h.routes, 'GET', '/server-health-dashboard')({
    query:{ range:'24h' },
    headers:{},
    session:{ role:'admin' },
    protocol:'http',
    secure:false,
    get:() => 'localhost:3000',
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(sampled, 1);
  assert.equal(res.payload.health, health);
  assert.equal(res.payload.history.range, '24h');
});

test('diagnostics resolves PWA assets from the project root, not the moved module directory', async () => {
  const source = read('lib/server/admin-diagnostics-routes.js');
  assert.doesNotMatch(source, /path\.join\(__dirname\s*,\s*['"]pwa['"]/);
  assert.match(source, /path\.join\(rootDir\s*,\s*['"]pwa['"]/);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-admin-diag-'));
  const pwaDir = path.join(tempRoot, 'pwa');
  fs.mkdirSync(pwaDir, { recursive:true });
  for (const name of ['index.html','app.js','mobile-intelligence.js','dlp-local.js','sw.js','manifest.webmanifest']) {
    fs.writeFileSync(path.join(pwaDir, name), 'ok');
  }

  try {
    const { attachAdminDiagnosticsRoutes } = require('../lib/server/admin-diagnostics-routes');
    const h = fakeRouter();
    attachAdminDiagnosticsRoutes(proxyDeps({
      adminRouter:h.router,
      getState:() => ({ shares:[], meta:{} }),
      rootDir:tempRoot,
      DATA_DIR:tempRoot,
      INBOX_DIR:tempRoot,
      IMAGE_STORE_DIR:tempRoot,
      DATA_KEY:'',
      STORAGE_SETUP:{ inboxUnconfigured:false, imagesUnconfigured:false },
      TRUST_PROXY:false,
      PUBLIC_URL:'',
      SEARCH_OCR_ENABLED:false,
      SEARCH_OCR_LANGS:'eng',
      systemHealthService:{
        buildGlobalStorageReport:async() => null,
        diskFreeThresholds:() => ({ warn:10, critical:5 }),
      },
      diagnosticsService:{
        diagnosticTcp:async() => ({ ok:true }),
        diagnosticWritable:async() => ({ ok:true }),
        tlsCertificateDiagnostics:() => ({ status:'ok' }),
        safeDiagnosticFixFor:() => null,
      },
      verifyAuditChain:() => ({ ok:true }),
      universalSearchStatus:() => ({ ready:true, indexed:1, building:false, builtAt:1, error:null }),
      detectSearchOcrTools:async() => ({ tesseract:false, pdftoppm:false, missingLanguages:[] }),
      clamavEnabled:() => false,
      auditService:{ getKeyMigrationStatus:() => ({ ok:true }), getActiveKeyMode:() => 'local-file' },
      effectiveWebhook:() => ({ url:'' }),
      getLastWebhook:() => null,
      emailConfigured:() => false,
      getLastEmail:() => null,
      webpush:null,
      pushSubs:() => [],
      pwaDevices:() => [],
      externalTarget:() => null,
      normalizeLinkBase:(v) => v,
      getSettings:() => ({ linkBase:'' }),
      auditReq:() => true,
      path,
      fs,
    }));

    const res = response();
    await routeHandler(h.routes, 'POST', '/diagnostics/run')({
      body:{}, query:{}, headers:{}, session:{ role:'admin' }, protocol:'http', secure:false, get:() => 'localhost:3000',
    }, res);
    const pwa = res.payload.checks.find((c) => c.id === 'pwa-assets');
    assert.ok(pwa);
    assert.equal(pwa.status, 'ok');
    assert.deepEqual(pwa.missing, []);
  } finally {
    fs.rmSync(tempRoot, { recursive:true, force:true });
  }
});

test('diagnostics degrades failed collaborators without leaking their exceptions', async () => {
  const { attachAdminDiagnosticsRoutes } = require('../lib/server/admin-diagnostics-routes');
  const h = fakeRouter();
  const fail = () => { throw new Error('/private/path: secret transport failure'); };
  attachAdminDiagnosticsRoutes(proxyDeps({
    adminRouter:h.router,
    getState:() => ({ shares:[], meta:{} }),
    rootDir:ROOT,
    DATA_DIR:ROOT,
    INBOX_DIR:ROOT,
    IMAGE_STORE_DIR:ROOT,
    STORAGE_SETUP:{ inboxUnconfigured:false, imagesUnconfigured:false },
    SEARCH_OCR_LANGS:'eng',
    systemHealthService:{ buildGlobalStorageReport:fail, diskFreeThresholds:fail },
    diagnosticsService:{ diagnosticTcp:fail, diagnosticWritable:fail, tlsCertificateDiagnostics:fail, safeDiagnosticFixFor:fail },
    verifyAuditChain:fail,
    universalSearchStatus:fail,
    detectSearchOcrTools:fail,
    clamavEnabled:fail,
    auditService:{ getKeyMigrationStatus:fail, getActiveKeyMode:fail },
    effectiveWebhook:fail,
    getLastWebhook:fail,
    emailConfigured:fail,
    getLastEmail:fail,
    pushSubs:fail,
    pwaDevices:fail,
    externalTarget:() => ({ host:'example.invalid', port:443, label:'test' }),
    checkPort:fail,
    getSettings:fail,
    normalizeLinkBase:fail,
    auditReq:() => true,
    path,
    fs,
  }));

  const res = response();
  await routeHandler(h.routes, 'POST', '/diagnostics/run')({
    body:{}, query:{}, headers:{}, session:{ role:'admin' }, protocol:'http', secure:false, get:() => 'localhost:3000',
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.checks.find((check) => check.id === 'audit-chain').status, 'bad');
  assert.equal(res.payload.checks.find((check) => check.id === 'public-port').result.error, 'unavailable');
  assert.doesNotMatch(JSON.stringify(res.payload), /private\/path|secret transport failure/);
});

test('push unsubscribe is account-scoped and no longer references an unbound helper', () => {
  const source = read('lib/server/admin-settings-routes.js');
  assert.match(source, /pushSubAccountIds,/);
  const server = read('server.js');
  const center = read('lib/server/notification-center-service.js');
  assert.match(center, /function pushSubAccountIds\(/);
  assert.match(server, /applicationContext\.register\('notification-center', notificationCenterService\)/);
  assert.match(server, /attachAdminSettingsRoutes\(applicationContext\.route\('adminSettings'/);
  const { ROUTE_DEPENDENCIES } = require('../lib/server/application-context');
  assert.ok(ROUTE_DEPENDENCIES.adminSettings.includes('pushSubAccountIds'));
  assert.ok(ROUTE_DEPENDENCIES.adminSettings.includes('pushSubscriptionsForAccountIds'));

  const { attachAdminSettingsRoutes } = require('../lib/server/admin-settings-routes');
  const h = fakeRouter();
  const state = { settings:{}, meta:{ pushSubs:[
    { endpoint:'https://push.example/other', accountId:'other' },
    { endpoint:'https://push.example/mine', accountId:'mine' },
  ] }, history:[], ipNames:{} };
  const audits = [];
  attachAdminSettingsRoutes(proxyDeps({
    adminRouter:h.router,
    getState:() => state,
    pushSubAccountIds:(sub) => sub && sub.accountId ? [String(sub.accountId)] : [],
    pushSubs:() => state.meta.pushSubs,
    persistNow:() => true,
    auditReq:(_req, event) => { audits.push(event); return true; },
  }));

  const handler = routeHandler(h.routes, 'POST', '/push/unsubscribe');
  let res = response();
  handler({ body:{ endpoint:'https://push.example/other' }, session:{ accountId:'mine' }, headers:{} }, res);
  assert.equal(res.payload.removed, false);
  assert.equal(state.meta.pushSubs.length, 2);

  res = response();
  handler({ body:{ endpoint:'https://push.example/mine' }, session:{ accountId:'mine' }, headers:{} }, res);
  assert.equal(res.payload.removed, true);
  assert.deepEqual(state.meta.pushSubs.map((s) => s.endpoint), ['https://push.example/other']);
  assert.ok(audits.includes('push-unsubscribed'));
});

test('admin route composition does not duplicate dashboard dependencies', () => {
  const server = read('server.js');
  const { ROUTE_DEPENDENCIES } = require('../lib/server/application-context');
  assert.match(server, /attachAdminDashboardRoutes\(applicationContext\.route\('adminDashboard'/);
  const deps = ROUTE_DEPENDENCIES.adminDashboard;
  assert.equal(deps.filter((name) => name === 'persistNow').length, 1);
  assert.equal(deps.filter((name) => name === 'pwaAdminHealth').length, 1);
  assert.equal(new Set(deps).size, deps.length);
});
