'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const routes = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'pwa-routes.js'), 'utf8');
const pwaApplication = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'pwa-application.js'), 'utf8');
const finalHttp = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'final-http-application.js'), 'utf8');
const httpComposition = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'http-pwa-lifecycle-application.js'), 'utf8');

test('PWA route composition lives behind an explicit application bootstrap boundary', () => {
  assert.match(server, /require\('\.\/lib\/server\/final-http-application'\)/);
  assert.match(finalHttp, /require\('\.\/http-pwa-lifecycle-application'\)/);
  assert.match(httpComposition, /require\('\.\/pwa-application'\)/);
  assert.match(httpComposition, /createPwaApplication\(\{/);
  assert.match(pwaApplication, /require\('\.\/pwa-routes'\)/);
  assert.match(pwaApplication, /attachPwaRoutes\(\{/);
  assert.match(routes, /function attachPwaRoutes\(composition = \{\}\)/);
  assert.match(routes, /composePwaRouteDependencies\(composition\.services, composition\.facades\)/);
  assert.match(pwaApplication, /const services = Object\.freeze\(\{[\s\S]*?device:pwaDeviceService[\s\S]*?notificationCenter/);
  assert.match(pwaApplication, /attachPwaRoutes\(\{[\s\S]*?services,[\s\S]*?facades:pwaRouteFacades/);
  assert.match(pwaApplication, /facades:pwaRouteFacades/);
  assert.match(routes, /module\.exports = \{ attachPwaRoutes \}/);
});


test('PWA refactor preserves all 106 route registrations', () => {
  const registrations = routes.match(/\bapp\.(?:get|post|delete|put|patch|use|head|options)\s*\(/g) || [];
  assert.equal(registrations.length, 106);

  for (const signature of [
    "app.get('/app/device/claim'",
    "app.post('/app/login'",
    "app.post('/app/webauthn/login/verify'",
    "app.get('/app/notifications'",
    "app.get('/app/images'",
    "app.post('/app/image'",
    "app.get('/app/host/shares'",
    "app.get('/app/trash'",
    "app.get('/app/receptions'",
    "app.post('/app/device/revoke'",
    "app.use('/app', express.static",
  ]) assert.ok(routes.includes(signature), `missing route: ${signature}`);
});

test('mutable server bindings stay live across the PWA application boundary', () => {
  assert.match(server, /live:\{ getState, setState:replaceState, getWebpush:\(\) => platformDependencies\.webpush \}/);
  assert.match(finalHttp, /getSearchIndexBuilding = ownFunction\([\s\S]*?'getSearchIndexBuilding'/);
  assert.match(finalHttp, /getUniversalSearchIndex = ownFunction\([\s\S]*?'getUniversalSearchIndex'/);
  assert.match(finalHttp, /live:\{ getState, setState, getSearchIndexBuilding, getUniversalSearchIndex, getWebpush \}/);

  assert.match(pwaApplication, /get state\(\) \{ return live\.getState\(\); \}/);
  assert.match(pwaApplication, /set state\(value\) \{ live\.setState\(value\); \}/);
  assert.match(pwaApplication, /get searchIndexBuilding\(\) \{ return live\.getSearchIndexBuilding\(\); \}/);
  assert.match(pwaApplication, /get universalSearchIndex\(\) \{ return live\.getUniversalSearchIndex\(\); \}/);
  assert.match(pwaApplication, /get webpush\(\) \{ return live\.getWebpush\(\); \}/);

  assert.match(routes, /live\.state/);
  assert.match(routes, /live\.searchIndexBuilding/);
  assert.match(routes, /live\.universalSearchIndex/);
  assert.match(routes, /live\.webpush/);
});


test('moved PWA static routes resolve files from the application root', () => {
  assert.doesNotMatch(routes, /\b__dirname\b/);
  assert.match(routes, /path\.join\(rootDir, 'pwa'/);
});

test('PWA route module can register the complete surface without executing domain handlers', () => {
  const { attachPwaRoutes } = require('../lib/server/pwa-routes');
  const calls = [];
  const app = {};
  for (const method of ['get', 'post', 'delete', 'put', 'patch', 'use', 'head', 'options']) {
    app[method] = (...args) => { calls.push({ method, first: args[0] }); return app; };
  }
  const stub = () => {};
  const base = {
    app,
    rootDir: ROOT,
    live: { state:{ shares:[], settings:{}, meta:{} }, searchIndexBuilding:false, universalSearchIndex:{ builtAt:0 }, webpush:null },
    path,
    express: { static: () => stub },
  };
  const deps = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return stub;
    },
  });

  attachPwaRoutes(deps);
  assert.equal(calls.length, 106);
  assert.equal(calls[0].method, 'get');
  assert.equal(calls[0].first, '/app/device/claim');
  assert.equal(calls.at(-1).method, 'use');
  assert.equal(calls.at(-1).first, '/app');
});

test('modern PWA composition registers all routes and projects a service method into a public handler', () => {
  const { attachPwaRoutes } = require('../lib/server/pwa-routes');
  const { ROUTE_SERVICE_EXPORTS } = require('../lib/server/pwa-composition-service');
  const calls = [];
  const app = {};
  for (const method of ['get', 'post', 'delete', 'put', 'patch', 'use', 'head', 'options']) {
    app[method] = (...args) => { calls.push({ method, args }); return app; };
  }
  const stub = () => {};
  const services = {};
  for (const [serviceName, names] of Object.entries(ROUTE_SERVICE_EXPORTS)) {
    services[serviceName] = {};
    for (const name of names) services[serviceName][name] = stub;
  }
  services.device.PWA_INSTALL_HEARTBEAT_MAX_AGE_MS = 1;
  services.device.pwaPairTickets = new Map();
  services.event.inboxEventSubs = new Map();
  services.photo.PWA_IMG_EXT = /^(jpg)$/;
  services.webauthn.PASSKEY_MANAGEMENT_FRESH_MS = 1;
  services.webauthn.WEBAUTHN_CHALLENGE_TTL = 1;
  services.webauthn.webauthnLoginChallenges = new Map();
  services.webauthn.webauthnRegChallenges = new Map();
  services.share.shareLogicalBytesCache = new Map();
  services.media.adminPhotoFullWrites = new Set();
  services.notificationCenter.CUSTOM_NOTIFICATION_RULE_METRICS = [];
  services.notificationCenter.NOTIFICATION_MUTABLE_CATEGORIES = [];
  const installAssets = [];
  services.device.sendPwaInstallAsset = (...args) => { installAssets.push(args); };

  attachPwaRoutes({
    app,
    rootDir: ROOT,
    services,
    facades: { runtime:{ path, express:{ static:() => stub } } },
    live: { state:{ shares:[], settings:{}, meta:{} }, searchIndexBuilding:false, universalSearchIndex:{ builtAt:0 }, webpush:null },
  });

  assert.equal(calls.length, 106);
  const manifest = calls.find((call) => call.method === 'get' && call.args[0] === '/direct-xfer-pwa.webmanifest');
  assert.ok(manifest);
  const response = {};
  manifest.args[1]({}, response);
  assert.deepEqual(installAssets, [[response, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8', false]]);
});

test('PWA route factory has no accidental request-local dependency injection', () => {
  const { PWA_ROUTE_FACADE_CONTEXT } = require('../lib/server/pwa-application');
  const facadeNames = new Set(Object.values(PWA_ROUTE_FACADE_CONTEXT).flatMap((group) => Object.keys(group)));
  for (const helper of ['detailedShareStatsPayload','normalizeTags','reqPathList','resolveHostItem','safeReceivedFilePath']) {
    assert.ok(facadeNames.has(helper), `missing declared facade dependency ${helper}`);
  }
  const accidental = [
    'active','activityLog','alreadyRequested','archivedVersion','at','available','before','body','builtAt','bytes',
    'changed','checked','createdAt','daily','dependencyCount','dlpEnabled','duplicate','enabled','error','expired',
    'expiresAt','finalize','hasPassword','hostPath','id','imageBase','indexed','key','maxViews','meta','name','newDest',
    'newSharesNeverExpire','note','ok','oldManagedPaths','origin','patch','persisted','pinned','purgeImpact','receptionBanner',
    'revoked','rollback','rpIdHash','rule','settings','shares','signCount','size','stalled','status','tags','title','token',
    'totals','trashRetentionDays','type','url','value','variants',
  ];
  for (const name of accidental) assert.equal(facadeNames.has(name), false, `request-local ${name} leaked into PWA facade context`);
});

