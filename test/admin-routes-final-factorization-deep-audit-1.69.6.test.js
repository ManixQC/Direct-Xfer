'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function fakeRouter() {
  const routes = [];
  const router = { use() { return router; } };
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

function routeHandler(routes, method, route) {
  const row = routes.find((r) => r.method === method && r.route === route);
  assert.ok(row, `${method} ${route} registered`);
  return row.handlers.at(-1);
}

function settingsHarness(initialState = null) {
  const state = initialState || { settings:{}, meta:{}, history:[], ipNames:{} };
  const h = fakeRouter();
  const noop = () => {};
  const base = {
    adminRouter:h.router,
    getState:() => state,
    pushSubAccountIds:() => [],
    crypto,
    persistNow:() => true,
    auditReq:noop,
  };
  const deps = new Proxy(base, { get(target, prop) { return prop in target ? target[prop] : noop; } });
  require('../lib/server/admin-settings-routes').attachAdminSettingsRoutes(deps);
  return { state, ...h };
}

function settingsCommitHarness({ failCommit = false } = {}) {
  const state = {
    settings:{ historyRetentionDays:0, anonymizeIps:false, keepIpNames:true },
    meta:{},
    history:[{ id:'old' }, { id:'fresh' }],
    ipNames:{},
  };
  const h = fakeRouter();
  const events = [];
  let historyViewRevision = 0;
  const noop = () => {};
  const base = {
    adminRouter:h.router,
    getState:() => state,
    pushSubAccountIds:() => [],
    computeSettingsPatch:(body) => ({ patch:{ ...body } }),
    getSettings:() => ({ ...state.settings }),
    settingsForClient:() => ({ ...state.settings }),
    setSettingsDurable:(patch, options = {}) => {
      const previous = state.settings;
      state.settings = { ...previous, ...patch };
      events.push(`applied:${state.settings.historyRetentionDays}`);
      try {
        if (typeof options.beforePersist === 'function') options.beforePersist();
        events.push(`persisted:${state.history.map((entry) => entry.id).join(',')}`);
        if (!failCommit) return { ...state.settings };
      } finally {
        if (failCommit) state.settings = previous;
      }
      return null;
    },
    pruneHistory:() => {
      events.push(`pruned:${state.settings.historyRetentionDays}`);
      state.history = state.history.filter((entry) => entry.id === 'fresh');
    },
    bumpHistoryViewRevision:() => { historyViewRevision += 1; },
    recordUndoable:() => ({ id:'undo-1' }),
    rollbackRecordedUndo:() => { events.push('undo-rolled-back'); },
    addCenterNotification:noop,
    auditReq:noop,
  };
  const deps = new Proxy(base, { get(target, prop) { return prop in target ? target[prop] : noop; } });
  require('../lib/server/admin-settings-routes').attachAdminSettingsRoutes(deps);
  return { state, events, get historyViewRevision() { return historyViewRevision; }, ...h };
}

function loadInternalHelpers(rel, names) {
  const module = { exports:{} };
  const source = read(rel) + `\nmodule.exports.__auditHelpers = { ${names.join(', ')} };\n`;
  vm.runInNewContext(source, { module, exports:module.exports, Buffer, Number, Math, Set, Object, Array, String, JSON, Date, RegExp }, { filename:rel });
  return module.exports.__auditHelpers;
}

test('preset sanitizer enforces its limit in UTF-8 bytes and rejects prototype-control keys', () => {
  const h = settingsHarness();
  const save = routeHandler(h.routes, 'POST', '/presets');

  let res = response();
  save({ body:{ name:'bad-proto', type:'inbox', config:JSON.parse('{"__proto__":"pollute"}') }, session:{ accountId:'acc-1' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'invalid-config');

  const multibyte = {};
  for (let i = 0; i < 6; i += 1) multibyte[`k${i}`] = '😀'.repeat(400);
  res = response();
  save({ body:{ name:'too-large', type:'inbox', config:multibyte }, session:{ accountId:'acc-1' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'invalid-config');

  res = response();
  save({ body:{ name:'normal', type:'inbox', config:{ expiry:'3600', moderated:true } }, session:{ accountId:'acc-1' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(h.state.meta.linkPresets.length, 1);
  assert.deepEqual(h.state.meta.linkPresets[0].config, { expiry:'3600', moderated:true });
});

test('legacy preset output is sanitized before it reaches the admin client', () => {
  const legacyConfig = JSON.parse('{"safe":"ok","__proto__":"bad","nested":{"x":1}}');
  const h = settingsHarness({
    settings:{}, history:[], ipNames:{},
    meta:{ linkPresets:[{ id:'p1', accountId:'acc-1', name:'Legacy', type:'inbox', config:legacyConfig, createdAt:1 }] },
  });
  const list = routeHandler(h.routes, 'GET', '/presets');
  const res = response();
  list({ query:{ type:'inbox' }, session:{ accountId:'acc-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.presets[0].config, { safe:'ok' });
});

test('settings saves apply retention before pruning and commit both through settings-service', () => {
  const h = settingsCommitHarness();
  const save = routeHandler(h.routes, 'POST', '/settings');
  const res = response();
  save({ body:{ historyRetentionDays:7 }, session:{ accountId:'acc-1', role:'admin' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.persisted, true);
  assert.equal(h.state.settings.historyRetentionDays, 7);
  assert.deepEqual(h.state.history, [{ id:'fresh' }]);
  assert.deepEqual(h.events.slice(0, 3), ['applied:7', 'pruned:7', 'persisted:fresh']);
});

test('failed settings saves restore route-owned history after a transactional prune', () => {
  const h = settingsCommitHarness({ failCommit:true });
  const save = routeHandler(h.routes, 'POST', '/settings');
  const res = response();
  save({ body:{ historyRetentionDays:30 }, session:{ accountId:'acc-1', role:'admin' } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.persisted, false);
  assert.equal(h.state.settings.historyRetentionDays, 0);
  assert.deepEqual(h.state.history, [{ id:'old' }, { id:'fresh' }]);
  assert.ok(h.events.includes('undo-rolled-back'));
});

test('settings import uses the durable boundary and refreshes privacy-derived history views', () => {
  const h = settingsCommitHarness();
  const importSettings = routeHandler(h.routes, 'POST', '/settings/import');
  const res = response();
  importSettings({ body:{ settings:{ anonymizeIps:true } }, session:{ accountId:'acc-1', role:'admin' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.persisted, true);
  assert.equal(res.payload.imported, 1);
  assert.equal(h.state.settings.anonymizeIps, true);
  assert.equal(h.historyViewRevision, 1);
});

test('dashboard composition fails closed when the PWA health routes cannot attach', () => {
  const { attachAdminDashboardRoutes } = require('../lib/server/admin-dashboard-routes');
  const h = fakeRouter();
  const noop = () => {};
  const state = { stats:{}, activityLog:[], audit:[], history:[] };
  const systemHealthService = {
    FILE_CATEGORY_ORDER:[],
    buildGlobalStorageReport:noop,
    diskFreeThresholds:noop,
    fileCategoryOf:noop,
    scanReceptionStorage:noop,
    serverHealthDeepSnapshot:noop,
    serverHealthJobSummary:noop,
    serverHealthShareSummary:noop,
    serverHealthReceptionVolume:noop,
  };
  const makeDeps = (health) => new Proxy({ adminRouter:h.router, getState:() => state, pwaAdminHealth:health, systemHealthService }, {
    get(target, prop) { return prop in target ? target[prop] : noop; },
  });

  assert.throws(() => attachAdminDashboardRoutes(makeDeps({
    healthPayload:() => ({}), recordHealthHistory:noop, bucketHealthHistory:() => ({ points:[] }),
  })), /complete pwaAdminHealth service/);

  assert.throws(() => attachAdminDashboardRoutes(makeDeps({
    healthPayload:() => ({}), recordHealthHistory:noop, bucketHealthHistory:() => ({ points:[] }), attachHealthRoute:() => false,
  })), /could not attach PWA health routes/);
});

test('dashboard and photo comparison helpers never emit NaN or Infinity from corrupt metrics', () => {
  const dash = loadInternalHelpers('lib/server/admin-dashboard-routes.js', ['dashboardDelta', 'finalizeTransferPeriodMetrics', 'buildTransferComparison']);
  const photo = loadInternalHelpers('lib/server/admin-photo-routes.js', ['dashboardDelta', 'buildImageComparison']);

  const finalized = dash.finalizeTransferPeriodMetrics({
    transfers:10, completed:Infinity, interrupted:NaN, bytes:Infinity,
    up:-5, down:4, durationMs:Infinity, throughputBytes:Infinity,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(finalized)), {
    transfers:10, completed:0, interrupted:0, bytes:0, up:0, down:4,
    successRate:0, avgBps:0,
  });
  for (const value of Object.values(finalized)) assert.ok(Number.isFinite(value));

  const delta = dash.dashboardDelta(Infinity, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(delta)), { delta:-5, pct:-100 });
  const image = photo.buildImageComparison(7, { images:Infinity, bytes:NaN, avgSize:10 }, { images:2, bytes:5, avgSize:Infinity });
  assert.equal(image.changes.images.delta, -2);
  assert.equal(image.changes.bytes.delta, -5);
  assert.equal(image.changes.avgSize.delta, 10);
  for (const change of Object.values(image.changes)) {
    assert.ok(Number.isFinite(change.delta));
    assert.ok(change.pct === null || Number.isFinite(change.pct));
  }
});
