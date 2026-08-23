'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHttpApplication } = require('../lib/server/http-application');

function expressHarness() {
  const apps = [];
  function express() {
    const app = {
      disabled:[], settings:[], gets:[], uses:[],
      disable(name) { this.disabled.push(name); },
      set(name, value) { this.settings.push([name, value]); },
      get(route, ...handlers) { this.gets.push([route, handlers]); },
      use(...args) { this.uses.push(args); },
    };
    apps.push(app);
    return app;
  }
  express.static = (root, options) => {
    const fn = function staticMiddleware(_req, _res, next) { next(); };
    fn.root = root;
    fn.options = options;
    return fn;
  };
  return { express, apps };
}

function makeService(overrides = {}) {
  const { express, apps } = expressHarness();
  let settings = { adminAllowedIps:'' };
  let localCa = false;
  const requestContext = new AsyncLocalStorage();
  const errors = [];
  const deps = {
    ADMIN_ALLOW_ANY:false,
    ADMIN_ALLOWED_IPS:[],
    TRUST_PROXY:false,
    clientIp:req => req.ip || '203.0.113.9',
    crypto,
    express,
    getSettings:() => settings,
    ipInList:(ip, list) => list.some(entry => entry === ip || entry.ip === ip),
    isLocalNetwork:ip => ip.startsWith('192.168.'),
    isLoopback:ip => ip === '127.0.0.1' || ip === '::1',
    localCaModeActive:() => localCa,
    parseIpList:raw => String(raw).split(',').map(v => v.trim()).filter(Boolean),
    path,
    requestContext,
    rootDir:path.join(__dirname, '..'),
    sendError:(req, res, code, key) => { errors.push([req.path, code, key]); return res.status(code).send(key); },
    ...overrides,
  };
  const service = createHttpApplication(deps);
  return {
    ...service,
    app:apps[0],
    errors,
    requestContext,
    setSettings(value) { settings = value; },
    setLocalCa(value) { localCa = value; },
  };
}

function response() {
  return {
    headers:Object.create(null), statusCode:200, body:undefined, sentFile:null, typeValue:null, headersSent:false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    type(value) { this.typeValue = value; return this; },
    sendFile(value) { this.sentFile = value; return this; },
    destroy() { this.destroyed = true; },
  };
}

test('HTTP application validates security-critical collaborators at startup', () => {
  assert.throws(() => makeService({ sendError:null }), /requires sendError/);
  assert.throws(() => makeService({ clientIp:null }), /requires clientIp/);
  assert.throws(() => makeService({ parseIpList:null }), /requires parseIpList/);
});

test('server delegates common Express security, public assets, SPA routes and HTTP errors', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const mod = fs.readFileSync(path.join(root, 'lib/server/http-application.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/server\/http-application'\)/);
  assert.match(server, /createHttpApplication\(\{/);
  assert.match(server, /attachPublicAssetRoutes\(\)/);
  assert.match(server, /attachAdminSpaAndFallbacks\(\)/);
  assert.doesNotMatch(server, /app\.get\('\/logo\.svg'/);
  assert.doesNotMatch(server, /app\.get\('\/configuration'/);
  assert.doesNotMatch(server, /express\.static\(path\.join\(__dirname, 'public'\)/);
  assert.match(mod, /Content-Security-Policy/);
  assert.match(mod, /function adminGuard/);
  assert.match(mod, /const ADMIN_SPA_ROUTES/);
  assert.match(mod, /const PUBLIC_ASSETS/);
});

test('administrator network policy preserves env, UI, loopback and local-network precedence', () => {
  const env = makeService({ ADMIN_ALLOWED_IPS:['10.0.0.5'] });
  assert.equal(env.isAdminAllowed('10.0.0.5'), true);
  assert.equal(env.isAdminAllowed('127.0.0.1'), true);
  assert.equal(env.isAdminAllowed('192.168.1.10'), false, 'env allowlist must override local-network fallback');

  const ui = makeService();
  ui.setSettings({ adminAllowedIps:'10.1.1.8' });
  assert.equal(ui.isAdminAllowed('10.1.1.8'), true);
  assert.equal(ui.isAdminAllowed('192.168.1.20'), false, 'UI allowlist must override local-network fallback');
  ui.setSettings({ adminAllowedIps:'' });
  assert.equal(ui.isAdminAllowed('192.168.1.20'), true);

  const any = makeService({ ADMIN_ALLOW_ANY:true });
  assert.equal(any.isAdminAllowed('203.0.113.9'), true);
});

test('corrupt restored UI allowlists fail closed instead of silently reopening the LAN', () => {
  const malformed = makeService({ parseIpList:() => [] });
  malformed.setSettings({ adminAllowedIps:'definitely-not-a-cidr' });
  assert.equal(malformed.isAdminAllowed('192.168.1.20'), false);
  assert.equal(malformed.isAdminAllowed('127.0.0.1'), true, 'loopback recovery must remain available');

  const parserFailure = makeService({ parseIpList:() => { throw new Error('corrupt'); } });
  parserFailure.setSettings({ adminAllowedIps:'10.0.0.0/8' });
  assert.equal(parserFailure.isAdminAllowed('192.168.1.20'), false);

  const settingsFailure = makeService({ getSettings:() => { throw new Error('read-failed'); } });
  assert.equal(settingsFailure.isAdminAllowed('192.168.1.20'), false);
  assert.equal(settingsFailure.isAdminAllowed('127.0.0.1'), true);
});

test('admin guard keeps API denials JSON and browser denials on the localized error path', () => {
  const h = makeService();
  let nextCalled = false;
  let res = response();
  h.adminGuard({ path:'/api/settings', ip:'203.0.113.8' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error:'admin-lan-only' });

  res = response();
  h.adminGuard({ path:'/configuration', ip:'203.0.113.8' }, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'adminLanOnly');
  assert.deepEqual(h.errors.at(-1), ['/configuration', 403, 'adminLanOnly']);

  // Express strips /api from req.path while an app.use('/api', ...) layer is
  // executing. The guard must use baseUrl/originalUrl too or clients receive HTML.
  res = response();
  h.adminGuard({ path:'/settings', baseUrl:'/api', originalUrl:'/api/settings?x=1', ip:'203.0.113.8' }, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error:'admin-lan-only' });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.pragma, 'no-cache');

  res = response();
  h.adminGuard({ path:'/', baseUrl:'/api', originalUrl:'/api', ip:'203.0.113.8' }, res, () => {});
  assert.deepEqual(res.body, { error:'admin-lan-only' }, 'exact mounted /api must keep the JSON contract');

  res = response();
  h.adminGuard({ path:'/settings', baseUrl:'/API', originalUrl:'/API/settings', ip:'203.0.113.8' }, res, () => {});
  assert.deepEqual(res.body, { error:'admin-lan-only' }, 'API classification must mirror Express case-insensitive routing');

  res = response();
  h.adminGuard({ path:'/apiary', originalUrl:'/apiary', ip:'203.0.113.8' }, res, () => {});
  assert.equal(res.body, 'adminLanOnly', 'lookalike paths must not be classified as API');
});

test('security middleware shares a request-local nonce with rendering and preserves HSTS local-CA behavior', () => {
  const h = makeService();
  const security = h.app.uses[0][0];
  const res = response();
  let store = null;
  security({ secure:true }, res, () => { store = h.requestContext.getStore(); });
  assert.ok(store && /^[A-Za-z0-9+/]+=*$/.test(store.cspNonce));
  assert.match(res.headers['content-security-policy'], new RegExp(`nonce-${store.cspNonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');

  h.setLocalCa(true);
  const local = response();
  security({ secure:true }, local, () => {});
  assert.equal(local.headers['strict-transport-security'], 'max-age=0');

  const plain = response();
  security({ secure:false }, plain, () => {});
  assert.equal(plain.headers['strict-transport-security'], undefined);
});

test('public assets keep their public placement, content types and cache policy', () => {
  const h = makeService();
  h.attachPublicAssetRoutes();
  h.attachPublicAssetRoutes();
  assert.equal(h.app.gets.length, 9, 'registration must be idempotent');
  const logo = h.app.gets.find(([route]) => route === '/logo.svg')[1][0];
  let res = response();
  logo({}, res);
  assert.equal(res.typeValue, 'image/svg+xml');
  assert.equal(res.headers['cache-control'], 'public, max-age=3600');
  assert.equal(res.sentFile, path.join(__dirname, '..', 'public', 'logo.svg'));

  const pow = h.app.gets.find(([route]) => route === '/dxpow.js')[1][0];
  res = response();
  pow({}, res);
  assert.equal(res.typeValue, 'text/javascript');
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('admin SPA/static and terminal 404/error boundaries are attached last and only once', () => {
  const h = makeService();
  h.attachAdminSpaAndFallbacks();
  const getsAfterFirst = h.app.gets.length;
  const usesAfterFirst = h.app.uses.length;
  h.attachAdminSpaAndFallbacks();
  assert.equal(h.app.gets.length, getsAfterFirst);
  assert.equal(h.app.uses.length, usesAfterFirst);
  for (const route of ['/configuration','/notifications','/images','/activity','/dashboards','/system-health']) {
    const found = h.app.gets.find(([value]) => value === route);
    assert.ok(found, route);
    assert.equal(found[1][0], h.adminGuard);
  }
  const staticIndex = h.app.uses.findIndex(args => args[0] === h.adminGuard && args[1] && args[1].options);
  assert.ok(staticIndex > 0);
  const staticEntry = h.app.uses[staticIndex];
  assert.equal(staticEntry[1].options.index, 'index.html');
  assert.deepEqual(staticEntry[1].options.extensions, ['html']);
  assert.equal(staticEntry[1].options.dotfiles, 'ignore');

  const apiNotFound = h.app.uses[staticIndex - 1][0];
  let nextCalled = false;
  let res = response();
  apiNotFound({ path:'/api/missing', originalUrl:'/api/missing' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error:'not-found' });
  assert.equal(res.headers['cache-control'], 'no-store');
  res = response();
  apiNotFound({ path:'/API', originalUrl:'/API' }, res, () => {});
  assert.deepEqual(res.body, { error:'not-found' }, 'exact/case-insensitive API misses must be JSON before static files');
  res = response();
  apiNotFound({ path:'/missing', originalUrl:'/missing' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'non-API paths must continue to the admin static surface');

  const notFound = h.app.uses.at(-2)[0];
  res = response();
  notFound({ path:'/missing', originalUrl:'/missing' }, res);
  assert.equal(res.body, 'pageNotFound');
  assert.equal(res.headers['cache-control'], 'no-store');

  const onError = h.app.uses.at(-1)[0];
  res = response();
  onError({ type:'entity.too.large' }, {}, res, () => {});
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, { error:'payload-too-large' });
  assert.equal(res.headers['cache-control'], 'no-store');

  res = response();
  onError({ type:'entity.parse.failed' }, {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error:'invalid-json' });

  res = response();
  onError({ type:'encoding.unsupported' }, {}, res, () => {});
  assert.equal(res.statusCode, 415);
  assert.deepEqual(res.body, { error:'unsupported-encoding' });

  res = response();
  onError({ type:'request.aborted' }, {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error:'bad-request' });

  let forwarded = null;
  res = response();
  res.headersSent = true;
  delete res.destroy;
  const streamErr = new Error('stream');
  onError(streamErr, {}, res, err => { forwarded = err; });
  assert.equal(forwarded, streamErr, 'streaming errors without destroy must delegate to Express');
});
