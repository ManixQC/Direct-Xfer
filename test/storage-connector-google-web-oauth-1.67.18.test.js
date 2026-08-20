'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');
const { CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_ID = '1234567890-directxfer.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-direct-xfer-web-secret';

function harness(options={}) {
  const routes = new Map();
  const adminRouter = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
    delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers.at(-1)); },
  };
  let created = null;
  const service = {
    async capabilities() { return { available:true, version:'rclone v1.75.0' }; },
    async configuredRemotes() { return []; },
    async createGoogleOAuthTokenRemote(remote, credentials, options) {
      created = { remote, credentials, options };
      return { remote, verified:true };
    },
  };
  const profile = {
    get() { return { clientId:CLIENT_ID, clientSecret:CLIENT_SECRET, kind:'web', source:'stored', managed:false }; },
    status() { return { configured:true, clientIdHint:'123…', kind:'web', source:'stored', managed:false }; },
  };
  createStorageConnectorConfigRoutes({
    adminRouter, requireFullAdmin(_req,_res,next){ if(next)next(); }, storageConnectorService:service,
    googleOAuthProfileStore:profile, CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType, crypto,
    isLoopback:()=>false, clientIp:()=> '192.0.2.20', auditReq:()=>{}, logAudit:()=>{}, getAccountById:()=>null, invalidateConnectorProbe:()=>{},
    googleOAuthPublicOrigin:options.googleOAuthPublicOrigin || undefined,
  });
  function req({ body={}, params={}, query={} }={}) {
    return {
      body, params, query, protocol:'https', session:{ accountId:'owner-1', username:'admin' },
      get(name) { return String(name).toLowerCase()==='host' ? 'dx.example.test' : ''; },
    };
  }
  async function call(method, route, request) {
    const handler = routes.get(`${method} ${route}`);
    assert.equal(typeof handler, 'function', `${method} ${route} route missing`);
    let statusCode=200, payload, sent, headers={};
    const res={
      status(code){statusCode=code;return this;},
      json(value){payload=value;return this;},
      send(value){sent=value;return this;},
      setHeader(k,v){headers[k]=v;},
    };
    await handler(request,res);
    return { statusCode, payload, sent, headers };
  }
  return { call, req, getCreated:()=>created };
}

test('1.67.26 Google web OAuth uses Direct-Xfer HTTPS callback instead of localhost copy/paste', async () => {
  const h=harness();
  const started=await h.call('POST','/storage/remotes/google-oauth/start',h.req({body:{remote:'google-drive'}}));
  assert.equal(started.statusCode,201);
  const auth=new URL(started.payload.authUrl);
  assert.equal(auth.origin,'https://accounts.google.com');
  assert.equal(auth.pathname,'/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('redirect_uri'),'https://dx.example.test/api/storage/oauth/google/callback');
  assert.equal(started.payload.callbackUrl,'https://dx.example.test/api/storage/oauth/google/callback');
  assert.equal(auth.searchParams.get('response_type'),'code');
  assert.equal(auth.searchParams.get('access_type'),'offline');
  assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  assert.ok(auth.searchParams.get('state'));
  assert.doesNotMatch(started.payload.authUrl,/127\.0\.0\.1|localhost:53682/i);
});

test('1.67.26 Google web OAuth prefers configured public origin behind a reverse proxy', async () => {
  const h=harness({googleOAuthPublicOrigin:()=> 'https://files.example.test'});
  const request=h.req({body:{remote:'google-drive'}});
  request.protocol='http';
  request.get=(name)=>String(name).toLowerCase()==='host'?'direct-xfer:55750':'';
  const started=await h.call('POST','/storage/remotes/google-oauth/start',request);
  assert.equal(started.statusCode,201);
  const auth=new URL(started.payload.authUrl);
  assert.equal(auth.searchParams.get('redirect_uri'),'https://files.example.test/api/storage/oauth/google/callback');
  assert.equal(started.payload.callbackUrl,'https://files.example.test/api/storage/oauth/google/callback');
});

test('1.67.26 Google callback exchanges code server-side and creates verified rclone remote automatically', async () => {
  const h=harness();
  const started=await h.call('POST','/storage/remotes/google-oauth/start',h.req({body:{remote:'google-drive'}}));
  const auth=new URL(started.payload.authUrl);
  const state=auth.searchParams.get('state');
  const originalFetch=global.fetch;
  let tokenRequest=null;
  global.fetch=async (url, options) => {
    tokenRequest={url:String(url),options};
    return { ok:true, async json(){return {access_token:'access-token',refresh_token:'refresh-token',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'};} };
  };
  try {
    const callback=await h.call('GET','/storage/oauth/google/callback',h.req({query:{state,code:'google-auth-code'}}));
    assert.equal(callback.statusCode,200);
    assert.match(String(callback.sent),/Google Drive connecté/);
    assert.match(String(callback.sent),/google-oauth-complete\.js/);
    assert.equal(tokenRequest.url,'https://oauth2.googleapis.com/token');
    const form=tokenRequest.options.body;
    assert.equal(form.get('code'),'google-auth-code');
    assert.equal(form.get('client_id'),CLIENT_ID);
    assert.equal(form.get('client_secret'),CLIENT_SECRET);
    assert.equal(form.get('redirect_uri'),'https://dx.example.test/api/storage/oauth/google/callback');
    assert.equal(form.get('grant_type'),'authorization_code');
    assert.ok(form.get('code_verifier'));
    const created=h.getCreated();
    assert.equal(created.remote,'google-drive');
    assert.equal(created.credentials.clientId,CLIENT_ID);
    assert.equal(created.credentials.clientSecret,CLIENT_SECRET);
    assert.equal(created.credentials.token.refresh_token,'refresh-token');
    assert.equal(created.options.replace,false);
    const polled=await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:started.payload.id}}));
    assert.equal(polled.payload.status,'completed');
  } finally { global.fetch=originalFetch; }
});

test('1.67.26 Google normal UI no longer asks to paste localhost callback or OAuth JSON', () => {
  const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'public/app.js'),'utf8');
  const callbackJs=fs.readFileSync(path.join(ROOT,'public/google-oauth-complete.js'),'utf8');
  assert.match(html,/id="connector-config-google-callback"/);
  assert.doesNotMatch(html,/id="connector-config-google-json"/);
  assert.match(html,/connector-google-manual" open/);
  assert.match(app,/\/api\/storage\/remotes\/google-oauth\/start/);
  assert.match(app,/\/api\/storage\/oauth\/google-session\//);
  assert.match(app,/Aucun fichier JSON n’est requis/);
  assert.match(callbackJs,/window\.close\(\)/);
  assert.doesNotMatch(callbackJs,/53682|localhost/);
});
