'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');
const { CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHarness() {
  const routes = new Map();
  const adminRouter = {
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers.at(-1)); },
  };
  const oauthAttempts = [], authorizeArgsSeen = [], createOptionsSeen = [];
  let createCalls = 0, deleteCalls = 0, cancelCalls = 0;
  const question = () => ({
    done:false,
    state:'*oauth-islocal,,,',
    option:{ Name:'config_is_local', Help:'Use browser?', Default:true, Examples:[], Required:false, IsPassword:false, Type:'bool', Exclusive:true },
    error:'',
  });
  const service = {
    async capabilities() { return { available:true, version:'rclone test' }; },
    async configCreateStart(_remote, _type, options = {}) { createCalls++; createOptionsSeen.push(options); return question(); },
    async configContinue() { throw Object.assign(new Error('not-used'), { code:'not-used' }); },
    async configContinueToQuestion(_remote, state, answer) {
      if (state === '*oauth-token,,,' && answer) return { done:true, state:'', option:null, error:'' };
      throw Object.assign(new Error('not-used'), { code:'not-used' });
    },
    async prepareOAuthAuthorization() {
      return {
        question:{ done:false, state:'*oauth-token,,,', option:{ Name:'config_token', Help:'private', Type:'string' }, error:'' },
        authorizeArgs:['drive','eyJjbGllbnRfaWQiOiJ0ZXN0In0='],
      };
    },
    async deleteRemote() { deleteCalls++; return true; },
    startOAuthAuthorization(_type, options = {}) {
      authorizeArgsSeen.push(options.authorizeArgs);
      const d = deferred(); oauthAttempts.push(d);
      return { promise:d.promise, cancel() { cancelCalls++; }, acceptCallback:async () => ({ ok:true }) };
    },
  };
  createStorageConnectorConfigRoutes({
    adminRouter,
    requireFullAdmin(_req, _res, next) { if (next) next(); },
    storageConnectorService:service,
    CONNECTOR_TYPES,
    OAUTH_CONNECTOR_TYPES,
    connectorBackendType,
    crypto,
    isLoopback:() => false,
    clientIp:() => '192.0.2.10',
    auditReq:() => {},
    logAudit:() => {},
    getAccountById:() => null,
    invalidateConnectorProbe:() => {},
  });
  const req = (body = {}, params = {}) => ({ body, params, session:{ accountId:'owner-1', username:'admin' } });
  async function call(method, route, request) {
    const handler = routes.get(`${method} ${route}`);
    assert.equal(typeof handler, 'function', `${method} ${route} should be registered`);
    let statusCode = 200, payload;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    };
    await handler(request, res);
    return { statusCode, payload };
  }
  return {
    call, req, oauthAttempts, authorizeArgsSeen, createOptionsSeen,
    stats:() => ({ createCalls, deleteCalls, cancelCalls }),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('1.67.26 failed OAuth sessions can be retried and the incomplete remote is recreated', async () => {
  const h = makeHarness();
  const started = await h.call('POST', '/storage/remotes/config/start', h.req({ type:'google-drive', remote:'mydrive', oauthConfig:{clientId:'123456-test.apps.googleusercontent.com',clientSecret:'GOCSPX-test-secret'} }));
  assert.equal(started.statusCode, 201);
  assert.equal(started.payload.parameters, undefined);
  assert.equal(h.createOptionsSeen[0].parameters.client_id, '123456-test.apps.googleusercontent.com');
  assert.equal(h.createOptionsSeen[0].parameters.client_secret, 'GOCSPX-test-secret');
  const id = started.payload.id;

  const oauth = await h.call('POST', '/storage/remotes/config/:id/oauth', h.req({}, { id }));
  assert.equal(oauth.statusCode, 202);
  assert.equal(oauth.payload.status, 'oauth-starting');
  assert.equal(h.oauthAttempts.length, 1);
  assert.deepEqual(h.authorizeArgsSeen[0], ['drive','eyJjbGllbnRfaWQiOiJ0ZXN0In0=']);

  const failure = Object.assign(new Error('cancelled'), { code:'oauth-failed' });
  h.oauthAttempts[0].reject(failure);
  await tick(); await tick();

  const failed = await h.call('GET', '/storage/remotes/config/:id', h.req({}, { id }));
  assert.equal(failed.payload.status, 'error');
  assert.equal(failed.payload.error, 'oauth-failed');

  const retried = await h.call('POST', '/storage/remotes/config/:id/retry', h.req({}, { id }));
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.payload.status, 'question');
  assert.equal(retried.payload.question.name, 'config_is_local');
  assert.deepEqual(h.stats(), { createCalls:2, deleteCalls:1, cancelCalls:0 });
  assert.deepEqual(h.createOptionsSeen[1].parameters, h.createOptionsSeen[0].parameters);
});

test('1.67.26 retry invalidates a still-running OAuth attempt so stale rejection cannot re-break the session', async () => {
  const h = makeHarness();
  const started = await h.call('POST', '/storage/remotes/config/start', h.req({ type:'google-drive', remote:'mydrive', oauthConfig:{clientId:'123456-test.apps.googleusercontent.com',clientSecret:'GOCSPX-test-secret'} }));
  const id = started.payload.id;
  await h.call('POST', '/storage/remotes/config/:id/oauth', h.req({}, { id }));
  assert.equal(h.oauthAttempts.length, 1);

  const retried = await h.call('POST', '/storage/remotes/config/:id/retry', h.req({}, { id }));
  assert.equal(retried.payload.status, 'question');
  assert.equal(h.stats().cancelCalls, 1);

  h.oauthAttempts[0].reject(Object.assign(new Error('old failure'), { code:'oauth-failed' }));
  await tick(); await tick();
  const current = await h.call('GET', '/storage/remotes/config/:id', h.req({}, { id }));
  assert.equal(current.payload.status, 'question');
  assert.equal(current.payload.error, null);
});

test('1.67.26 successful OAuth uses the prepared config-token state and completes without replaying config_is_local', async () => {
  const h = makeHarness();
  const started = await h.call('POST', '/storage/remotes/config/start', h.req({ type:'google-drive', remote:'mydrive', oauthConfig:{clientId:'123456-test.apps.googleusercontent.com',clientSecret:'GOCSPX-test-secret'} }));
  const id = started.payload.id;
  const oauth = await h.call('POST', '/storage/remotes/config/:id/oauth', h.req({}, { id }));
  assert.equal(oauth.statusCode, 202);
  assert.deepEqual(h.authorizeArgsSeen[0], ['drive','eyJjbGllbnRfaWQiOiJ0ZXN0In0=']);

  h.oauthAttempts[0].resolve({ token:'encoded-token-result' });
  await tick(); await tick();

  const completed = await h.call('GET', '/storage/remotes/config/:id', h.req({}, { id }));
  assert.equal(completed.payload.status, 'completed');
  assert.equal(completed.payload.error, null);
});

test('1.67.26 Google Drive normal sign-in starts without JSON or explicit OAuth credentials', async () => {
  const h = makeHarness();
  const started = await h.call('POST', '/storage/remotes/config/start', h.req({ type:'google-drive', remote:'mydrive' }));
  assert.equal(started.statusCode, 201);
  assert.equal(started.payload.type, 'google-drive');
  assert.equal(h.stats().createCalls, 1);
  assert.equal(h.stats().deleteCalls, 0);
});

test('1.67.26 an existing remote can only be replaced after an explicit replace request', async () => {
  const h = makeHarness();
  const started = await h.call('POST', '/storage/remotes/config/start', h.req({ type:'google-drive', remote:'legacy-drive', replace:true, oauthConfig:{clientId:'123456-test.apps.googleusercontent.com',clientSecret:'GOCSPX-test-secret'} }));
  assert.equal(started.statusCode, 201);
  assert.equal(h.stats().deleteCalls, 1);
  assert.equal(h.stats().createCalls, 1);
});

test('1.67.26 connector UI exposes recovery controls and one-click remote-browser OAuth helpers', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const routeModule = fs.readFileSync(path.join(ROOT, 'lib/server/storage-connector-config.js'), 'utf8');
  assert.match(html, /id="connector-config-retry"/);
  assert.match(html, /id="connector-config-replace"/);
  assert.match(html, /connector\.callbackPasteFinish/);
  assert.match(html, /connector-config-advanced/);
  assert.match(app, /connectorConfigSuggestedRemote/);
  assert.match(app, /oauth-bridge\.html/);
  assert.doesNotMatch(app, /about:blank/);
  assert.doesNotMatch(app, /startConnectorLocalOAuth\(true\)/);
  assert.match(app, /await submitConnectorOAuthCallback\(value\)/);
  assert.match(app, /status:'remote-exists'/);
  assert.match(app, /client_id_warning/);
  assert.match(app, /connector\.googleUseOwnClient/);
  assert.match(app, /rclone\.org\/drive\/#making-your-own-client-id/);
  assert.match(routeModule, /\/storage\/remotes\/config\/:id\/retry/);
  assert.match(routeModule, /oauthAttempt !== oauthAttempt/);
  assert.match(routeModule, /req\.body && req\.body\.replace === true/);
});
