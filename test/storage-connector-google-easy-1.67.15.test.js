'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GoogleOAuthProfileStore } = require('../lib/google-oauth-profile');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');
const { CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_ID = '1234567890-directxfer.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-direct-xfer-test-secret';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dx-google-oauth-')); }

test('1.67.26 Google OAuth profile is stored encrypted once and can be reused', () => {
  const dir = tempDir();
  try {
    const store = new GoogleOAuthProfileStore({ dataDir:dir, env:{} });
    const status = store.save({ clientId:CLIENT_ID, clientSecret:CLIENT_SECRET });
    assert.equal(status.configured, true);
    assert.equal(status.source, 'stored');
    assert.equal(status.managed, false);
    const raw = fs.readFileSync(path.join(dir, 'google-oauth-profile.enc.json'), 'utf8');
    assert.doesNotMatch(raw, /directxfer\.apps\.googleusercontent\.com/);
    assert.doesNotMatch(raw, /GOCSPX-direct-xfer-test-secret/);
    assert.equal(fs.readFileSync(path.join(dir, 'google-oauth-profile.key')).length, 32);
    const loaded = store.get();
    assert.equal(loaded.clientId, CLIENT_ID);
    assert.equal(loaded.clientSecret, CLIENT_SECRET);
    assert.equal(store.clear().configured, false);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('1.67.26 Google Web OAuth profile supports managed Web application environment', () => {
  const dir = tempDir();
  try {
    const store = new GoogleOAuthProfileStore({ dataDir:dir, env:{ DIRECT_XFER_GOOGLE_WEB_CLIENT_ID:CLIENT_ID, DIRECT_XFER_GOOGLE_WEB_CLIENT_SECRET:CLIENT_SECRET } });
    const status = store.status();
    assert.equal(status.configured, true);
    assert.equal(status.source, 'env');
    assert.equal(status.managed, true);
    assert.equal(status.kind, 'web');
    const loaded = store.get();
    assert.equal(loaded.kind, 'web');
    assert.equal(loaded.clientId, CLIENT_ID);
    assert.equal(loaded.clientSecret, CLIENT_SECRET);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('1.67.26 Google OAuth profile supports fully preconfigured server environment', () => {
  const dir = tempDir();
  try {
    const store = new GoogleOAuthProfileStore({ dataDir:dir, env:{ DIRECT_XFER_GOOGLE_OAUTH_CLIENT_ID:CLIENT_ID, DIRECT_XFER_GOOGLE_OAUTH_CLIENT_SECRET:CLIENT_SECRET } });
    const status = store.status();
    assert.equal(status.configured, true);
    assert.equal(status.source, 'env');
    assert.equal(status.managed, true);
    assert.throws(() => store.save({ clientId:CLIENT_ID, clientSecret:CLIENT_SECRET }), /google-oauth-profile-managed/);
    assert.throws(() => store.clear(), /google-oauth-profile-managed/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

function routeHarness(profileStore) {
  const routes = new Map();
  const adminRouter = {
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers.at(-1)); },
  };
  let createOptions = null;
  const service = {
    async capabilities() { return { available:true, version:'rclone test' }; },
    async configuredRemotes() { return []; },
    async configCreateStart(_remote, _type, options) {
      createOptions = options;
      return { done:false, state:'*oauth-islocal,,,', option:{ Name:'config_is_local', Help:'Use browser?', Default:true, Examples:[], Required:false, IsPassword:false, Type:'bool', Exclusive:true }, error:'' };
    },
    async deleteRemote() { return true; },
  };
  createStorageConnectorConfigRoutes({
    adminRouter,
    requireFullAdmin(_req,_res,next){ if(next)next(); },
    storageConnectorService:service,
    googleOAuthProfileStore:profileStore,
    CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType, crypto,
    isLoopback:() => false, clientIp:() => '192.0.2.20', auditReq:() => {}, logAudit:() => {}, getAccountById:() => null, invalidateConnectorProbe:() => {},
  });
  const req=(body={},params={})=>({body,params,session:{accountId:'owner-1'}});
  async function call(method, route, request) {
    const handler=routes.get(`${method} ${route}`); assert.equal(typeof handler,'function');
    let statusCode=200,payload; const headers={};
    const res={status(code){statusCode=code;return this;},json(value){payload=value;return this;},setHeader(k,v){headers[k]=v;}};
    await handler(request,res); return {statusCode,payload,headers};
  }
  return { call, req, getCreateOptions:()=>createOptions };
}

test('1.67.26 Google Drive start automatically reuses the saved OAuth profile', async () => {
  const dir=tempDir();
  try {
    const store=new GoogleOAuthProfileStore({dataDir:dir,env:{}});
    store.save({clientId:CLIENT_ID,clientSecret:CLIENT_SECRET});
    const h=routeHarness(store);
    const profile=await h.call('GET','/storage/oauth/google-profile',h.req());
    assert.equal(profile.statusCode,200);
    assert.equal(profile.payload.configured,true);
    assert.equal(profile.payload.clientSecret,undefined);
    const started=await h.call('POST','/storage/remotes/config/start',h.req({type:'google-drive',remote:'google-drive'}));
    assert.equal(started.statusCode,201);
    assert.equal(h.getCreateOptions().parameters.client_id,CLIENT_ID);
    assert.equal(h.getCreateOptions().parameters.client_secret,CLIENT_SECRET);
    assert.equal(started.payload.parameters,undefined);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('1.67.26 Google Drive standard sign-in requires no JSON, service-account key or callback copy/paste', () => {
  const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'public/app.js'),'utf8');
  const bridge=fs.readFileSync(path.join(ROOT,'public/oauth-bridge.js'),'utf8');
  assert.match(app,/connector\.googleStandardReady/);
  assert.match(app,/connector\.googleAdvancedOptions/);
  assert.doesNotMatch(html,/id="connector-config-google-json"/);
  assert.doesNotMatch(html,/id="connector-config-google-service-json"/);
  assert.doesNotMatch(html,/connector-config-google-service-advanced/);
  assert.match(html,/id="connector-config-google-callback"/);
  assert.match(app,/\/api\/storage\/remotes\/google-oauth\/start/);
  assert.match(app,/\/api\/storage\/oauth\/google-session\//);
  assert.match(app,/\/api\/storage\/oauth\/google-profile/);
  const openBranch=(app.match(/async function openConnectorConfigWizard[\s\S]*?\n}/)||[''])[0];
  assert.doesNotMatch(openBranch,/refreshGoogleOAuthProfileStatus|showGoogleOAuthProfileSetup/);
  assert.match(app,/DIRECT_XFER_OAUTH_BROKER_URL|oauthBroker/);
  assert.match(bridge,/dx-oauth-url/);
  assert.match(bridge,/location\.replace\(parsed\.href\)/);
});
