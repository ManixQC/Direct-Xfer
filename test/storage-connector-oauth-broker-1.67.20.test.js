'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');
const { StorageConnectorService, CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType } = require('../lib/storage-connectors');
const { GoogleOAuthBrokerClient } = require('../lib/google-oauth-broker-client');

function harness() {
  const routes=new Map();
  const adminRouter={
    get(route,...handlers){routes.set(`GET ${route}`,handlers.at(-1));},
    post(route,...handlers){routes.set(`POST ${route}`,handlers.at(-1));},
    delete(route,...handlers){routes.set(`DELETE ${route}`,handlers.at(-1));},
  };
  let created=null, consumed=false, polls=0;
  const broker={
    configured(){return true;},
    async info(){return {available:true,callbackUrl:'https://oauth.example.test/v1/google/callback',version:'1'};},
    async createSession(){return {id:'broker-session-1',pollToken:'p'.repeat(32),authUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=abc',expiresAt:Date.now()+600000};},
    async poll(){polls++; return polls===1?{status:'waiting',error:null,credential:null}:{status:'completed',error:null,credential:{clientId:'dxc_testcredential123',clientSecret:'s'.repeat(32),tokenUrl:'https://oauth.example.test/v1/google/token',token:{access_token:'google-access',refresh_token:'dxr_refreshhandle123',token_type:'Bearer',expiry:new Date(Date.now()+3600000).toISOString()}}};},
    validateCredential(value){return value;},
    async consume(){consumed=true;},
  };
  const service={
    async capabilities(){return {available:true,version:'rclone v1.75.0'};},
    async configuredRemotes(){return [];},
    async createGoogleBrokerRemote(remote,credentials,options){created={remote,credentials,options};return {remote,verified:true};},
  };
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(_q,_s,next){if(next)next();},storageConnectorService:service,googleOAuthProfileStore:null,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.8',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=>''});
  const req=({body={},params={},query={}}={})=>({body,params,query,protocol:'https',session:{accountId:'owner',username:'admin'},get(){return 'dx.example.test';}});
  async function call(method,route,request){const handler=routes.get(`${method} ${route}`);assert.equal(typeof handler,'function');let statusCode=200,payload;const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},send(v){payload=v;return this;},setHeader(){}};await handler(request,res);return {statusCode,payload};}
  return {call,req,getCreated:()=>created,getConsumed:()=>consumed};
}

test('central broker starts Google sign-in without per-instance Google credentials', async()=>{
  const h=harness();
  const started=await h.call('POST','/storage/remotes/google-oauth/start',h.req({body:{remote:'google-drive'}}));
  assert.equal(started.statusCode,201);
  assert.equal(started.payload.broker,true);
  assert.match(started.payload.authUrl,/^https:\/\/accounts\.google\.com\//);
  assert.equal(started.payload.callbackUrl,undefined);
  const first=await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:started.payload.id}}));
  assert.equal(first.payload.status,'waiting');
  const second=await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:started.payload.id}}));
  assert.equal(second.payload.status,'completed');
  const created=h.getCreated();
  assert.equal(created.remote,'google-drive');
  assert.equal(created.credentials.clientId,'dxc_testcredential123');
  assert.equal(created.credentials.tokenUrl,'https://oauth.example.test/v1/google/token');
  assert.equal(created.options.replace,false);
  assert.equal(h.getConsumed(),true);
});

test('Google broker client rejects a token endpoint outside configured broker origin',()=>{
  const client=new GoogleOAuthBrokerClient({baseUrl:'https://oauth.example.test'});
  assert.throws(()=>client.validateCredential({clientId:'dxc_abcdefghijk',clientSecret:'s'.repeat(32),tokenUrl:'https://evil.example/v1/google/token',token:{access_token:'a',refresh_token:'dxr_abcdefgh'}}),/oauth-broker-credential-invalid/);
});

test('rclone broker remote uses central token_url and opaque per-remote credentials',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-broker-rclone-'));
  const service=new StorageConnectorService({bin:'rclone',configPath:path.join(tmp,'rclone.conf')});
  const calls=[];
  service.configuredRemotes=async()=>[];
  service._snapshotFile=async()=>({exists:false,data:null});
  service._restoreFile=async()=>{};
  service.run=async(args)=>{calls.push(args.slice());return {stdout:'',stderr:''};};
  await service.createGoogleBrokerRemote('gdrive',{clientId:'dxc_abcdefghijk',clientSecret:'s'.repeat(32),tokenUrl:'https://oauth.example.test/v1/google/token',token:{access_token:'access',refresh_token:'dxr_abcdefghijk',token_type:'Bearer',expiry:new Date(Date.now()+3600000).toISOString()}});
  const create=calls.find((x)=>x[0]==='config'&&x[1]==='create');
  assert.ok(create);
  assert.deepEqual(create.slice(0,4),['config','create','gdrive','drive']);
  const tokenUrlIndex=create.indexOf('token_url');
  assert.ok(tokenUrlIndex >= 0);
  const configuredTokenUrl=new URL(create[tokenUrlIndex + 1]);
  assert.equal(configuredTokenUrl.protocol,'https:');
  assert.equal(configuredTokenUrl.hostname,'oauth.example.test');
  assert.equal(configuredTokenUrl.port,'');
  assert.equal(configuredTokenUrl.pathname,'/v1/google/token');
  assert.equal(configuredTokenUrl.search,'');
  assert.equal(configuredTokenUrl.hash,'');
  assert.ok(create.includes('dxc_abcdefghijk'));
  assert.ok(create.includes('s'.repeat(32)));
  assert.doesNotMatch(create.join(' '),/googleusercontent\.com|oauth2\.googleapis\.com/);
});

test('standard Google Drive UI no longer gates sign-in on local Google profile setup',()=>{
  const app=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8');
  const openBranch=app.slice(app.indexOf("if(type==='google-drive')"),app.indexOf("connectorConfigSetStatus(t('connector.configStarting'))",app.indexOf("if(type==='google-drive')")));
  assert.match(openBranch,/startGoogleWebOAuth/);
  assert.doesNotMatch(openBranch,/refreshGoogleOAuthProfileStatus|showGoogleOAuthProfileSetup/);
});

test('broker outage transparently falls back to an existing local Google Web profile', async()=>{
  const routes=new Map();
  const adminRouter={get(r,...h){routes.set(`GET ${r}`,h.at(-1));},post(r,...h){routes.set(`POST ${r}`,h.at(-1));},delete(r,...h){routes.set(`DELETE ${r}`,h.at(-1));}};
  const broker={configured(){return true;},async createSession(){throw Object.assign(new Error('down'),{code:'oauth-broker-unreachable'});}};
  const service={async capabilities(){return {available:true};},async configuredRemotes(){return [];}};
  const profile={get(){return {clientId:'123.apps.googleusercontent.com',clientSecret:'secret',kind:'web'};}};
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(_q,_s,next){if(next)next();},storageConnectorService:service,googleOAuthProfileStore:profile,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.8',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=> 'https://dx.example.test'});
  const handler=routes.get('POST /storage/remotes/google-oauth/start');
  let statusCode=200,payload; const req={body:{remote:'gdrive'},protocol:'https',session:{accountId:'owner',username:'admin'},get(){return 'dx.example.test';}};
  const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},setHeader(){}};
  await handler(req,res);
  assert.equal(statusCode,201);
  assert.equal(payload.broker,false);
  assert.match(payload.authUrl,/^https:\/\/accounts\.google\.com\//);
  assert.equal(payload.callbackUrl,'https://dx.example.test/api/storage/oauth/google/callback');
});

test('broker outage advertises rclone-local fallback only for same-host browsers', async()=>{
  const routes=new Map();
  const adminRouter={get(r,...h){routes.set(`GET ${r}`,h.at(-1));},post(r,...h){routes.set(`POST ${r}`,h.at(-1));},delete(r,...h){routes.set(`DELETE ${r}`,h.at(-1));}};
  const broker={configured(){return true;},async createSession(){throw Object.assign(new Error('down'),{code:'oauth-broker-timeout'});}};
  const service={async capabilities(){return {available:true};},async configuredRemotes(){return [];}};
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(_q,_s,next){if(next)next();},storageConnectorService:service,googleOAuthProfileStore:null,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:(ip)=>ip==='127.0.0.1',clientIp:()=> '127.0.0.1',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=> ''});
  const handler=routes.get('POST /storage/remotes/google-oauth/start');
  let statusCode=200,payload; const req={body:{remote:'gdrive'},protocol:'http',session:{accountId:'owner',username:'admin'},get(){return '127.0.0.1:55750';}};
  const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},setHeader(){}};
  await handler(req,res);
  assert.equal(statusCode,202);
  assert.equal(payload.status,'fallback');
  assert.equal(payload.fallback,'rclone-local');
  assert.equal(payload.localBrowserLikely,true);
});

test('standard UI automatically invokes rclone fallback when broker is down on same host',()=>{
  const app=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8');
  assert.match(app,/data&&data\.fallback==='rclone-local'/);
  assert.match(app,/startGoogleRcloneLocalFallback/);
  assert.match(app,/advanceGoogleRcloneLocalFallback/);
  assert.match(app,/\['web','broker','web-fallback','rclone-local'\]\.includes\(googleOAuthProfileState\.kind\)/);
});

test('Google status endpoint reports same-host rclone fallback as ready when broker is down', async()=>{
  const routes=new Map();
  const adminRouter={get(r,...h){routes.set(`GET ${r}`,h.at(-1));},post(r,...h){routes.set(`POST ${r}`,h.at(-1));},delete(r,...h){routes.set(`DELETE ${r}`,h.at(-1));}};
  const broker={configured(){return true;},async info(){throw Object.assign(new Error('down'),{code:'oauth-broker-unreachable'});}};
  const service={async capabilities(){return {available:true};}};
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(_q,_s,next){if(next)next();},storageConnectorService:service,googleOAuthProfileStore:null,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:(ip)=>ip==='127.0.0.1',clientIp:()=> '127.0.0.1',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=> ''});
  const handler=routes.get('GET /storage/oauth/google-web-info');
  let payload; const req={protocol:'http',session:{accountId:'owner',username:'admin'},get(){return '127.0.0.1:55750';}};
  const res={status(){return this;},json(v){payload=v;return this;},setHeader(){}};
  await handler(req,res);
  assert.equal(payload.configured,true);
  assert.equal(payload.kind,'rclone-local');
  assert.equal(payload.localRcloneFallback,true);
  assert.equal(payload.brokerAvailable,false);
});


test('1.67.26 localhost Host header enables rclone fallback even when Docker reports a bridge client IP', async()=>{
  const routes=new Map();
  const adminRouter={get(r,...h){routes.set(`GET ${r}`,h.at(-1));},post(r,...h){routes.set(`POST ${r}`,h.at(-1));},delete(r,...h){routes.set(`DELETE ${r}`,h.at(-1));}};
  const broker={configured(){return true;},async createSession(){throw Object.assign(new Error('down'),{code:'oauth-broker-unreachable'});}};
  const service={async capabilities(){return {available:true};},async configuredRemotes(){return [];}};
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(_q,_s,next){if(next)next();},storageConnectorService:service,googleOAuthProfileStore:null,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '172.17.0.1',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=> ''});
  const handler=routes.get('POST /storage/remotes/google-oauth/start');
  let statusCode=200,payload; const req={body:{remote:'gdrive',localBrowser:true},protocol:'http',session:{accountId:'owner',username:'admin'},get(name){return name==='host'?'localhost:55750':'';}};
  const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},setHeader(){}};
  await handler(req,res);
  assert.equal(statusCode,202);
  assert.equal(payload.status,'fallback');
  assert.equal(payload.fallback,'rclone-local');
  assert.equal(payload.localBrowserLikely,true);
  assert.notEqual(payload.error,'oauth-broker-unreachable');
});

test('1.67.26 UI no longer exposes the old central-broker unavailable blocking message',()=>{
  const app=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8');
  assert.doesNotMatch(app,/Le service OAuth central Direct-Xfer n’est pas disponible\. La connexion Google ne peut pas démarrer\./);
  assert.match(app,/localBrowser/);
});


test('1.67.26 remote browser surfaces the actual broker outage instead of a misleading localhost message', async()=>{
  const routes=new Map();
  const adminRouter={get(r,...h){routes.set(`GET ${r}`,h.at(-1));},post(r,...h){routes.set(`POST ${r}`,h.at(-1));},delete(r,...h){routes.set(`DELETE ${r}`,h.at(-1));}};
  const broker={configured(){return true;},async createSession(){throw Object.assign(new Error('down'),{code:'oauth-broker-unreachable'});}};
  const service={async capabilities(){return {available:true};},async configuredRemotes(){return [];}};
  createStorageConnectorConfigRoutes({adminRouter,requireFullAdmin(_q,_s,next){if(next)next();},storageConnectorService:service,googleOAuthProfileStore:null,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.25',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=> ''});
  const handler=routes.get('POST /storage/remotes/google-oauth/start');
  let statusCode=200,payload; const req={body:{remote:'gdrive',localBrowser:false},protocol:'http',session:{accountId:'owner',username:'admin'},get(name){return name==='host'?'192.168.1.20:55750':'';}};
  const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},setHeader(){}};
  await handler(req,res);
  assert.equal(statusCode,503);
  assert.equal(payload.error,'oauth-broker-unreachable');
  assert.equal(payload.retryable,true);
  assert.equal(payload.fallback,'none');
});

test('1.67.26 Google fallback is a normal response and UI auto-advances rclone defaults',()=>{
  const app=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8');
  assert.match(app,/if\(data&&data\.fallback==='rclone-local'\)/);
  assert.match(app,/async function advanceGoogleRcloneLocalFallback/);
  assert.match(app,/current\.question\.name==='config_is_local'/);
  assert.match(app,/const nonRetryable=data\.error==='google-remote-oauth-required'\|\|data\.retryable===false/);
});
